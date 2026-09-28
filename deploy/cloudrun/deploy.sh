#!/usr/bin/env bash
# Deploys the Bun build of the portal to Google Cloud Run.
#
# Cloud Run containers have no persistent disk, so:
#   - images and zips go to a Cloud Storage bucket through its S3-compatible API (HMAC key), and
#   - the SQLite database is restored from / replicated to the same bucket with Litestream.
# The service runs as exactly one instance (SQLite has one writer) with CPU always allocated, so
# background jobs and the scheduled-import timer keep running.
#
# Usage: PROJECT=my-project REGION=europe-west4 ./deploy/cloudrun/deploy.sh
# Needs: gcloud (logged in), billing enabled on the project.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project id}"
REGION="${REGION:-europe-west4}"
SERVICE="${SERVICE:-brand-portal}"
BUCKET="${BUCKET:-${PROJECT}-${SERVICE}}"
SA_NAME="${SERVICE}-sa"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${SERVICE}/${SERVICE}:latest"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

gcloud config set project "$PROJECT" >/dev/null
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com storage.googleapis.com

# Storage bucket for images, zips and the database replica.
if ! gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" --uniform-bucket-level-access
fi

# Service account with access to the bucket and the secrets.
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name "Brand portal"
fi
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member "serviceAccount:${SA}" --role roles/storage.objectAdmin >/dev/null

# Secrets (created once; rotate them in Secret Manager).
ensure_secret() {
  local name="$1" value="$2"
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic
  fi
  gcloud secrets add-iam-policy-binding "$name" --member "serviceAccount:${SA}" --role roles/secretmanager.secretAccessor >/dev/null
}
ensure_secret "${SERVICE}-secret-key" "$(openssl rand -base64 48)"
ensure_secret "${SERVICE}-setup-code" "$(openssl rand -hex 6)"

# HMAC key so the portal can use Cloud Storage through the S3 API.
if ! gcloud secrets describe "${SERVICE}-hmac-secret" >/dev/null 2>&1; then
  HMAC_JSON="$(gcloud storage hmac create "$SA" --format=json)"
  ACCESS_ID="$(printf '%s' "$HMAC_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["metadata"]["accessId"])')"
  SECRET="$(printf '%s' "$HMAC_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["secret"])')"
  ensure_secret "${SERVICE}-hmac-id" "$ACCESS_ID"
  ensure_secret "${SERVICE}-hmac-secret" "$SECRET"
fi

# Build the image with Cloud Build.
if ! gcloud artifacts repositories describe "$SERVICE" --location "$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$SERVICE" --repository-format docker --location "$REGION"
fi
gcloud builds submit "$ROOT" --tag "$IMAGE"

gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --service-account "$SA" \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --no-cpu-throttling \
  --memory 1Gi \
  --timeout 3600 \
  --set-env-vars "OBX_TRUST_PROXY=true,OBX_STORAGE=s3,OBX_S3_ENDPOINT=https://storage.googleapis.com,OBX_S3_BUCKET=${BUCKET},OBX_S3_REGION=auto,OBX_S3_PREFIX=files,LITESTREAM_REPLICA_URL=gcs://${BUCKET}/db" \
  --set-secrets "OBX_SECRET_KEY=${SERVICE}-secret-key:latest,OBX_SETUP_CODE=${SERVICE}-setup-code:latest,OBX_S3_ACCESS_KEY_ID=${SERVICE}-hmac-id:latest,OBX_S3_SECRET_ACCESS_KEY=${SERVICE}-hmac-secret:latest"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "OBX_PUBLIC_URL=${URL}" >/dev/null

echo
echo "Your portal runs at: ${URL}"
echo "Setup code: gcloud secrets versions access latest --secret ${SERVICE}-setup-code"
