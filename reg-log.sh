#!/bin/sh
asterisk -rx "pjsip set logger on"
sleep 20
grep -E "REGISTER|401|200 OK|Failed|Reach|Auth" /var/log/asterisk/call.log 2>/dev/null | tail -n 30
