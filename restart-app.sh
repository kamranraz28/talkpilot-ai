#!/bin/sh
node --check /mnt/d/xampp/htdocs/a/talkpilot/ai-call-asterisk/src/index.js && echo SYNTAX_OK
pkill -f "node src/index.js"
sleep 2
cd /mnt/d/xampp/htdocs/a/talkpilot/ai-call-asterisk
setsid nohup node src/index.js >> app.log 2>&1 < /dev/null &
sleep 5
ps -ef | grep "src/index" | grep -v grep
curl -s -m 5 http://127.0.0.1:5300/health
echo
tail -n 4 app.log