#!/usr/bin/env sh
# Copies the conformance fixtures from the spec repository (../spec by default) into test/fixtures.
set -eu
SPEC="${1:-$(dirname "$0")/../../spec}"
DEST="$(dirname "$0")/../test/fixtures"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SPEC/fixtures/kestrel" "$SPEC/fixtures/ingest" "$SPEC/fixtures/expected" "$DEST/"
mkdir -p "$DEST/examples"
cp "$SPEC/fixtures/examples/webhook-signature-vector.json" "$DEST/examples/"
echo "fixtures copied from $SPEC"
