#!/bin/sh
asterisk -rx "pjsip show registrations"
echo "=== originate ==="
asterisk -rx "channel originate PJSIP/01609758377@e_09678777179_1 application Playback demo-congrats"
echo "=== log ==="
sleep 8
grep -iE "01609758377" /var/log/asterisk/messages.log | tail -n 15
