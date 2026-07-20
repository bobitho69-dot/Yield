#!/usr/bin/env bash
# Verify a running Yield AI server: lists models, then does one chat completion.
#
# Usage:
#   ./smoke_test.sh                                  # localhost:8000, no key
#   YIELD_AI_BASE_URL=http://1.2.3.4:8000/v1\
#     YIELD_AI_API_KEY=xxxx ./smoke_test.sh          # remote + key
set -euo pipefail

BASE="${YIELD_AI_BASE_URL:-http://localhost:8000/v1}"
KEY="${YIELD_AI_API_KEY:-}"
SERVED="${YIELD_AI_SERVED_NAME:-yield-ai}"
auth=()
[ -n "$KEY" ] && auth=(-H "Authorization: Bearer $KEY")

echo "→ GET $BASE/models"
curl -fsS "${auth[@]}" "$BASE/models" | head -c 2000; echo; echo

echo "→ POST $BASE/chat/completions  (model: $SERVED)"
curl -fsS "${auth[@]}" -H 'content-type: application/json' \
  "$BASE/chat/completions" \
  -d "{\"model\":\"$SERVED\",\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"In one sentence, what are you?\"}]}" \
  | head -c 4000; echo; echo

echo "✓ If you saw a model list and a reply above, your Yield AI server is live."
echo "  Put YIELD_AI_BASE_URL=$BASE in your Yield Worker config."
