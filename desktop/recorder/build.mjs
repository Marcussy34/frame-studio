// Compiles the Swift capture helper. Kept separate from desktop/build.mjs so it can
// be built and tested on its own without running the whole desktop pipeline.
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

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
  // Ad-hoc signing derives the identifier from the binary's content hash by default,
  // so every rebuild looks like a brand new program to macOS and the Screen Recording
  // grant goes stale. Pinning the identifier keeps it constant across rebuilds.
  await execute('codesign', [
    '--force',
    '--sign',
    '-',
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
