#!/bin/zsh -l
set -e
cd -- "${0:A:h}"

# The desktop app contains its own runtime and video tools.
for application in "$HOME/Applications/Frame Studio.app" "$PWD/release/final/mac-arm64/Frame Studio.app" "$PWD/release/mac-arm64/Frame Studio.app"; do
  if [[ -d "$application" ]]; then
    exec /usr/bin/open "$application"
  fi
done
print 'Build the desktop app first with: npm run desktop:package'
exit 1
