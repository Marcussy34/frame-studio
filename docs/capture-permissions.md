# Capture permissions on macOS

What the screen recorder actually needs, verified on a real machine rather than inferred
from Apple's documentation.

## Summary

| Permission       | Held by            | Needed for                                                             | How it is granted                                                |
| ---------------- | ------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Screen Recording | the capture helper | `SCShareableContent` and `SCStream`, so listing displays and capturing | System prompt on first use, then the process must be restarted   |
| Accessibility    | Frame Studio.app   | The event tap that logs cursor position and clicks                     | System Settings, Privacy and Security, Accessibility. Immediate  |
| Input Monitoring | nobody             | Nothing any more, see below                                            | Not requested                                                    |
| Microphone       | Frame Studio.app   | `SCStreamConfiguration.captureMicrophone`, so narration over a demo    | System prompt on first use, needs `NSMicrophoneUsageDescription` |

## Why the cursor is tracked in the app and not in the helper

This is the single most expensive thing learned here, so it is written out in full.

macOS resolves the two grants against **different processes**:

- **Screen Recording** resolves against the **responsible process**. The helper is
  spawned by Frame Studio, so it inherits the app's grant. This works, and it is why a
  separate Swift binary was viable in the first place.
- **Input tapping** resolves against the **calling binary**. The helper is a bare
  executable in `Contents/MacOS`, not a bundle, so TCC has nothing to key a grant to.

The result was a perfect silent failure. `CGEvent.tapCreate` succeeded every time, the
video recorded flawlessly, and the tap was **never fed a single event**. The bundle came
back with an empty cursor track and no error anywhere. Measured with a diagnostic
command on the helper, spawned by the packaged app:

```json
{ "screenRecording": true, "inputMonitoring": false, "accessibility": false }
```

**Also tried and ruled out:** giving the helper the app's exact designated requirement,
byte for byte. Still denied. A bare executable is not a bundle, and TCC will not grant
one an input permission however it is signed. Adding the helper by hand with the `+`
button in System Settings does work, but asking every user to do that is not a product.

**The fix was to move the tap into the Electron main process**, where the calling
process is Frame Studio.app itself. `uiohook-napi` provides it, and the grant it needs
is **Accessibility**, because libuiohook checks `AXIsProcessTrustedWithOptions` before
it will run at all. Accessibility also covers event tapping, so Input Monitoring is no
longer involved anywhere in this app.

That check is worth more than it looks. It closes the failure mode by construction:
either the hook starts, which means the process is trusted and the tap is fed, or
`uIOhook.start()` throws and the recording refuses to begin with a message naming the
pane. There is no longer a path to a video with a silently empty cursor track.
`noCursorData` survives as a second line of defence for the honest case where nobody
touched the mouse.

Verified end to end against the packaged app, with synthetic mouse events so the result
did not depend on a person moving the mouse:

```
permissions: {"screenRecording":true,"accessibility":true}
stop: {"frames":132,"duration":2.87,"samples":200,"clicks":0}
meta: {"videoStartOffset":0.465,"displayScale":1,"captureKind":"display"}
cursor events: 200
```

## An upstream libuiohook bug worth knowing

`libuiohook/src/darwin/input_hook.c` handles `kCGEventOtherMouseUp` by calling
`process_button_pressed`, not `process_button_released`. **Releases of the middle button
and anything past it arrive as presses.** Left and right, the two that matter, are
handled correctly.

Left alone this fires a second click ripple and a second zoom trigger on every middle
click. `desktop/cursor-track.ts` reads a press of a button that is already down as the
release it must actually be, which reconstructs the truth without depending on the
upstream fix.

Found by posting a synthetic middle click during a real recording and reading the track
back: two `"e":"d"` events 66ms apart, which was exactly the gap between the posted down
and up.

## One more uiohook detail

`uiohook-napi` rewrites `EVENT_MOUSE_DRAGGED` to `EVENT_MOUSE_MOVED` in its N-API layer
before the event reaches JavaScript, so dragging arrives as ordinary movement and
`mousemove` alone would in fact have been enough. The tracker still handles the dragged
type, because that rewrite is an implementation detail and losing drags would freeze the
cursor for the whole of every drag.

## Does the bundled helper need its own Screen Recording grant?

**No, in every configuration tested.** This was the open risk in the design, because the
helper carries a different code identity from the app:

- App bundle: `com.framestudio.app`
- Helper: `com.framestudio.recorder`

Both are signed with the same local identity. Despite the distinct identifier, the
bundled helper at `Contents/MacOS/frame-recorder` enumerated displays and recorded
successfully, so macOS resolved the grant through the responsible process rather than the
helper's own identity. The packaged app spawning the helper records end to end, which
`desktop-tests/recorder.spec.ts` asserts.

This is the asymmetry that shaped the whole design: the responsible-process rule that
makes Screen Recording work for a helper is exactly what does **not** apply to input
tapping.

**The gap worth knowing.** In both tests the process tree was rooted in a terminal that
already held Screen Recording, so the responsible process may have resolved to the
terminal rather than to Frame Studio. A genuinely clean result needs Frame Studio.app
launched from Finder on a machine where it has never been granted the permission. The
consequence if that differs is an onboarding screen naming the helper, not a redesign.

## Restart after granting

Apple's own sample documents it, and the helper reports it: after Screen Recording is
granted the process must restart before capture works. `startRecording` emits
`{"event":"permission-required","permission":"screen-recording","needsRestart":true}`
rather than failing opaquely, so the UI can explain the restart instead of appearing
broken.

## Two findings from the helper-side tap, kept because they cost days

The tap no longer lives in the helper, but both of these look exactly like a permissions
problem and would cost the same time again.

**`NSEvent.addGlobalMonitorForEvents` delivers nothing in a CLI helper.** With all three
permissions granted and the run loop running, a global monitor recorded zero mouse moves
and zero clicks over ten seconds. A `CGEventTap` over the same period recorded 10 clicks
and 5057 moves. The monitor needs a real `NSApplication` event loop, which a bundled CLI
does not have.

**An event tap needs the run loop to actually run.** Waiting out a recording with
`Task.sleep` leaves the run loop idle and silently produces an empty cursor track, with no
error anywhere. `RunLoop.main.run(until:)` is required. The helper still pumps the run
loop, because ScreenCaptureKit delivers through it too.

## Audio, measured rather than inferred

ScreenCaptureKit captures system audio (`capturesAudio`, macOS 13) and the microphone
(`captureMicrophone`, macOS 15) natively. No `AVCaptureSession` is involved.

### SCRecordingOutput always writes exactly ONE audio track

This is the finding that shaped the whole feature. `SCRecordingOutputConfiguration` has
no audio properties at all: no codec, no bitrate, no way to keep the sources apart.
Measured on a real machine with four runs, counting streams with `ffprobe -show_streams`:

| System audio | Microphone | Audio streams in the file |
| ------------ | ---------- | ------------------------- |
| on           | on         | 1                         |
| on           | off        | 1                         |
| off          | on         | 1                         |
| off          | off        | 0                         |

Both sources arrive as separate `SCStreamOutputType` buffers, and ScreenCaptureKit sums
them before the recording output ever sees them. **The balance between narration and
system sound therefore cannot be changed afterwards.** Splitting them would mean
abandoning `SCRecordingOutput` and writing video and both audio tracks with
`AVAssetWriter`, which trades a working, tested capture path for a mixing control.

That trade was not taken. Instead the record dialog shows a live input meter before
recording, so a silent or wrongly chosen input is caught while it can still be fixed,
and `recordingNotice` in `shared/recording.ts` reports a source that recorded silence.

### `excludesCurrentProcessAudio` excludes by responsible process

Setting it to `true` is right for the app: Frame Studio's own sounds should not appear in
a recording of Frame Studio. But it does not mean only this process.

Measured: with `excludesCurrentProcessAudio = true`, a probe launched directly from a
terminal recorded **digital silence** while `afplay` played a tone from that same
terminal. Flipping the flag to `false`, with nothing else changed, captured the tone at
-40 dBFS. The same probe spawned by `node` instead captured the tone with the flag still
`true`.

So a terminal-launched test of system audio looks broken when it is not. Test system
audio by playing it from an unrelated application, or through the packaged app.

### The two sources have different sample formats

Read from the `AudioStreamBasicDescription`, not assumed. Reading one as the other gives
plausible-looking nonsense rather than an error, which is exactly how a silent recording
would slip through.

| Source        | Format                               | Rate  | Channels |
| ------------- | ------------------------------------ | ----- | -------- |
| `.audio`      | Float32, packed, **non-interleaved** | 48000 | 2        |
| `.microphone` | Int16, packed                        | 48000 | 1        |

### Microphone capture is mediated by replayd, and a pending decision wedges everything

This one cost an evening and is worth reading in full.

ScreenCaptureKit does **not** resolve the microphone grant against the calling binary the
way an event tap does. `replayd` asks for it, on its own serial queue. Sampled from a real
stuck run:

```
com.apple.tcc.auth.kTCCServiceMicrophone  (serial)
  tcc_server_message_request_authorization
    _tcc_server_send_request_authorization
      tccd_send_message → mach_msg2_trap
com.apple.replaykit.AlertDispatchQueue  (three more threads, same stack)
```

So the bare helper binary is **not** the problem here. The problem is what happens while
that request is outstanding:

- **`startCapture()` with `captureMicrophone = true` does not fail when the grant is
  missing. It never returns.** There is no error, no timeout, nothing to catch.
- Every later microphone capture queues behind it on that one serial queue, **in every
  process on the machine**. A capture that worked minutes earlier from a terminal stopped
  working, because it is the same `replayd`.
- Killing the blocked client does not clear it. `killall replayd` does; it is launchd
  managed and respawns on demand, and the very next capture worked again.

Screen capture and system audio are unaffected throughout. Measured while wedged: screen
only recorded 105 frames, system audio recorded fine, microphone hung.

**Consequences for this code, all of them load bearing:**

1. The helper checks `AVCaptureDevice.authorizationStatus(for: .audio)` before it will
   configure the microphone at all, in `startMicTest` and in `startRecording`.
2. The helper **never calls `requestAccess` itself.** It is a bare executable with no
   Info.plist, so it has nothing to prompt with. Asking belongs to the app, which carries
   `NSMicrophoneUsageDescription`.
3. A recording that asked for the microphone without the grant records **without it** and
   reports `microphoneBlocked`, rather than being refused. The countdown has already run
   and the window is already hidden by then.
4. The record dialog does not start the level check until the grant is actually
   `granted`.

**Do not "fix" the blocking await in the helper's command loop by handing the work to a
`Task`.** That was tried and measured: the loop drives the main actor, main-actor work
cannot interleave with its synchronous `RunLoop.main.run`, and the check then never
started at all. The authorization guard is what makes the await safe.

### The system default input is often not a microphone

On the development machine `AVCaptureDevice.default(for: .audio)` was a pair of USB
speakers. With a tone playing in the room it recorded **-74 dBFS**, against **-43 dBFS**
from the Razer microphone sitting next to it, a 30 dB difference. Eight input devices
were listed, two of them silent loopback drivers (BlackHole, Microsoft Teams Audio).

This is why the device picker and the level meter exist rather than just a switch.

## Display scale is not always 2

A Dell AW2521H reports `backingScaleFactor` of **1**, not 2. The capture helper reads the
scale per display from the matching `NSScreen` and records it in `meta.json`. Hardcoding
2x, as an early prototype did, puts the redrawn cursor at double the correct coordinates
on any non-retina display.

## Coordinate space

libuiohook reads `CGEventGetLocation`, which is already in top-left origin space,
matching video pixel space once multiplied by the display scale. **No Y-flip is needed.**
`NSEvent.mouseLocation` uses a bottom-left origin and would need flipping, which is a
second reason to prefer the tap.

One loss in the move off `CGEvent.location`: libuiohook carries coordinates as `int16_t`,
so they arrive truncated to whole points rather than as sub-point floats. The spring
smoothing in `shared/cursor.ts` absorbs that and the redrawn cursor still moves smoothly.
The range is nowhere near a concern, since a signed 16-bit point covers any real display
arrangement.

## Why the grant kept going stale (found the hard way)

The app is ad-hoc signed, which means it has no Team ID and macOS identifies it by its
code hash. **Every rebuild produces a different hash, so every reinstall invalidates an
existing Screen Recording grant.** The symptom is confusing: System Settings still shows
the toggle on, because that entry points at a code identity that no longer exists, while
the running app is treated as a different, untrusted program. Deny once at that point and
TCC records an explicit denial, which surfaces as:

```
could not list displays: The user declined TCCs for application, window, display capture
```

Two things make this less painful:

- The helper is signed with a **pinned identifier** (`com.framestudio.recorder`). By
  default `codesign --sign -` derives the identifier from the binary's content hash, so it
  changed on every build and added a second moving target. `electron-builder` re-signs
  nested binaries during packaging, which clobbered the pin, so `mac.signIgnore` now tells
  it to leave the helper alone.
- The app identifier itself (`com.framestudio.app`) was already stable. The remaining
  churn is the code hash, which is inherent to ad-hoc signing.

**Recovering from a stale grant:** `tccutil reset ScreenCapture com.framestudio.app`
removes every record for the app, after which the next launch prompts cleanly. Removing
the entry in System Settings with the minus button does the same thing.

**This is now fixed.** `desktop/create-signing-identity.sh` creates a local self-signed
code signing identity, and both the app and the capture helper are signed with it. The
difference is visible in the designated requirement, which is what TCC actually matches
against:

```
ad-hoc:  cdhash H"..."                                      changes every build
signed:  identifier "com.framestudio.app" and certificate leaf = H"..."   stable
```

Verified by building the helper twice with a source change in between: the binary hash
changed while the designated requirement stayed byte identical. The grant therefore
survives rebuilds now.

The build falls back to ad-hoc signing when the identity is not installed, so a fresh
clone still builds. A real Developer ID certificate is still the answer for distributing
the app to other people; this only solves local rebuilds.
