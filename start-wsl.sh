#!/bin/bash
# Auto-start the local Asterisk AI stack when the WSL VM boots.
# Wired up via /etc/wsl.conf [boot] command. Idempotent.
LOG=/mnt/d/xampp/htdocs/a/talkpilot/ai-call-asterisk/wsl-boot.log
exec >> "$LOG" 2>&1
echo "==== $(date) ===="

if ! pidof asterisk >/dev/null 2>&1; then
  /etc/init.d/asterisk start
  sleep 3
fi

if ! pgrep -f 'node src/index.js' >/dev/null 2>&1; then
  cd /mnt/d/xampp/htdocs/a/talkpilot/ai-call-asterisk
  nohup node src/index.js >> app.log 2>&1 < /dev/null &
fi

echo "started: asterisk=$(pidof asterisk || echo NO) node=$(pgrep -f 'node src/index.js' || echo NO)"

# Detached supervisor keeps both alive even if they crash mid-session.
if ! pgrep -f 'svc-watch.sh' >/dev/null 2>&1; then
  setsid nohup bash /mnt/d/xampp/htdocs/a/talkpilot/ai-call-asterisk/svc-watch.sh >> /mnt/d/xampp/htdocs/a/talkpilot/ai-call-asterisk/svc-watch.log 2>&1 < /dev/null &
fi