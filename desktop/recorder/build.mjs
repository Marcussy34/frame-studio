// Compiles the Swift capture helper. Kept separate from desktop/build.mjs so it can
// be built and tested on its own without running the whole desktop pipeline.
import { execFile, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const LOCAL_IDENTITY = 'Frame Studio Local Signing';

// Mirrors the resolution in electron-builder.config.cjs so both halves of the app are
// signed the same way, falling back to ad-hoc where the identity is not installed.
function signingIdentity() {
  try {
    const found = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    return found.includes(LOCAL_IDENTITY) ? LOCAL_IDENTITY : '-';
  } catch {
    return '-';
  }
}

export async function buildRecorder(outDir = resolve('.desktop-build', 'bin')) {
  await mkdir(outDir, { recursive: true });
  const output = join(outDir, 'frame-recorder');
  await execute('swiftc', [
    '-O',
    '-target',
    'arm64-apple-macosx26.0',
    '-framework',
    'ScreenCaptureKit',
    '-framework',
    'AppKit',
    '-framework',
    'CoreMedia',
    join(here, 'frame-recorder.swift'),
    '-o',
    output,
  ]);
  // Signed with the same local identity as the app when it is installed, so the helper
  // keeps one identity across rebuilds too. Ad-hoc signing would derive the identifier
  // from the binary's content hash, making every build look like a new program and
  // quietly invalidating the Screen Recording grant. See create-signing-identity.sh.
  await execute('codesign', [
    '--force',
    '--sign',
    signingIdentity(),
    '--identifier',
    'com.framestudio.recorder',
    output,
  ]);
  return output;
}

// Printing just the path keeps this usable as `node desktop/recorder/build.mjs`.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  console.log(await buildRecorder());
}
