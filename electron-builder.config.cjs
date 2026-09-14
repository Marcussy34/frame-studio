const { readFileSync } = require('node:fs');
const media = JSON.parse(readFileSync('.desktop-build/media.json', 'utf8'));

module.exports = {
  appId: 'com.framestudio.app',
  productName: 'Frame Studio',
  directories: { app: '.desktop-build/app', output: process.env.FRAME_DESKTOP_OUTPUT || 'release' },
  files: ['**/*', '!**/*.map', '!package-lock.json'],
  asarUnpack: ['node_modules/sharp/**/*', 'node_modules/@img/**/*'],
  extraFiles: [{ from: '.desktop-build/media', to: '.' }],
  npmRebuild: false,
  mac: {
    target: [{ target: 'dir', arch: ['arm64'] }],
    category: 'public.app-category.video',
    icon: '.desktop-build/icon.icns',
    identity: '-',
    // The capture helper is signed by desktop/recorder/build.mjs with a pinned
    // identifier. Letting electron-builder re-sign it here would replace that with a
    // content-hash name that changes every rebuild, which makes macOS treat each build
    // as a new program and quietly invalidates the Screen Recording grant.
    signIgnore: ['frame-recorder$'],
    hardenedRuntime: false,
    minimumSystemVersion: media.minimumMacOS,
  },
};
