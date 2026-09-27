#!/bin/sh
rm -f /tmp/astlog.txt
asterisk -rx "core set verbose 5"
asterisk -rx "channel originate PJSIP/01609758377@e_09678777179_1 application Playback demo-congrats"
sleep 6
asterisk -rx "core show channels" > /tmp/astlog.txt 2>&1
grep -iE "01609758377|alloc|fail|error|cause" /var/log/asterisk/messages.log | tail -n 20 >> /tmp/astlog.txt
