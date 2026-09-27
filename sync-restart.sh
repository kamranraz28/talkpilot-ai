#!/bin/sh
cd /mnt/d/xampp/htdocs/a/ai-call-asterisk
node -e '
const { syncOnce } = require("./src/sip-sync");
syncOnce({ LARAVEL_BASE: "${LARAVEL_BASE:-https://talkpilot.synergyinterface.com}", LARAVEL_TOKEN: "${LARAVEL_TOKEN:-}" })
  .then(() => console.log("SYNC_OK"))
  .catch(e => { console.error("sync failed:", e.message); process.exit(1); });
'
pkill -f "node src/index.js" 
sleep 1
cd /mnt/d/xampp/htdocs/a/ai-call-asterisk && setsid nohup node src/index.js >> app.log 2>&1 < /dev/null &
sleep 5
ps -ef | grep "src/index" | grep -v grep
