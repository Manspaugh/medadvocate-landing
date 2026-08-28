#!/usr/bin/env bash
# deploy-diff: confirm the DEPLOYED landing-analytics Lambda code matches the
# repo copy of analytics/index.mjs. Read only, makes no changes. Prints
# "IN SYNC" (exit 0) or "OUT OF SYNC" plus the diff (exit 1). Run this after
# deploy.sh to catch a committed-but-undeployed Lambda before trusting stats.
#
#   PROFILE=admin ./analytics/deploy-diff.sh
set -euo pipefail

PROFILE="${PROFILE:-${AWS_PROFILE:-la-deploy}}"
REGION="us-east-2"
FUNC="landing-analytics"
DIR="$(cd "$(dirname "$0")" && pwd)"
AWS=(aws --profile "$PROFILE" --region "$REGION")

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# get-function returns a presigned URL to the deployed code zip.
URL="$("${AWS[@]}" lambda get-function --function-name "$FUNC" \
  --query 'Code.Location' --output text)"
curl -fsSL "$URL" -o "$TMP/fn.zip"
unzip -q -o "$TMP/fn.zip" -d "$TMP/live"

if diff -u "$TMP/live/index.mjs" "$DIR/index.mjs" > "$TMP/diff.txt"; then
  echo "IN SYNC: deployed $FUNC matches analytics/index.mjs"
  exit 0
else
  echo "OUT OF SYNC: deployed $FUNC differs from analytics/index.mjs"
  echo "  (- deployed / + repo)"
  cat "$TMP/diff.txt"
  exit 1
fi
