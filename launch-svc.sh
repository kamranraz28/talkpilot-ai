#!/bin/bash
cd /mnt/d/xampp/htdocs/a/talkpilot/ai-call-asterisk
if ! pgrep -f 'svc-watch.sh' >/dev/null 2>&1; then
  setsid nohup bash svc-watch.sh >> svc-watch.log 2>&1 < /dev/null &
fi