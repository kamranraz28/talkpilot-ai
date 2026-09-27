#!/bin/bash
# Snapshot bridge/channel state during a live AI call.
OUT=/tmp/live_snap.txt
: > "$OUT"
{
  echo "===== $(date '+%H:%M:%S') ====="
  echo "--- channels ---"
  asterisk -rx "core show channels verbose" 2>/dev/null
  echo "--- bridges ---"
  asterisk -rx "bridge show all" 2>/dev/null
  for b in $(asterisk -rx "bridge show all" 2>/dev/null | grep -oE 'Bridge: .*' | awk '{print $2}' | tr -d '[]'); do
    echo "--- bridge show $b ---"
    asterisk -rx "bridge show $b" 2>/dev/null
  done
  echo "--- per-channel RTP format ---"
  for c in $(asterisk -rx "core show channels" 2>/dev/null | grep -vE 'Channel|active|processed|==' | awk '{print $1}'); do
    echo ">>> $c"
    asterisk -rx "core show channel $c" 2>/dev/null | grep -aiE "ReadFormat|WriteFormat|NativeFormat|Bridged|Type:|Context:|Moh|State|RTP" 
  done
} >> "$OUT" 2>&1
echo SNAPSHOT_SAVED $OUT