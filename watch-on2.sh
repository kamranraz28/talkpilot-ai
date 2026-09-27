#!/bin/sh
asterisk -rx "logger remove channel /tmp/ast_live.log"
sleep 1
mkdir -p /var/log/asterisk/live
asterisk -rx "logger add channel /var/log/asterisk/live/call.log notice,warning,error,verbose,dtmf"
sleep 2
tail -n 3 /var/log/asterisk/live/call.log
