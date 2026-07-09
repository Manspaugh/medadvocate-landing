#!/usr/bin/env bash
# Deploy (or update) the landing-analytics backend: DynamoDB table + Lambda +
# public Function URL. Idempotent — safe to re-run. Uses an AWS CLI profile
# with deploy rights (default: la-deploy).
#
#   PROFILE=la-deploy ./deploy.sh
set -euo pipefail

PROFILE="${PROFILE:-${AWS_PROFILE:-la-deploy}}"
REGION="us-east-2"
ACCOUNT="464608720325"
TABLE="landing-analytics"
ROLE="landing-analytics-role"
FUNC="landing-analytics"
AWS=(aws --profile "$PROFILE" --region "$REGION")
DIR="$(cd "$(dirname "$0")" && pwd)"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

# Dashboard passphrase — NEVER hardcoded. Supplied via env STATS_KEY, or a
# gitignored file analytics/.stats_key. Injected as a Lambda env var below.
if [ -z "${STATS_KEY:-}" ] && [ -f "$DIR/.stats_key" ]; then
  STATS_KEY="$(cat "$DIR/.stats_key")"
fi
if [ -z "${STATS_KEY:-}" ]; then
  echo "ERROR: no passphrase. Put it in analytics/.stats_key (gitignored) or run with STATS_KEY=..." >&2
  exit 1
fi
export STATS_KEY TABLE

# Build the Lambda environment JSON in a temp file so the passphrase is never
# on a command line (stays out of process args / shell history / logs).
ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT
python3 - "$ENVFILE" <<'PY'
import json, os, sys
open(sys.argv[1], "w").write(json.dumps(
    {"Variables": {"TABLE": os.environ["TABLE"], "STATS_KEY": os.environ["STATS_KEY"]}}))
PY

# ── 1. IAM role ────────────────────────────────────────────────────────────
say "IAM role: $ROLE"
if ! "${AWS[@]}" iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  "${AWS[@]}" iam create-role --role-name "$ROLE" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  echo "  created"
else
  echo "  exists"
fi
"${AWS[@]}" iam put-role-policy --role-name "$ROLE" --policy-name inline --policy-document "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[
    {\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\"],\"Resource\":\"arn:aws:logs:$REGION:$ACCOUNT:*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"dynamodb:UpdateItem\",\"dynamodb:GetItem\",\"dynamodb:BatchGetItem\"],\"Resource\":\"arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE\"}
  ]
}" >/dev/null
echo "  inline policy set"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"

# ── 2. DynamoDB table ──────────────────────────────────────────────────────
say "DynamoDB table: $TABLE"
if ! "${AWS[@]}" dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  "${AWS[@]}" dynamodb create-table --table-name "$TABLE" \
    --attribute-definitions AttributeName=pk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "  creating; waiting for ACTIVE..."
  "${AWS[@]}" dynamodb wait table-exists --table-name "$TABLE"
  echo "  active"
else
  echo "  exists"
fi

# ── 3. Package Lambda ──────────────────────────────────────────────────────
say "Packaging Lambda"
ZIP="$(mktemp -d)/fn.zip"
( cd "$DIR" && zip -q "$ZIP" index.mjs )
echo "  $ZIP"

# ── 4. Create/update function ──────────────────────────────────────────────
say "Lambda: $FUNC"
if ! "${AWS[@]}" lambda get-function --function-name "$FUNC" >/dev/null 2>&1; then
  # Role can take a few seconds to become assumable after creation.
  for i in 1 2 3 4 5 6; do
    if "${AWS[@]}" lambda create-function --function-name "$FUNC" \
        --runtime nodejs20.x --handler index.handler --role "$ROLE_ARN" \
        --timeout 10 --memory-size 128 \
        --environment "file://$ENVFILE" \
        --zip-file "fileb://$ZIP" >/dev/null 2>/tmp/la_err; then
      echo "  created"; break
    fi
    if grep -q "cannot be assumed" /tmp/la_err && [ "$i" -lt 6 ]; then
      echo "  role not ready, retrying ($i)..."; sleep 5
    else
      cat /tmp/la_err; exit 1
    fi
  done
else
  "${AWS[@]}" lambda update-function-code --function-name "$FUNC" --zip-file "fileb://$ZIP" >/dev/null
  "${AWS[@]}" lambda wait function-updated --function-name "$FUNC"
  "${AWS[@]}" lambda update-function-configuration --function-name "$FUNC" \
    --environment "file://$ENVFILE" --timeout 10 --memory-size 128 >/dev/null
  echo "  updated"
fi

# ── 5. Public endpoint via API Gateway HTTP API ────────────────────────────
# NB: Lambda Function URLs (auth NONE) are blocked by an org SCP in this
# account, so we front the function with an HTTP API instead (same as the
# main app). Quick-create wires a $default route + AWS_PROXY integration
# (payload format 2.0) + auto-deploy stage + invoke permission in one call.
say "API Gateway HTTP API: $FUNC"
FN_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FUNC"
API_ID="$("${AWS[@]}" apigatewayv2 get-apis --query "Items[?Name=='$FUNC'].ApiId | [0]" --output text)"
if [ "$API_ID" = "None" ] || [ -z "$API_ID" ]; then
  API_ID="$("${AWS[@]}" apigatewayv2 create-api --name "$FUNC" --protocol-type HTTP \
    --target "$FN_ARN" --query ApiId --output text)"
  echo "  created ($API_ID)"
  # Ensure API Gateway may invoke the function (quick-create usually adds this).
  "${AWS[@]}" lambda add-permission --function-name "$FUNC" \
    --statement-id apigw-invoke --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*/*" >/dev/null 2>&1 || true
else
  echo "  exists ($API_ID)"
fi

URL="https://$API_ID.execute-api.$REGION.amazonaws.com/"
say "DONE"
echo "Endpoint: $URL"
