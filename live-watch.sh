#!/bin/bash
# Auto-watch: when a PJSIP caller appears, snapshot bridge/channel format state
# every 2s into /tmp/live_watch.log for up to 3 minutes.
OUT=/tmp/live_watch.log
: > "$OUT"
START=$(date +%s)
SEEN=0
while [ $(( $(date +%s) - START )) -lt 180 ]; do
  CALLER=$(asterisk -rx "core show channels" 2>/dev/null | grep -E 'PJSIP/' | head -1)
  if [ -n "$CALLER" ]; then
    SEEN=1
    {
      echo "===== $(date '+%H:%M:%S') ====="
      echo "--- channels ---"
      asterisk -rx "core show channels verbose" 2>/dev/null
      for c in $(asterisk -rx "core show channels" 2>/dev/null | grep -vE 'Channel|active|processed|==' | awk '{print $1}'); do
        echo ">>> $c"
        asterisk -rx "core show channel $c" 2>/dev/null | grep -aE "Name:|NativeFormats|ReadFormat|WriteFormat|State|Bridged Channel|Context:|UniqueID" 
      done
      echo "--- bridges ---"
      asterisk -rx "bridge show all" 2>/dev/null
    } >> "$OUT" 2>&1
  else
    sleep 2
  fi
done
[ "$SEEN" = "1" ] && echo watch-done-saw-caller >> "$OUT" || echo watch-done-no-caller >> "$OUT"