#!/bin/sh
# Fake `codex` for offline tests (e2e/image-providers.test.mjs). Behaviour comes from the environment:
#   FAKE_CODEX_LOG     file that receives one line per argument ("---" ends a call)
#   FAKE_CODEX_IMAGE   PNG copied into $CODEX_HOME/generated_images/<thread>/
#   FAKE_CODEX_LOGIN   chatgpt (default) | apikey | none      -> `codex login status`
#   FAKE_CODEX_MODE    ok (default) | fail | noimage | hang | hang-tree
#   FAKE_CODEX_PID     file that receives this process id in the hang modes (written once it is ready for a cancel)
#   FAKE_CODEX_FAIL_FROM  N: calls number N and later behave like mode "fail"
HERE=$(cd "$(dirname "$0")" && pwd)
if [ "$1" = "login" ]; then
  case "${FAKE_CODEX_LOGIN:-chatgpt}" in
    chatgpt) echo "Logged in using ChatGPT"; exit 0 ;;
    apikey) echo "Logged in using an API key"; exit 0 ;;
    *) echo "Not logged in" >&2; exit 1 ;;
  esac
fi
MODE="${FAKE_CODEX_MODE:-ok}"
if [ -n "$FAKE_CODEX_LOG" ]; then
  for a in "$@"; do printf '%s\n' "$a" >> "$FAKE_CODEX_LOG"; done
  printf 'CWD:%s\n' "$(pwd)" >> "$FAKE_CODEX_LOG"
  printf 'CWDFILES:%s\n' "$(ls -A | wc -l | tr -d ' ')" >> "$FAKE_CODEX_LOG"
  PREV=""
  for a in "$@"; do
    if [ "$PREV" = "-i" ]; then if [ -f "$a" ]; then echo "REFOK:$a" >> "$FAKE_CODEX_LOG"; else echo "REFMISSING:$a" >> "$FAKE_CODEX_LOG"; fi; fi
    PREV="$a"
  done
  echo "---" >> "$FAKE_CODEX_LOG"
  if [ -n "$FAKE_CODEX_FAIL_FROM" ] && [ "$(grep -c '^---$' "$FAKE_CODEX_LOG")" -ge "$FAKE_CODEX_FAIL_FROM" ]; then MODE=fail; fi
fi
THREAD="019e0000-fake-$$-$(date +%s)"
case "$MODE" in
  hang)
    # Trap first, then announce the pid: a cancel can only arrive once the trap is in place.
    sleep 60 &
    SP=$!
    trap 'kill $SP 2>/dev/null; exit 143' TERM
    echo "$$" > "$FAKE_CODEX_PID"
    printf '{"type":"thread.started","thread_id":"%s"}\n' "$THREAD"
    wait $SP
    exit 0
    ;;
  hang-tree)
    # No trap: SIGTERM ends this shell while its child keeps the stdout pipe open, like a tool codex started.
    # Only a cancel that signals the whole process group lets the run finish.
    sleep 60 &
    echo "$$" > "$FAKE_CODEX_PID"
    printf '{"type":"thread.started","thread_id":"%s"}\n' "$THREAD"
    wait
    exit 0
    ;;
  fail)
    printf '{"type":"thread.started","thread_id":"%s"}\n' "$THREAD"
    echo '{"type":"error","message":"Not logged in: run codex login"}'
    echo '{"type":"turn.failed","error":{"message":"Not logged in: run codex login"}}'
    exit 1
    ;;
  noimage)
    sed -e "s|__THREAD__|$THREAD|" -e "s|__IMAGE__|I could not create that image.|" "$HERE/events.jsonl"
    exit 0
    ;;
esac
DIR="$CODEX_HOME/generated_images/$THREAD"
mkdir -p "$DIR"
cp "$FAKE_CODEX_IMAGE" "$DIR/exec-0001.png"
printf '%s' "$THREAD" >> "$DIR/exec-0001.png" # trailing bytes: every run yields a distinct file
sed -e "s|__THREAD__|$THREAD|" -e "s|__IMAGE__|$DIR/exec-0001.png|" "$HERE/events.jsonl"
exit 0
