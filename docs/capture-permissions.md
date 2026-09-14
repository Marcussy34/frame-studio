# Capture permissions on macOS

What the screen recorder actually needs, verified on a real machine rather than inferred
from Apple's documentation.

## Summary

| Permission       | Needed for                                                                  | How it is granted                                                                |
| ---------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Screen Recording | `SCShareableContent` and `SCStream`, so both listing displays and capturing | System prompt on first use, then the process must be restarted                   |
| Input Monitoring | The `CGEventTap` that logs cursor position and clicks                       | System Settings, Privacy and Security, Input Monitoring. **Required**, see below |
| Accessibility    | Not required for a listen-only mouse tap                                    | Not requested                                                                    |

**Input Monitoring is genuinely required**, and this was confirmed the unpleasant way.
After the app was given a new code signing identity, its existing Input Monitoring grant
no longer applied. Screen recording still worked perfectly, so the video looked fine,
but the event tap delivered **zero events** and the recording came back with an empty
cursor track and no error anywhere.

That answers a question left open earlier: Apple's documentation only ties event tap
permission to _key_ events, but a listen-only **mouse** tap needs Input Monitoring too.
`CGEvent.tapCreate` still succeeds without it. The tap is simply never fed.

The helper now calls `CGPreflightListenEventAccess()` before recording and reports
`permission-required` with `input-monitoring` rather than producing a silently broken
bundle, and a finished recording that captured no cursor events is flagged with
`noCursorData` so the app can explain itself.

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
