import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import sharp from 'sharp';
import { bundleMedia } from './bundle-media.mjs';
import { buildRecorder } from './recorder/build.mjs';

const execute = promisify(execFile);
const root = resolve('.');
const stage = join(root, '.desktop-build');
const application = join(stage, 'app');
await mkdir(application, { recursive: true });
const project = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(
  join(application, 'package.json'),
  JSON.stringify(
    {
      name: 'frame-studio',
      productName: 'Frame Studio',
      version: project.version,
      description: 'A local video canvas editor.',
      author: 'Frame Studio',
      license: 'UNLICENSED',
      main: 'main.cjs',
      dependencies: { sharp: sharp.versions.sharp },
    },
    null,
    2,
  ) + '\n',
);
await execute('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: application,
  maxBuffer: 5_000_000,
});
await rm(join(application, 'renderer'), { recursive: true, force: true });
await cp(join(root, 'dist'), join(application, 'renderer'), { recursive: true });
await build({
  entryPoints: [join(root, 'desktop/main.ts')],
  outfile: join(application, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'sharp'],
  legalComments: 'linked',
});
const media = await bundleMedia(join(stage, 'media'));
// The capture helper ships beside ffmpeg so runtime resolution follows one rule, and
// bundle-media's existing ad-hoc signing pattern covers it the same way.
await buildRecorder(join(stage, 'media', 'MacOS'));
await writeFile(join(stage, 'media.json'), JSON.stringify(media, null, 2) + '\n');
const iconset = join(stage, 'FrameStudio.iconset');
await mkdir(iconset, { recursive: true });
const icon = await readFile(join(root, 'desktop/icon.svg'));
for (const size of [16, 32, 128, 256, 512]) {
  for (const factor of [1, 2]) {
    await sharp(icon)
      .resize(size * factor, size * factor)
      .png()
      .toFile(join(iconset, `icon_${size}x${size}${factor === 2 ? '@2x' : ''}.png`));
  }
}
await execute('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(stage, 'icon.icns')]);
await rm(iconset, { recursive: true, force: true });
console.log('Desktop runtime, renderer, native image module, and icon are staged.');
