#!/bin/sh
curl -s -m 5 http://127.0.0.1:5300/health
echo
ps -ef | grep "src/index" | grep -v grep
