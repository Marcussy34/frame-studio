# Capture permissions on macOS

What the screen recorder actually needs, verified on a real machine rather than inferred
from Apple's documentation.

## Summary

| Permission       | Needed for                                                                  | How it is granted                                              |
| ---------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Screen Recording | `SCShareableContent` and `SCStream`, so both listing displays and capturing | System prompt on first use, then the process must be restarted |
| Input Monitoring | The `CGEventTap` that logs cursor position and clicks                       | System Settings, Privacy and Security                          |
| Accessibility    | Not required for a listen-only mouse tap                                    | Not requested                                                  |

Screen Recording is the only one the helper prompts for. The others were already granted
on the test machine, so their necessity is inferred from Apple's API contracts rather than
observed failing, which is noted as a gap below.

## Does the bundled helper need its own grant?

**No, in every configuration tested.** This was the open risk in the design, because the
helper carries a different code identity from the app:

- App bundle: `com.framestudio.app`
- Helper: `frame-recorder-55554944d9ea36264e1a39ca86a574ecdafe2bd7`

Both are ad-hoc signed. Despite the distinct identity, the bundled helper at
`Contents/MacOS/frame-recorder` enumerated displays and recorded successfully, so macOS
resolved the grant through the responsible process rather than the helper's own identity.
The packaged app spawning the helper records end to end, which `desktop-tests/recorder.spec.ts`
asserts.

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

## Two findings that contradict the documentation

**`NSEvent.addGlobalMonitorForEvents` delivers nothing in a CLI helper.** With all three
permissions granted and the run loop running, a global monitor recorded zero mouse moves
and zero clicks over ten seconds. A `CGEventTap` over the same period recorded 10 clicks
and 5057 moves. The monitor needs a real `NSApplication` event loop, which a bundled CLI
does not have. Use `CGEventTap`.

**An event tap needs the run loop to actually run.** Waiting out a recording with
`Task.sleep` leaves the run loop idle and silently produces an empty cursor track, with no
error anywhere. `RunLoop.main.run(until:)` is required. This cost a full debugging cycle
and looks exactly like a permissions problem, which is why it is recorded here.

## Display scale is not always 2

A Dell AW2521H reports `backingScaleFactor` of **1**, not 2. The capture helper reads the
scale per display from the matching `NSScreen` and records it in `meta.json`. Hardcoding
2x, as an early prototype did, puts the redrawn cursor at double the correct coordinates
on any non-retina display.

## Coordinate space

`CGEvent.location` is already in top-left origin space, matching video pixel space once
multiplied by the display scale. No Y-flip is needed. `NSEvent.mouseLocation` uses a
bottom-left origin and would need flipping, which is a second reason to prefer the tap.
