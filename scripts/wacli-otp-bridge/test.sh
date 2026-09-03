#!/usr/bin/env bash
# Self-test for bridge.js against a stubbed wacli binary. Run on the host:
#   ./scripts/wacli-otp-bridge/test.sh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
PORT=$((20000 + RANDOM % 10000))
TOKEN="test-token-0123456789abcdef0123456789abcdef"
FAILURES=0

cleanup() { [ -n "${BRIDGE_PID:-}" ] && kill "$BRIDGE_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

# stub wacli: log argv, succeed
cat > "$TMP/wacli" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$(dirname "$0")/calls.log"
echo '{}'
EOF
chmod +x "$TMP/wacli"

BRIDGE_TOKEN="$TOKEN" BRIDGE_PORT="$PORT" BRIDGE_BIND=127.0.0.1 \
  WACLI_BIN="$TMP/wacli" MIN_SEND_GAP_MS=0 MAX_PER_NUMBER_PER_HOUR=3 \
  node "$DIR/bridge.js" > "$TMP/bridge.log" 2>&1 &
BRIDGE_PID=$!
sleep 0.7

BASE="http://127.0.0.1:$PORT"
AUTH="Authorization: Bearer $TOKEN"
MSG="Intellacc verification code: 123456"

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected $2, got $3"; FAILURES=$((FAILURES+1)); fi
}

code() { curl -s -o "$TMP/body" -w '%{http_code}' "$@"; }

check "no auth -> 401"        401 "$(code -X POST "$BASE/send" -d '{}')"
check "wrong token -> 401"    401 "$(code -X POST "$BASE/send" -H 'Authorization: Bearer nope' -d '{}')"
check "health ok"             200 "$(code "$BASE/health" -H "$AUTH")"
check "bad recipient -> 400"  400 "$(code -X POST "$BASE/send" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"to\":\"abc\",\"message\":\"$MSG\"}")"
check "short recipient -> 400" 400 "$(code -X POST "$BASE/send" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"to\":\"1234567\",\"message\":\"$MSG\"}")"
check "non-template msg -> 400" 400 "$(code -X POST "$BASE/send" -H "$AUTH" -H 'Content-Type: application/json' -d '{"to":"4915112345678","message":"hello there"}')"
check "template+suffix -> 400" 400 "$(code -X POST "$BASE/send" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"to\":\"4915112345678\",\"message\":\"$MSG and visit evil.example\"}")"
check "valid send -> 200"     200 "$(code -X POST "$BASE/send" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"to\":\"4915112345678\",\"message\":\"$MSG\"}")"
check "send 2 -> 200"         200 "$(code -X POST "$BASE/send" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"to\":\"4915112345678\",\"message\":\"$MSG\"}")"
check "send 3 -> 200"         200 "$(code -X POST "$BASE/send" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"to\":\"4915112345678\",\"message\":\"$MSG\"}")"
check "send 4 same number -> 429" 429 "$(code -X POST "$BASE/send" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"to\":\"4915112345678\",\"message\":\"$MSG\"}")"
check "other number still ok" 200 "$(code -X POST "$BASE/send" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"to\":\"4915187654321\",\"message\":\"$MSG\"}")"

# wacli invocation shape: explicit JID, template message, delegates to daemon
# (NO --lock-wait — that would force direct store access and block on the
# sync daemon's permanent lock)
if grep -q -- "--to 4915112345678@s.whatsapp.net --message $MSG --json" "$TMP/calls.log" \
   && ! grep -q -- "--lock-wait" "$TMP/calls.log"; then
  echo "ok   wacli called with explicit JID + template, no --lock-wait"
else
  echo "FAIL wacli argv shape:"; cat "$TMP/calls.log"; FAILURES=$((FAILURES+1))
fi

if [ "$FAILURES" -eq 0 ]; then echo "ALL PASS"; else echo "$FAILURES FAILURES"; exit 1; fi
