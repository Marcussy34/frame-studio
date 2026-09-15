# Frame Studio

A standalone Mac screen recorder and video canvas editor. Record your screen or import a video, give it a background and frame, then export a finished MP4.

Recordings capture the cursor as data rather than pixels, so Frame Studio redraws it afterwards: larger, spring smoothed, motion blurred, with click effects and an automatic zoom that follows where you are working.

## Build the desktop app

The desktop app has its own window and native file/save dialogs. Its build bundles Node, FFmpeg, and the required libraries, so running the finished application does not require Terminal, Homebrew, or a separate browser.

The current desktop target is **Apple Silicon macOS**. The verified build requires **macOS 26 or newer**; each build derives its minimum macOS version from the media libraries installed on the build machine. Packaging uses local ad-hoc signing. Public distribution notarization and Windows packaging are not configured.

Requirements: Node 22.12 or newer, FFmpeg/FFprobe, and Apple's command-line developer tools.

```sh
git clone https://github.com/Marcussy34/frame-studio.git
cd frame-studio
brew install node ffmpeg
npm ci
npm run desktop:package
open "release/mac-arm64/Frame Studio.app"
```

You can copy the resulting **Frame Studio.app** to `~/Applications`. Packaging writes to `release/` and never replaces an installed copy, so copy it across after rebuilding or you will keep launching the older app.

Run this once before your first build:

```sh
bash desktop/create-signing-identity.sh
```

It creates a local self-signed code signing identity and asks for your password to trust
it. Without it the build falls back to ad-hoc signing, which has no stable identity, so
macOS treats every rebuild as a different program and drops the Screen Recording
permission you already granted. With it, you grant that permission once and it survives
rebuilds. No Apple Developer membership is needed. It is local only and is not a
substitute for a Developer ID certificate if you ever distribute the app. `start.command` opens the installed or built app. Generated application bundles, user media, and local settings are excluded from this source repository.

## Use it

1. Choose **Record screen**, pick **Full screen**, **Window**, or **Area**, choose the target, and a three second countdown starts. **Area** dims the screen so you can drag a box around any portion of it, the same gesture as `Command+Shift+4`. Escape cancels. The window hides itself so it does not appear in its own recording. Stop with the floating button or `Command+Shift+/`, and the finished recording opens in the editor. Or drop a recording onto the editor, or choose **Import video**. `Command+O` also opens the picker.
2. Choose from 24 gradients, customize three colors and direction, switch between linear/radial gradients, choose a solid color or pattern, or import a background image. Change aspect ratio, padding, corners, shadow, video size, and position.
3. Play, pause, or seek through the actual video. `Space` toggles playback. Preview mute does not change exported audio.
4. For recordings, the **Cursor & zoom** panel appears in the inspector. Tune cursor size, smoothing, motion blur, click effects, zoom strength, and zoom speed. Everything previews live as you drag, because the preview and the export share one renderer.
5. Choose **Export video**, select a resolution, and choose whether to keep the original audio.
6. Click **Export MP4**, then **Download MP4** when it finishes. Choose the destination in the native save dialog.

The editor restores active exports and the latest completed download for the current video after a browser refresh. You can cancel an export and continue editing. Replacing a recording keeps your chosen canvas styling. Reset restores the default canvas.

## Video and storage behavior

- MOV, MP4, HEVC, and other formats supported by the bundled FFmpeg can be imported. The app checks actual video contents rather than trusting the file extension.
- A browser-friendly preview is prepared locally at up to 1280 × 720. Final exports use the original source.
- Exports are H.264 MP4 with optional AAC audio, at 720p, 1080p, or 4K. The chosen resolution describes the shorter canvas edge; portrait 1080p is 1080 × 1920, and square 1080p is 1080 × 1080.
- Source playback timing and relative audio/video delays are preserved, with output capped at 60 fps. The first or last video frame fills any gap before or after the video track while audio continues.
- Video size is relative to the space inside the padding. Position moves the video within that space; centering a video that already fills an axis will not move it on that axis.
- Inputs are limited to 4 GB, 16K source dimensions, and 24 hours. Rendering a large recording can take time and requires space for the source copy, preview, and export.
- Original files are never overwritten. Session files live in the Mac temporary directory. The most recent 12 completed jobs are retained during the session.
- Canvas preferences persist in the desktop app's data directory and survive relaunches. Videos and completed exports are temporary and are removed when the app quits. Save finished videos before quitting.
- Background images support JPG, PNG, and WebP up to 20 MB and 40 million pixels. They are normalized locally to an sRGB JPEG up to 1440 pixels per side, fill the canvas without stretching, and are remembered with your canvas preferences. Transparent areas are flattened to white.
- HDR color finishing and trimming are outside this version. Output uses 8-bit H.264.

## Recording behavior

- Recording captures one display at full resolution with the cursor **excluded from the pixels**, and logs cursor position and clicks separately at roughly 500Hz. That separation is what makes the cursor editable afterwards.
- macOS asks for up to three permissions. **Screen Recording** covers the pixels, and after granting it you must **quit and reopen Frame Studio** before capture works, which is an Apple requirement rather than a fault in the app. **Accessibility** covers the cursor, takes effect immediately, and is what lets Frame Studio see where your pointer is. Without it a recording refuses to start rather than producing a video with no cursor in it. **Microphone** is asked for only the first time you record with the microphone switched on.
- Each recording is saved as a bundle holding the video, the raw cursor track, and the metadata needed to interpret them together. The raw track is never modified, so any cursor or zoom setting can be retuned later without recording again.
- Capture runs at roughly 3MB per second at 4K, so a five minute recording is close to a gigabyte. Saved recordings are listed with their sizes in the Record dialog and can be deleted there.
- Auto zoom eases in around clicks and back out afterwards, and the frame is clamped so it never shows past the edge of the recording.
- **Camera plan.** Instead of zooming on every click, a recording can be planned shot by shot: when to move in, how close, where to point, and how fast to arrive. Each shot carries a short reason, so an odd choice is explainable rather than mysterious. The plan is stored with the recording, can be switched off or deleted, and the zoom strength slider still caps it.
- Planning uses Gemini through the Antigravity CLI, which reads sampled frames of the recording so it can tell a small button from a wall of text. **Frames are sent to Google through your own Antigravity account**, and there is a switch to plan from the cursor track alone if you would rather nothing of the screen left the machine. A planning run takes several minutes. The button only appears when the CLI is installed, and any failure keeps the mechanical plan rather than losing your work.
- **Imported video cannot have these features.** The cursor in an imported file is already burned into the pixels, so there is nothing to redraw and no position data to smooth. The Cursor & zoom panel only appears for recordings made in Frame Studio.
- Recording a single window captures only that window, with no desktop, dock, or menu bar behind it. Moving the window while recording is fine, since its position is tracked and the cursor follows it. **Resizing it mid recording is not supported yet.**
- While recording a window, the cursor is **hidden whenever it leaves that window**. Clamping it to the edge would draw a pointer that was never there.
- Recording an area crops the capture to the box you drew, so the exported video is exactly that size rather than a scaled down screen. The cursor is hidden whenever it leaves the area, the same as for a window.
- **Sound.** System audio and the microphone are two separate switches in the Record dialog, and either can be used on its own. System audio is whatever is playing on the Mac, with Frame Studio's own sounds left out. The microphone has a device picker, since most Macs have several inputs and the system default is often not the one you meant.
- The microphone needs its own macOS permission, asked for the first time you switch it on. Until it is allowed, the level meter stays idle and says so, and a recording made with it switched on comes back without narration and tells you why.
- **The two are mixed into one track as they are captured**, by macOS rather than by Frame Studio, so their balance cannot be changed afterwards. That is why the Record dialog shows a live input level: check the bar moves when you speak before you start. If a source records silence anyway, the app says so when the recording opens.
- Webcam is not in this version.
- Cursor positions are captured to whole screen points. The spring smoothing works on that, so the redrawn cursor moves smoothly rather than in steps.

Use **Frame Studio > Quit Frame Studio** or close the app window to quit. Shutdown stops video processing and deletes the temporary session. No external upload service, account, database, or API key is used.

## Development and verification

Building from source requires Node 22.12 or newer, FFmpeg/FFprobe, and Apple's command-line developer tools. Install dependencies with `npm ci`. The desktop build copies the installed FFmpeg and its linked libraries, adjusts only those copies, and includes their available notices. The installed Homebrew files remain unchanged.

```sh
npm run desktop:package
npm run test:desktop
```

Set `FRAME_DESKTOP_OUTPUT` to choose a separate release directory. Set `FRAME_DESKTOP_APP` to an app executable path when testing a particular build. Desktop tests use isolated profiles and run with Homebrew and external Node excluded from PATH.

```sh
npm test
npm run typecheck
npm run build
npx playwright install chromium --only-shell
npm run test:e2e
npm run format:check
```

Tests generate their own videos and delete their temporary files. The integration tests require an FFmpeg build with libx264 and libx265, such as the Homebrew build. Browser tests use an isolated server on port 4329.

The original browser mode remains available for development:

```sh
npm run build
npm start
```

For browser development with live updates, run `npm run dev` and open `http://127.0.0.1:4318`. Stop that development server with `Ctrl+C`.

Set `FRAME_PORT` to use a different port. `FRAME_FFMPEG_PATH` and `FRAME_FFPROBE_PATH` can point to specific executable paths.

The React interface lives in `src/`. Shared canvas geometry and artwork are in `shared/composition.ts`. `server/media.ts` normalizes playback timing and renders exports. `server/app.ts` manages imports, jobs, recovery, and downloads. The same background SVG and geometry drive preview and export.

UI controls come from the official shadcn registry and use Base UI. Icons use Iconsax. If adding a generated component, replace any default Lucide icon imports with Iconsax equivalents. Styling uses Tailwind utilities and theme tokens.

Desktop startup and shutdown are in `desktop/main.ts` and `desktop/runtime.ts`. Desktop preferences are validated and written atomically by `desktop/preferences.ts`.

Preference requests are serialized in edit order. Normal quit captures the latest visible canvas, closes older requests, and writes that final snapshot before removing the temporary video session.

The application has been verified with 26 integration tests, five browser workflows, and five packaged desktop workflows. Desktop tests cover actual exported files, background preparation, preference ordering, relaunch, and shutdown recovery.
