#!/usr/bin/env sh
# Copies the conformance fixtures from the spec repository (../spec by default) into test/fixtures,
# and the vocabularies (names of material, part, qualifier and care codes) into src/vocabularies,
# where the node bundles them for runtime (Bun and the Workers build import them as JSON).
set -eu
SPEC="${1:-$(dirname "$0")/../../spec}"
DEST="$(dirname "$0")/../test/fixtures"
VOCAB="$(dirname "$0")/../src/vocabularies"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SPEC/fixtures/kestrel" "$SPEC/fixtures/ingest" "$SPEC/fixtures/expected" "$SPEC/fixtures/imports" "$DEST/"
mkdir -p "$DEST/examples"
cp "$SPEC/fixtures/examples/webhook-signature-vector.json" "$DEST/examples/"
cp "$SPEC/docs/glossary.md" "$DEST/glossary.md"
rm -rf "$VOCAB"
mkdir -p "$VOCAB"
cp "$SPEC/vocabularies/parts.json" "$SPEC/vocabularies/materials.json" "$SPEC/vocabularies/qualifiers.json" "$SPEC/vocabularies/care.json" "$VOCAB/"
echo "fixtures and vocabularies copied from $SPEC"
