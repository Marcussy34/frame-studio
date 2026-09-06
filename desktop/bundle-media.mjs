import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const systemLibrary = (path) => path.startsWith('/usr/lib/') || path.startsWith('/System/');

export async function bundleMedia(destination) {
  if (process.platform !== 'darwin') throw new Error('This packaging script targets macOS.');
  await rm(destination, { recursive: true, force: true });
  const executables = join(destination, 'MacOS');
  const libraries = join(destination, 'Frameworks', 'FrameMedia');
  const licenses = join(destination, 'Resources', 'media-licenses');
  await Promise.all(
    [executables, libraries, licenses].map((path) => mkdir(path, { recursive: true })),
  );
  const items = new Map();
  const names = new Map();
  let minimumMacOS = '12.0';
  const visit = async (source, executable = false) => {
    const canonical = await realpath(source);
    if (items.has(canonical)) return items.get(canonical);
    const name = basename(source);
    if (names.has(name) && names.get(name) !== canonical)
      throw new Error(`Conflicting bundled library name: ${name}`);
    names.set(name, canonical);
    const item = {
      source: canonical,
      destination: join(executable ? executables : libraries, name),
      executable,
      dependencies: [],
    };
    items.set(canonical, item);
    const output = (await execute('/usr/bin/otool', ['-L', canonical])).stdout;
    for (const line of output.split('\n').slice(1)) {
      const dependency = line.trim().split(' (compatibility version')[0];
      if (!dependency || systemLibrary(dependency)) continue;
      if (!dependency.startsWith('/'))
        throw new Error(`Resolve non-absolute dependency before packaging: ${dependency}`);
      if ((await realpath(dependency)) === canonical) continue;
      item.dependencies.push({ reference: dependency, target: await visit(dependency) });
    }
    const metadata = (await execute('/usr/bin/otool', ['-l', canonical])).stdout;
    for (const match of metadata.matchAll(/\bminos\s+([\d.]+)/g)) {
      if (match[1].localeCompare(minimumMacOS, undefined, { numeric: true }) > 0)
        minimumMacOS = match[1];
    }
    return item;
  };
  for (const name of ['ffmpeg', 'ffprobe']) {
    const configured = process.env[name === 'ffmpeg' ? 'FRAME_FFMPEG_PATH' : 'FRAME_FFPROBE_PATH'];
    const source = configured || (await execute('/usr/bin/which', [name])).stdout.trim();
    if (!source) throw new Error(`Install ${name} before building the desktop application.`);
    await visit(source, true);
  }
  // Copy before changing load commands. Installed Homebrew binaries are never modified.
  for (const item of items.values()) {
    await copyFile(item.source, item.destination);
    await chmod(item.destination, 0o755);
    const changes = item.executable ? [] : ['-id', `@rpath/${basename(item.destination)}`];
    for (const dependency of item.dependencies) {
      const relative = item.executable ? '@loader_path/../Frameworks/FrameMedia/' : '@loader_path/';
      changes.push(
        '-change',
        dependency.reference,
        relative + basename(dependency.target.destination),
      );
    }
    if (changes.length) await execute('/usr/bin/install_name_tool', [...changes, item.destination]);
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', item.destination]);
  }
  const formulaRoots = new Set(
    [...items.keys()].map((path) => path.match(/^(.*\/Cellar\/[^/]+\/[^/]+)/)?.[1]).filter(Boolean),
  );
  for (const root of formulaRoots) {
    const folder = join(licenses, basename(dirname(root)));
    await mkdir(folder, { recursive: true });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && /^(COPYING|LICENSE|NOTICE|AUTHORS)/i.test(entry.name))
        await copyFile(join(root, entry.name), join(folder, entry.name));
    }
  }
  const binaries = ['ffmpeg', 'ffprobe'].map((name) => join(executables, name));
  const versions = [];
  for (const binary of binaries) {
    versions.push(
      (
        await execute(binary, ['-version'], { env: { ...process.env, PATH: '/usr/bin:/bin' } })
      ).stdout.split('\n')[0],
    );
  }
  const manifest = {
    platform: process.platform,
    arch: process.arch,
    minimumMacOS,
    versions,
    files: [...items.values()].map((item) => ({
      name: basename(item.destination),
      source: item.source,
    })),
  };
  await writeFile(
    join(destination, 'Resources', 'media-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  await writeFile(
    join(licenses, 'README.txt'),
    'FFmpeg and its linked libraries are included for local video processing. Original available notices are preserved in this directory. Build provenance and versions are in media-manifest.json.\n',
  );
  console.log(
    `Bundled current video tools and ${items.size - 2} libraries. macOS ${minimumMacOS} or newer.`,
  );
  return manifest;
}
