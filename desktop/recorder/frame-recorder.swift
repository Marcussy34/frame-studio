// Frame Studio capture helper.
//
// Captures the screen with the cursor EXCLUDED from the pixels, while logging cursor
// position and clicks separately, so the cursor can be redrawn in post with smoothing,
// motion blur and click effects.
//
// Protocol: newline delimited JSON. Commands arrive on stdin, events go to stdout.
//
// Two hard-won constraints, both verified the slow way:
//   1. NSEvent.addGlobalMonitorForEvents delivers NOTHING in a non-GUI CLI helper,
//      even with every permission granted. CGEventTap is the only thing that works.
//   2. An event tap delivers through the run loop, so the run loop must actually run.
//      Sleeping instead leaves it idle and silently yields zero events.

import AppKit
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
        let line = String(data: data, encoding: .utf8)
    else { return }
    print(line)
    fflush(stdout)
}

func emitError(_ message: String) {
    emit(["event": "error", "message": message])
}

// SCDisplay does not carry the backing scale factor, so it is read from the matching
// NSScreen. Recording it per bundle avoids hardcoding 2x, which is wrong on
// non-retina and mixed-display setups.
func screenFor(displayID: CGDirectDisplayID) -> NSScreen? {
    NSScreen.screens.first {
        ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID)
            == displayID
    }
}

func scaleFor(displayID: CGDirectDisplayID) -> Double {
    Double(screenFor(displayID: displayID)?.backingScaleFactor ?? 2.0)
}

func nameFor(displayID: CGDirectDisplayID) -> String {
    screenFor(displayID: displayID)?.localizedName ?? "Display \(displayID)"
}

// MARK: - cursor track

struct Sample: Codable {
    let t: Double
    let x: Double
    let y: Double
    let e: String
    let b: Int
}

// A CGEventTap callback is a C function pointer and cannot capture context, so the
// recorder has to be reachable through a global.
var globalRecorder: CursorRecorder?

final class CursorRecorder: @unchecked Sendable {
    private var samples: [Sample] = []
    private let lock = NSLock()
    private var t0: CFAbsoluteTime = 0
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private(set) var installed = false

    var startedAt: CFAbsoluteTime { t0 }

    func start() {
        t0 = CFAbsoluteTimeGetCurrent()
        let mask: CGEventMask =
            (1 << CGEventType.mouseMoved.rawValue)
            | (1 << CGEventType.leftMouseDragged.rawValue)
            | (1 << CGEventType.rightMouseDragged.rawValue)
            | (1 << CGEventType.otherMouseDragged.rawValue)
            | (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.leftMouseUp.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue)
            | (1 << CGEventType.rightMouseUp.rawValue)
            | (1 << CGEventType.otherMouseDown.rawValue)
            | (1 << CGEventType.otherMouseUp.rawValue)

        let callback: CGEventTapCallBack = { _, type, event, _ in
            guard let recorder = globalRecorder else { return Unmanaged.passUnretained(event) }
            // CGEvent.location is already top-left origin. Do not flip it.
            let point = event.location
            switch type {
            case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
                recorder.append(
                    Sample(t: recorder.now(), x: point.x, y: point.y, e: "m", b: -1))
            case .leftMouseDown:
                recorder.append(Sample(t: recorder.now(), x: point.x, y: point.y, e: "d", b: 0))
            case .leftMouseUp:
                recorder.append(Sample(t: recorder.now(), x: point.x, y: point.y, e: "u", b: 0))
            case .rightMouseDown:
                recorder.append(Sample(t: recorder.now(), x: point.x, y: point.y, e: "d", b: 1))
            case .rightMouseUp:
                recorder.append(Sample(t: recorder.now(), x: point.x, y: point.y, e: "u", b: 1))
            case .otherMouseDown:
                recorder.append(Sample(t: recorder.now(), x: point.x, y: point.y, e: "d", b: 2))
            case .otherMouseUp:
                recorder.append(Sample(t: recorder.now(), x: point.x, y: point.y, e: "u", b: 2))
            default:
                break
            }
            return Unmanaged.passUnretained(event)
        }

        guard
            let created = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .listenOnly,
                eventsOfInterest: mask,
                callback: callback,
                userInfo: nil)
        else { return }
        tap = created
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: created, enable: true)
        installed = true
    }

    fileprivate func now() -> Double { CFAbsoluteTimeGetCurrent() - t0 }

    fileprivate func append(_ sample: Sample) {
        lock.lock()
        samples.append(sample)
        lock.unlock()
    }

    func stop() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
    }

    func write(to path: String) throws -> (count: Int, clicks: Int) {
        lock.lock()
        let snapshot = samples.sorted { $0.t < $1.t }
        lock.unlock()
        let encoder = JSONEncoder()
        var data = Data()
        for sample in snapshot {
            data.append(try encoder.encode(sample))
            data.append(0x0A)
        }
        try data.write(to: URL(fileURLWithPath: path))
        return (snapshot.count, snapshot.filter { $0.e == "d" }.count)
    }
}

// MARK: - stream plumbing

final class Interruption: @unchecked Sendable {
    private var value: String?
    private let lock = NSLock()
    var reason: String? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
    func set(_ message: String) {
        lock.lock()
        value = message
        lock.unlock()
    }
}

final class StreamDelegate: NSObject, SCStreamDelegate {
    let interruption: Interruption
    init(interruption: Interruption) { self.interruption = interruption }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // Most commonly a display was unplugged or reconfigured. Record the reason so
        // the partial recording is finalised rather than abandoned half written.
        interruption.set(error.localizedDescription)
    }
}

final class RecDelegate: NSObject, SCRecordingOutputDelegate {
    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {}
    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        emitError("recording output failed: \(error.localizedDescription)")
    }
    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {}
}

// ScreenCaptureKit wants a stream output attached. It also hands us the wall clock time
// of the first real frame, which is how videoStartOffset is measured rather than assumed.
final class SinkOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var first: CFAbsoluteTime?

    var frames: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
    var firstFrameAt: CFAbsoluteTime? {
        lock.lock()
        defer { lock.unlock() }
        return first
    }

    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen, sampleBuffer.imageBuffer != nil else { return }
        lock.lock()
        if first == nil { first = CFAbsoluteTimeGetCurrent() }
        count += 1
        lock.unlock()
    }
}

// MARK: - recording session

final class RecordingSession {
    let stream: SCStream
    let sink: SinkOutput
    let recorder: CursorRecorder
    let interruption: Interruption
    let outDir: String
    let scale: Double
    let pointsWidth: Int
    let pointsHeight: Int
    let kind: String
    let title: String
    // Sampled window position. Cursor events are global, so a window that moves during
    // a recording needs its origin tracked or the redrawn cursor drifts away from it.
    let window: SCWindow?
    var frames: [[String: Any]] = []
    private var lastSampled: CGRect = .null

    init(
        stream: SCStream, sink: SinkOutput, recorder: CursorRecorder,
        interruption: Interruption, outDir: String, scale: Double,
        pointsWidth: Int, pointsHeight: Int, kind: String, title: String,
        window: SCWindow?, origin: CGRect
    ) {
        self.stream = stream
        self.sink = sink
        self.recorder = recorder
        self.interruption = interruption
        self.outDir = outDir
        self.scale = scale
        self.pointsWidth = pointsWidth
        self.pointsHeight = pointsHeight
        self.kind = kind
        self.title = title
        self.window = window
        self.lastSampled = origin
        self.frames = [
            ["t": 0.0, "x": origin.origin.x, "y": origin.origin.y,
             "w": origin.width, "h": origin.height]
        ]
    }

    // Only records a sample when the frame actually moved, so a window left alone
    // costs a single entry rather than thousands.
    func sampleWindowFrame() async {
        guard kind == "window", let window else { return }
        guard
            let content = try? await SCShareableContent.excludingDesktopWindows(
                true, onScreenWindowsOnly: false),
            let live = content.windows.first(where: { $0.windowID == window.windowID })
        else { return }
        let frame = live.frame
        if abs(frame.origin.x - lastSampled.origin.x) < 1
            && abs(frame.origin.y - lastSampled.origin.y) < 1
            && abs(frame.width - lastSampled.width) < 1
            && abs(frame.height - lastSampled.height) < 1
        {
            return
        }
        lastSampled = frame
        frames.append([
            "t": CFAbsoluteTimeGetCurrent() - recorder.startedAt,
            "x": frame.origin.x, "y": frame.origin.y,
            "w": frame.width, "h": frame.height,
        ])
    }
}

func startRecording(
    displayID: CGDirectDisplayID?, windowID: CGWindowID?, region: CGRect?, outDir: String
) async -> RecordingSession? {
    guard CGPreflightScreenCaptureAccess() else {
        _ = CGRequestScreenCaptureAccess()
        emit([
            "event": "permission-required",
            "permission": "screen-recording",
            // macOS needs the process restarted after the grant before capture works.
            "needsRestart": true,
        ])
        return nil
    }
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)

        var scale = 2.0
        var pointsWidth = 0
        var pointsHeight = 0
        var kind = "display"
        var title = ""
        var window: SCWindow?
        var origin = CGRect.zero
        var crop: CGRect?
        let filter: SCContentFilter

        if let windowID {
            guard let match = content.windows.first(where: { $0.windowID == windowID }) else {
                emitError("window \(windowID) not found")
                return nil
            }
            window = match
            kind = "window"
            title = match.title ?? ""
            origin = match.frame
            pointsWidth = Int(match.frame.width)
            pointsHeight = Int(match.frame.height)
            // A window can straddle displays, so take the scale of the one it sits on.
            scale = Double(
                NSScreen.screens.first { $0.frame.intersects(match.frame) }?.backingScaleFactor
                    ?? NSScreen.main?.backingScaleFactor ?? 2.0)
            filter = SCContentFilter(desktopIndependentWindow: match)
        } else {
            guard let displayID,
                let display = content.displays.first(where: { $0.displayID == displayID })
            else {
                emitError("display not found")
                return nil
            }
            scale = scaleFor(displayID: displayID)
            // A display capture starts at the screen origin, which is not always zero
            // on a multi display setup.
            let screenOrigin = screenFor(displayID: displayID)?.frame.origin ?? .zero
            if let region {
                // Recording a chosen area. sourceRect is in points relative to the
                // display, so the global rect has to come back into display space.
                kind = "region"
                crop = CGRect(
                    x: region.origin.x - screenOrigin.x, y: region.origin.y - screenOrigin.y,
                    width: region.width, height: region.height)
                pointsWidth = Int(region.width)
                pointsHeight = Int(region.height)
                origin = region
            } else {
                pointsWidth = display.width
                pointsHeight = display.height
                origin = CGRect(
                    x: screenOrigin.x, y: screenOrigin.y,
                    width: CGFloat(display.width), height: CGFloat(display.height))
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
        }

        try FileManager.default.createDirectory(
            atPath: outDir, withIntermediateDirectories: true)
        let videoPath = (outDir as NSString).appendingPathComponent("video.mov")
        try? FileManager.default.removeItem(atPath: videoPath)

        let config = SCStreamConfiguration()
        // THE CORE SWITCH. Omit the cursor so it can be redrawn in post from the track.
        config.showsCursor = false
        config.width = Int(Double(pointsWidth) * scale)
        config.height = Int(Double(pointsHeight) * scale)
        // Crops the stream to the chosen area rather than scaling the whole display down.
        if let crop { config.sourceRect = crop }
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        config.capturesAudio = false
        config.queueDepth = 8

        let interruption = Interruption()
        let stream = SCStream(
            filter: filter, configuration: config,
            delegate: StreamDelegate(interruption: interruption))

        let sink = SinkOutput()
        try stream.addStreamOutput(
            sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frame-studio.sink"))

        let recConfig = SCRecordingOutputConfiguration()
        recConfig.outputURL = URL(fileURLWithPath: videoPath)
        recConfig.outputFileType = .mov
        recConfig.videoCodecType = .h264
        try stream.addRecordingOutput(
            SCRecordingOutput(configuration: recConfig, delegate: RecDelegate()))

        let recorder = CursorRecorder()
        globalRecorder = recorder
        recorder.start()
        try await stream.startCapture()
        emit(["event": "started", "tapInstalled": recorder.installed])

        return RecordingSession(
            stream: stream, sink: sink, recorder: recorder, interruption: interruption,
            outDir: outDir, scale: scale,
            pointsWidth: pointsWidth, pointsHeight: pointsHeight,
            kind: kind, title: title, window: window, origin: origin)
    } catch {
        emitError("could not start recording: \(error.localizedDescription)")
        return nil
    }
}

func finishRecording(_ session: RecordingSession) async {
    do {
        try await session.stream.stopCapture()
    } catch {
        // An already-stopped stream throws here, which is expected after an
        // interruption. The bundle is still worth finalising.
    }
    session.recorder.stop()
    globalRecorder = nil

    let trackPath = (session.outDir as NSString).appendingPathComponent("cursor.jsonl")
    let metaPath = (session.outDir as NSString).appendingPathComponent("meta.json")
    do {
        let written = try session.recorder.write(to: trackPath)
        let duration = CFAbsoluteTimeGetCurrent() - session.recorder.startedAt
        // Measured, not assumed: the tap starts fractionally before startCapture returns.
        let offset = (session.sink.firstFrameAt ?? session.recorder.startedAt)
            - session.recorder.startedAt

        var meta: [String: Any] = [
            "version": 1,
            "captureKind": session.kind,
            "captureTitle": session.title,
            "captureFrames": session.frames,
            "displayScale": session.scale,
            "displayPoints": ["w": session.pointsWidth, "h": session.pointsHeight],
            "videoStartOffset": offset,
            "duration": duration,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
        ]
        if let reason = session.interruption.reason { meta["interrupted"] = reason }
        try JSONSerialization.data(withJSONObject: meta, options: [.sortedKeys])
            .write(to: URL(fileURLWithPath: metaPath))

        var finished: [String: Any] = [
            "event": "finished",
            "frames": session.sink.frames,
            "samples": written.count,
            "clicks": written.clicks,
            "duration": duration,
        ]
        // Absent on a normal stop, so the bridge only explains itself when something
        // actually went wrong.
        if let reason = session.interruption.reason { finished["interrupted"] = reason }
        emit(finished)
    } catch {
        emitError("could not finalise recording: \(error.localizedDescription)")
    }
}

// MARK: - command loop

// All stdin reading happens on a background thread feeding this queue, so the main
// thread can keep pumping the run loop. The event tap depends on that.
final class CommandQueue: @unchecked Sendable {
    private var items: [[String: Any]] = []
    private let lock = NSLock()

    func push(_ command: [String: Any]) {
        lock.lock()
        items.append(command)
        lock.unlock()
    }

    func drain() -> [[String: Any]] {
        lock.lock()
        let copy = items
        items.removeAll()
        lock.unlock()
        return copy
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)

let commands = CommandQueue()
let stdinClosed = Interruption()

Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { continue }
        commands.push(object)
    }
    stdinClosed.set("stdin closed")
}

var session: RecordingSession?
var running = true
var sampleTicks = 0

while running {
    // Pumping the run loop is what lets the event tap deliver. Never replace this
    // with a sleep.
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))

    for command in commands.drain() {
        switch command["cmd"] as? String {
        case "list-displays":
            await listDisplays()
        case "list-windows":
            await listWindows()
        case "start":
            guard session == nil else {
                emitError("already recording")
                break
            }
            guard let outDir = command["out"] as? String else {
                emitError("start needs out")
                break
            }
            let displayID = command["display"] as? Int
            let windowID = command["window"] as? Int
            var region: CGRect?
            if let r = command["region"] as? [String: Any],
                let x = r["x"] as? Double, let y = r["y"] as? Double,
                let w = r["width"] as? Double, let h = r["height"] as? Double
            {
                region = CGRect(x: x, y: y, width: w, height: h)
            }
            guard displayID != nil || windowID != nil else {
                emitError("start needs display or window")
                break
            }
            session = await startRecording(
                displayID: displayID.map { CGDirectDisplayID($0) },
                windowID: windowID.map { CGWindowID($0) },
                region: region,
                outDir: outDir)
        case "stop":
            guard let active = session else {
                emitError("not recording")
                break
            }
            session = nil
            await finishRecording(active)
        case "quit":
            running = false
        default:
            emitError("unknown command: \(String(describing: command["cmd"]))")
        }
    }

    // Track where the window is so the redrawn cursor keeps landing in the right place.
    if let active = session, active.kind == "window" {
        sampleTicks += 1
        if sampleTicks % 3 == 0 { await active.sampleWindowFrame() }
    }

    // A display change stops the stream from underneath us. Finalise what we have.
    if let active = session, active.interruption.reason != nil {
        session = nil
        await finishRecording(active)
    }

    if stdinClosed.reason != nil {
        if let active = session {
            session = nil
            await finishRecording(active)
        }
        running = false
    }
}

// Only windows a person could plausibly want to record: on screen, titled, and big
// enough to be a real window rather than a shadow or a menu.
func listWindows() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(
            true, onScreenWindowsOnly: true)
        let windows: [[String: Any]] = content.windows
            .filter { window in
                guard window.isOnScreen else { return false }
                guard let title = window.title, !title.isEmpty else { return false }
                guard window.frame.width >= 200 && window.frame.height >= 120 else { return false }
                // System chrome is on screen and titled but is never what someone means
                // by "record this window".
                let systemOwners: Set<String> = [
                    "com.apple.dock", "com.apple.WindowManager", "com.apple.controlcenter",
                    "com.apple.notificationcenterui", "com.apple.systemuiserver",
                    "com.apple.Spotlight", "com.apple.wallpaper.agent",
                ]
                let bundle = window.owningApplication?.bundleIdentifier ?? ""
                return !systemOwners.contains(bundle)
            }
            .sorted {
                ($0.owningApplication?.applicationName ?? "")
                    < ($1.owningApplication?.applicationName ?? "")
            }
            .map { window in
                [
                    "id": Int(window.windowID),
                    "title": window.title ?? "",
                    "app": window.owningApplication?.applicationName ?? "",
                    "width": Int(window.frame.width),
                    "height": Int(window.frame.height),
                ]
            }
        emit(["event": "windows", "windows": windows])
    } catch {
        emitError("could not list windows: \(error.localizedDescription)")
    }
}

func listDisplays() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)
        let displays: [[String: Any]] = content.displays.map { display in
            [
                "id": Int(display.displayID),
                "width": display.width,
                "height": display.height,
                "scale": scaleFor(displayID: display.displayID),
                "name": nameFor(displayID: display.displayID),
            ]
        }
        emit(["event": "displays", "displays": displays])
    } catch {
        emitError("could not list displays: \(error.localizedDescription)")
    }
}
