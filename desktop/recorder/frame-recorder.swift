// Frame Studio capture helper.
//
// Captures the screen with the cursor EXCLUDED from the pixels, while logging cursor
// position and clicks separately, so the cursor can be redrawn in post with smoothing,
// motion blur and click effects.
//
// Protocol: newline delimited JSON. Commands arrive on stdin, events go to stdout.
//
// The cursor is NOT tracked here. It used to be, via a CGEventTap, and the tap was
// created successfully every time and then never fed a single event. macOS resolves
// Screen Recording against the responsible process, so this helper inherits the app's
// grant, but it resolves input tapping against the calling binary, and a bare
// executable inside Contents/MacOS is not a bundle that can be granted anything.
// Cursor tracking now lives in the Electron main process. See desktop/cursor-track.ts.
//
// The recording's t=0 therefore arrives from outside, as `startedAt` on the start
// command, so both halves of a bundle measure time from the same origin.

import AVFoundation
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

// MARK: - audio

// What the caller asked for. Both sources are off unless requested: system audio can
// pick up a call or whatever is playing, and the microphone needs its own grant.
struct AudioOptions {
    var system = false
    var microphone = false
    // AVCaptureDevice uniqueID. Empty means whatever macOS has set as the default input.
    var device = ""
    // Set when the microphone was asked for and macOS would not allow it. The recording
    // goes ahead without it rather than being refused: the countdown has already run and
    // the window is already hidden, so losing the take costs more than losing the sound.
    var microphoneBlocked = false
}

// Whether this process may actually open an input right now.
//
// This check is not optional. Asking ScreenCaptureKit for the microphone without the
// grant does not fail: startCapture() simply never returns, which suspends the command
// loop, stops the run loop being pumped, and wedges the whole helper until it is killed.
// Measured on a Finder launch with the grant still not determined.
//
// The helper deliberately never calls requestAccess itself. It is a bare executable with
// no Info.plist, so it has nothing to show a prompt with. Asking belongs to the app,
// which has NSMicrophoneUsageDescription. See desktop/main.ts.
func microphoneAuthorized() -> Bool {
    AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
}

// How far down the dBFS scale a reported level is allowed to go. A floor rather than
// negative infinity, because JSON has no way to carry one. This is NOT the threshold for
// calling a track silent: that is SILENT_DBFS in shared/recording.ts, and it is much
// higher, because a real microphone in a quiet room still reads around -74.
let LEVEL_FLOOR_DB = -120.0

func decibels(_ amplitude: Float) -> Double {
    amplitude <= 0 ? LEVEL_FLOOR_DB : max(LEVEL_FLOOR_DB, 20 * log10(Double(amplitude)))
}

// The two sources arrive in different shapes, read from the ASBD rather than assumed:
// system audio is non-interleaved Float32 stereo, the microphone is packed Int16 mono.
// Reading one as the other yields plausible looking nonsense, which is exactly how a
// silent recording would go unnoticed.
func peakAmplitude(of sampleBuffer: CMSampleBuffer) -> Float {
    guard let format = sampleBuffer.formatDescription,
        let asbd = format.audioStreamBasicDescription
    else { return 0 }
    let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
    var peak: Float = 0
    try? sampleBuffer.withAudioBufferList { list, _ in
        for buffer in list {
            guard let data = buffer.mData else { continue }
            if isFloat {
                let count = Int(buffer.mDataByteSize) / MemoryLayout<Float32>.size
                let samples = data.assumingMemoryBound(to: Float32.self)
                for index in 0..<count { peak = max(peak, abs(samples[index])) }
            } else {
                let count = Int(buffer.mDataByteSize) / MemoryLayout<Int16>.size
                let samples = data.assumingMemoryBound(to: Int16.self)
                for index in 0..<count {
                    peak = max(peak, abs(Float(samples[index]) / 32768))
                }
            }
        }
    }
    return peak
}

// Loudest sample seen per source, plus a level that resets on read so a live meter
// shows the last moment rather than the loudest moment ever.
final class Peaks: @unchecked Sendable {
    private var overall: [Int: Float] = [:]
    private var recent: [Int: Float] = [:]
    private let lock = NSLock()

    func note(_ type: SCStreamOutputType, _ peak: Float) {
        lock.lock()
        overall[type.rawValue] = max(overall[type.rawValue] ?? 0, peak)
        recent[type.rawValue] = max(recent[type.rawValue] ?? 0, peak)
        lock.unlock()
    }

    func peak(_ type: SCStreamOutputType) -> Float {
        lock.lock()
        defer { lock.unlock() }
        return overall[type.rawValue] ?? 0
    }

    func take(_ type: SCStreamOutputType) -> Float {
        lock.lock()
        defer { lock.unlock() }
        let value = recent[type.rawValue] ?? 0
        recent[type.rawValue] = 0
        return value
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
// Seconds since epoch, so it is directly comparable to the origin sent from the app.
final class SinkOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var first: Double?
    // Audio never reaches a file we can inspect until the recording is over, and by then
    // it is too late to do anything about a muted input, so its level is measured here.
    let peaks = Peaks()

    var frames: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
    var firstFrameAt: Double? {
        lock.lock()
        defer { lock.unlock() }
        return first
    }

    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        if type == .audio || type == .microphone {
            peaks.note(type, peakAmplitude(of: sampleBuffer))
            return
        }
        guard type == .screen, sampleBuffer.imageBuffer != nil else { return }
        lock.lock()
        if first == nil { first = Date().timeIntervalSince1970 }
        count += 1
        lock.unlock()
    }
}

// MARK: - recording session

final class RecordingSession {
    let stream: SCStream
    let sink: SinkOutput
    // Seconds since epoch, handed over by the app so the cursor track and this bundle
    // agree on what t=0 means.
    let startedAt: Double
    let interruption: Interruption
    let outDir: String
    let scale: Double
    let pointsWidth: Int
    let pointsHeight: Int
    let kind: String
    let title: String
    let audio: AudioOptions
    // Sampled window position. Cursor events are global, so a window that moves during
    // a recording needs its origin tracked or the redrawn cursor drifts away from it.
    let window: SCWindow?
    var frames: [[String: Any]] = []
    private var lastSampled: CGRect = .null

    init(
        stream: SCStream, sink: SinkOutput, startedAt: Double,
        interruption: Interruption, outDir: String, scale: Double,
        pointsWidth: Int, pointsHeight: Int, kind: String, title: String,
        audio: AudioOptions, window: SCWindow?, origin: CGRect
    ) {
        self.stream = stream
        self.sink = sink
        self.startedAt = startedAt
        self.interruption = interruption
        self.outDir = outDir
        self.scale = scale
        self.pointsWidth = pointsWidth
        self.pointsHeight = pointsHeight
        self.kind = kind
        self.title = title
        self.audio = audio
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
            "t": Date().timeIntervalSince1970 - startedAt,
            "x": frame.origin.x, "y": frame.origin.y,
            "w": frame.width, "h": frame.height,
        ])
    }
}

func startRecording(
    displayID: CGDirectDisplayID?, windowID: CGWindowID?, region: CGRect?, outDir: String,
    startedAt: Double, audio: AudioOptions
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

        // Never ask ScreenCaptureKit for an input macOS has not allowed: startCapture()
        // does not fail in that case, it never returns, and the helper is wedged until it
        // is killed. Recording continues without the microphone and says so afterwards.
        var audio = audio
        if audio.microphone && !microphoneAuthorized() {
            audio.microphone = false
            audio.microphoneBlocked = true
        }

        let config = SCStreamConfiguration()
        // THE CORE SWITCH. Omit the cursor so it can be redrawn in post from the track.
        config.showsCursor = false
        config.width = Int(Double(pointsWidth) * scale)
        config.height = Int(Double(pointsHeight) * scale)
        // Crops the stream to the chosen area rather than scaling the whole display down.
        if let crop { config.sourceRect = crop }
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        config.capturesAudio = audio.system
        config.captureMicrophone = audio.microphone
        // Empty means the system default input, which is what SCStreamConfiguration
        // already does when this is left unset.
        if audio.microphone && !audio.device.isEmpty {
            config.microphoneCaptureDeviceID = audio.device
        }
        // Frame Studio's own sounds are not part of what is being demonstrated. Measured
        // caveat: this excludes by responsible process, not literally this process. A
        // helper run from a terminal also silences audio played by that terminal's other
        // children, which makes a terminal-launched test of system audio look broken.
        config.excludesCurrentProcessAudio = true
        config.queueDepth = 8

        let interruption = Interruption()
        let stream = SCStream(
            filter: filter, configuration: config,
            delegate: StreamDelegate(interruption: interruption))

        let sink = SinkOutput()
        try stream.addStreamOutput(
            sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frame-studio.sink"))
        let audioQueue = DispatchQueue(label: "frame-studio.audio")
        if audio.system {
            try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: audioQueue)
        }
        if audio.microphone {
            try stream.addStreamOutput(sink, type: .microphone, sampleHandlerQueue: audioQueue)
        }

        let recConfig = SCRecordingOutputConfiguration()
        recConfig.outputURL = URL(fileURLWithPath: videoPath)
        recConfig.outputFileType = .mov
        recConfig.videoCodecType = .h264
        try stream.addRecordingOutput(
            SCRecordingOutput(configuration: recConfig, delegate: RecDelegate()))

        try await stream.startCapture()
        emit(["event": "started"])

        return RecordingSession(
            stream: stream, sink: sink, startedAt: startedAt, interruption: interruption,
            outDir: outDir, scale: scale,
            pointsWidth: pointsWidth, pointsHeight: pointsHeight,
            kind: kind, title: title, audio: audio, window: window, origin: origin)
    } catch {
        emitError("could not start recording: \(error.localizedDescription)")
        return nil
    }
}

// What actually landed on the audio track, not what was asked for. ScreenCaptureKit
// mixes system audio and the microphone into a single track before it reaches the file,
// so a level that turns out to be wrong cannot be corrected afterwards. Reporting the
// peak of each source is the only way the user finds out at all.
func audioReport(_ session: RecordingSession) -> [String: Any] {
    var report: [String: Any] = [
        "system": session.audio.system,
        "microphone": session.audio.microphone,
        "device": session.audio.device,
    ]
    if session.audio.microphoneBlocked { report["microphoneBlocked"] = true }
    if session.audio.system {
        report["systemPeak"] = decibels(session.sink.peaks.peak(.audio))
    }
    if session.audio.microphone {
        report["microphonePeak"] = decibels(session.sink.peaks.peak(.microphone))
    }
    return report
}

func finishRecording(_ session: RecordingSession) async {
    do {
        try await session.stream.stopCapture()
    } catch {
        // An already-stopped stream throws here, which is expected after an
        // interruption. The bundle is still worth finalising.
    }
    let metaPath = (session.outDir as NSString).appendingPathComponent("meta.json")
    do {
        // Measured, not assumed. The gap is real and not small: the cursor track opens
        // before this helper is even asked to start, and the app hides itself and the
        // stream warms up before the first frame lands.
        let firstFrame = session.sink.firstFrameAt ?? session.startedAt
        let offset = firstFrame - session.startedAt
        // The video's own length, which is what the recordings list shows. The cursor
        // track runs longer at both ends and is lined up by videoStartOffset.
        let duration = max(0, Date().timeIntervalSince1970 - firstFrame)

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
            "audio": audioReport(session),
        ]
        if let reason = session.interruption.reason { meta["interrupted"] = reason }
        try JSONSerialization.data(withJSONObject: meta, options: [.sortedKeys])
            .write(to: URL(fileURLWithPath: metaPath))

        var finished: [String: Any] = [
            "event": "finished",
            "frames": session.sink.frames,
            "duration": duration,
            "audio": audioReport(session),
        ]
        // Absent on a normal stop, so the bridge only explains itself when something
        // actually went wrong.
        if let reason = session.interruption.reason { finished["interrupted"] = reason }
        emit(finished)
    } catch {
        emitError("could not finalise recording: \(error.localizedDescription)")
    }
}

// MARK: - microphone check

// Listening to the chosen input before recording, through the SAME path the recording
// uses. This machine has eight input devices, two of them silent loopbacks, and the
// system default was a pair of speakers whose microphone recorded at -87 dBFS. Finding
// that out afterwards costs the take, because the mix cannot be unmade.
final class MicTest {
    let stream: SCStream
    let sink: SinkOutput
    init(stream: SCStream, sink: SinkOutput) {
        self.stream = stream
        self.sink = sink
    }
}

func startMicTest(device: String) async -> MicTest? {
    guard CGPreflightScreenCaptureAccess() else {
        emitError("Screen Recording is needed before the microphone can be checked.")
        return nil
    }
    guard microphoneAuthorized() else {
        emitError("macOS has not allowed Frame Studio to use the microphone yet.")
        return nil
    }
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            emitError("no display to attach the microphone check to")
            return nil
        }
        let config = SCStreamConfiguration()
        // A stream is the only way to reach the microphone here, so its video side is
        // made as small and as slow as it is allowed to be.
        config.width = 160
        config.height = 100
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.showsCursor = false
        config.capturesAudio = false
        config.captureMicrophone = true
        if !device.isEmpty { config.microphoneCaptureDeviceID = device }
        config.queueDepth = 3

        let stream = SCStream(
            filter: SCContentFilter(display: display, excludingWindows: []),
            configuration: config, delegate: nil)
        let sink = SinkOutput()
        try stream.addStreamOutput(
            sink, type: .microphone,
            sampleHandlerQueue: DispatchQueue(label: "frame-studio.mic-test"))
        try await stream.startCapture()
        emit(["event": "mic-test-started"])
        return MicTest(stream: stream, sink: sink)
    } catch {
        emitError("could not listen to the microphone: \(error.localizedDescription)")
        return nil
    }
}

// uniqueID is what microphoneCaptureDeviceID wants, and localizedName is the only part
// a person recognises. Enumerating needs no permission, so the list is offered before
// the microphone grant exists.
func listAudioInputs() {
    let discovery = AVCaptureDevice.DiscoverySession(
        deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified)
    let fallback = AVCaptureDevice.default(for: .audio)?.uniqueID ?? ""
    let inputs: [[String: Any]] = discovery.devices.map { device in
        [
            "id": device.uniqueID,
            "name": device.localizedName,
            "isDefault": device.uniqueID == fallback,
        ]
    }
    emit(["event": "audio-inputs", "inputs": inputs])
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
var micTest: MicTest?
var running = true
var sampleTicks = 0
var levelTicks = 0

while running {
    // ScreenCaptureKit delivers through the run loop, so it has to keep turning.
    // Never replace this with a sleep.
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))

    for command in commands.drain() {
        switch command["cmd"] as? String {
        case "list-displays":
            await listDisplays()
        case "list-windows":
            await listWindows()
        case "permissions":
            reportPermissions()
        case "list-audio-inputs":
            listAudioInputs()
        case "mic-test":
            // Recording owns the microphone once it starts, so the two never overlap.
            guard session == nil else {
                emitError("cannot check the microphone while recording")
                break
            }
            if let active = micTest {
                micTest = nil
                try? await active.stream.stopCapture()
            }
            // Awaited here on purpose, not handed to a detached Task. The loop drives
            // the main actor, so main-actor work cannot interleave with its synchronous
            // RunLoop.main.run and a Task would simply never get to run: measured, the
            // check then never started at all. What makes this await safe is the
            // authorization guard inside startMicTest, which returns immediately rather
            // than letting ScreenCaptureKit block on a decision nobody is going to make.
            micTest = await startMicTest(device: command["device"] as? String ?? "")
        case "mic-test-stop":
            if let active = micTest {
                micTest = nil
                try? await active.stream.stopCapture()
            }
            emit(["event": "mic-test-stopped"])
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
            // Falls back to now so the helper is still usable on its own, which is how
            // the capture tests drive it.
            let startedAt = command["startedAt"] as? Double ?? Date().timeIntervalSince1970
            var audio = AudioOptions()
            if let asked = command["audio"] as? [String: Any] {
                audio.system = asked["system"] as? Bool ?? false
                audio.microphone = asked["microphone"] as? Bool ?? false
                audio.device = asked["device"] as? String ?? ""
            }
            // The check holds the microphone open, and two streams asking for it at once
            // is not worth finding out about during a countdown.
            if let active = micTest {
                micTest = nil
                try? await active.stream.stopCapture()
            }
            session = await startRecording(
                displayID: displayID.map { CGDirectDisplayID($0) },
                windowID: windowID.map { CGWindowID($0) },
                region: region,
                outDir: outDir,
                startedAt: startedAt,
                audio: audio)
        case "stop":
            guard let active = session else {
                emitError("not recording")
                break
            }
            session = nil
            await finishRecording(active)
        case "quit":
            if let active = micTest {
                micTest = nil
                try? await active.stream.stopCapture()
            }
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

    // Emitted here rather than from the sample handler, so all output still comes from
    // a single thread and two lines of JSON can never interleave.
    if let active = micTest {
        levelTicks += 1
        if levelTicks % 5 == 0 {
            emit([
                "event": "mic-level",
                "peak": decibels(active.sink.peaks.take(.microphone)),
            ])
        }
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
// Diagnostic. Reports what this process can actually see, which matters because the
// grant is keyed to code identity and a stale entry still shows as enabled. The app
// answers for Accessibility itself, since that is where the cursor is tapped.
func reportPermissions() {
    emit([
        "event": "permissions",
        "screenRecording": CGPreflightScreenCaptureAccess(),
        // Reported alongside, so a disagreement with what Electron sees is visible
        // rather than something to guess at. Both should be the app's own grant.
        "microphone": microphoneAuthorized(),
    ])
}

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
