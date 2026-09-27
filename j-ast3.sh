#!/bin/sh
cat /lib/systemd/system/asterisk.service | grep -A6 "\[Service\]"
crontab -l 2>/dev/null
echo "--- root crontab ---"
grep -r "asterisk" /etc/cron* 2>/dev/null
