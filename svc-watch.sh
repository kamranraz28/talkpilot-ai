#!/bin/bash
# Supervisor: keeps the local Asterisk + AI node alive no matter what.
# Launched detached from start-wsl.sh (and can be started manually).
LOG=/mnt/d/xampp/htdocs/a/talkpilot/ai-call-asterisk/svc-watch.log
APP_DIR=/mnt/d/xampp/htdocs/a/talkpilot/ai-call-asterisk
exec >> "$LOG" 2>&1

while true; do
  if ! pidof asterisk >/dev/null 2>&1; then
    echo "$(date) starting asterisk (was down)"
    /etc/init.d/asterisk start >/dev/null 2>&1
  fi

  if ! pgrep -f 'node src/index.js' >/dev/null 2>&1; then
    echo "$(date) starting node src/index.js (was down)"
    if pidof asterisk >/dev/null 2>&1; then
      (cd "$APP_DIR" && setsid nohup node src/index.js >> app.log 2>&1 < /dev/null &)
    else
      # Asterisk must be up first or the node exits on ARI connect failure.
      sleep 5
    fi
  fi

  sleep 30
done