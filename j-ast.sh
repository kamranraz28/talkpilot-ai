#!/bin/sh
journalctl -u asterisk --no-pager -n 40 | grep -E "Started|Stopped|Stopping|Failed|Segfault|signal" | tail -n 25
