#!/bin/sh
grep -rl "systemctl.*asterisk\|service asterisk" /etc/systemd/ /etc/init.d/ /opt /usr/local/bin 2>/dev/null | head
systemctl list-timers --no-pager | head -n 8
