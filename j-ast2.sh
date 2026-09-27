#!/bin/sh
journalctl -u asterisk --no-pager --since "15:48" | grep -vE "Started|Stopped|Stopping" | head -n 60
