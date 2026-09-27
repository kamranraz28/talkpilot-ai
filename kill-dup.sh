#!/bin/sh
kill 556 2>/dev/null
sleep 2
ps -ef | grep "src/index" | grep -v grep
curl -s -m 5 http://127.0.0.1:5300/health
