#!/bin/sh
tail -n 120 /var/log/asterisk/call.log 2>/dev/null | head -n 80
