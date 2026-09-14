#!/bin/bash
# Creates a self-signed code signing identity for local Frame Studio builds.
#
# Why this exists: an ad-hoc signed app has no stable identity, so macOS sees every
# rebuild as a different program and silently invalidates the Screen Recording grant.
# The symptom is confusing, System Settings keeps showing the toggle on while recording
# fails with "the user declined TCCs". Signing with a consistent certificate gives the
# app one identity for good, so the permission is granted once and then stays granted.
#
# This needs no Apple Developer membership. It is local only and is not a substitute for
# a Developer ID certificate if the app is ever distributed to other people.
#
# Run once:  bash desktop/create-signing-identity.sh

set -euo pipefail

NAME="Frame Studio Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning | grep -q "$NAME"; then
  echo "Identity \"$NAME\" already exists. Nothing to do."
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/openssl.cnf" <<CONF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $NAME
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CONF

echo "Creating a self-signed code signing certificate…"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/openssl.cnf" 2>/dev/null

# macOS Security cannot read the AES based PKCS12 that OpenSSL 3 writes by default,
# so the bundle is written with the older algorithms it does understand.
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -out "$WORK/identity.p12" -passout pass:framestudio \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 2>/dev/null

echo "Importing it into your login keychain…"
# codesign is allowed to use the key without prompting on every build.
security import "$WORK/identity.p12" -k "$KEYCHAIN" -P framestudio \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null

echo "Trusting it for code signing. macOS will ask for your password."
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"

echo
if security find-identity -v -p codesigning | grep -q "$NAME"; then
  echo "Done. \"$NAME\" is ready."
  echo "Rebuild with: npm run desktop:package"
else
  echo "The identity was not created. Check the output above."
  exit 1
fi
