#!/bin/sh
grep -iE "register" /var/log/asterisk/messages.log | tail -n 20
grep -iE "public_ip|external|SIP_EXTERNAL" /etc/asterisk/pjsip.conf | tail
