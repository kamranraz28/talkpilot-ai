#!/bin/sh
systemctl is-active asterisk
asterisk -rx "core show channels" 2>&1 | tail -n 4
pjsip=$(asterisk -rx "pjsip show registrations" 2>&1 | grep -E "Registered|Unregistered")
echo "$pjsip"
