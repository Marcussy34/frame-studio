const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const media = JSON.parse(readFileSync('.desktop-build/media.json', 'utf8'));

// An ad-hoc signature has no stable identity, so macOS treats every rebuild as a new
// program and quietly drops the Screen Recording grant. A local self-signed identity
// keeps that grant across rebuilds. Falls back to ad-hoc when it is not installed, so
// the build still works on a machine that has not run create-signing-identity.sh.
const LOCAL_IDENTITY = 'Frame Studio Local Signing';
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

module.exports = {
  appId: 'com.framestudio.app',
  productName: 'Frame Studio',
  directories: { app: '.desktop-build/app', output: process.env.FRAME_DESKTOP_OUTPUT || 'release' },
  files: ['**/*', '!**/*.map', '!package-lock.json'],
  // Native modules have to sit on disk as real files: a .node cannot be loaded from
  // inside an asar archive.
  asarUnpack: [
    'node_modules/sharp/**/*',
    'node_modules/@img/**/*',
    'node_modules/uiohook-napi/**/*',
  ],
  extraFiles: [{ from: '.desktop-build/media', to: '.' }],
  npmRebuild: false,
  mac: {
    target: [{ target: 'dir', arch: ['arm64'] }],
    category: 'public.app-category.video',
    icon: '.desktop-build/icon.icns',
    identity: signingIdentity(),
    // The capture helper is signed by desktop/recorder/build.mjs with a pinned
    // identifier. Letting electron-builder re-sign it here would replace that with a
    // content-hash name that changes every rebuild, which makes macOS treat each build
    // as a new program and quietly invalidates the Screen Recording grant.
    signIgnore: ['frame-recorder$'],
    hardenedRuntime: false,
    minimumSystemVersion: media.minimumMacOS,
  },
};
