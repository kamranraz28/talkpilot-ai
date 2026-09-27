#!/bin/sh
asterisk -rx "logger remove channel call.log"
sleep 1
asterisk -rx "logger add channel /var/log/asterisk/call.log notice,warning,error,verbose,dtmf"
sleep 2
tail -n 3 /var/log/asterisk/call.log
