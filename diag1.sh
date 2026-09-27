#!/bin/sh
echo "--- registrations"
asterisk -rx "pjsip show registrations"
echo "--- endpoints contacts"
asterisk -rx "pjsip show contacts" 2>&1 | tail -n 8
echo "--- recent calls (cdr)"
asterisk -rx "cdr show" 2>/dev/null | head -3
echo "--- last 40 console log"
tail -n 40 /var/log/asterisk/messages.log | grep -vE "declined|WARNING|ERROR\[" | tail -n 12
echo "--- live logger last lines"
tail -n 20 /var/log/asterisk/call.log 2>/dev/null
