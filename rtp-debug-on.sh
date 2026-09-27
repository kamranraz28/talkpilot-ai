#!/bin/sh
asterisk -rx "rtp set debug on"
sleep 1
echo "rtp debug on. Tailing last lines as baseline:"
tail -n 5 /tmp/ast_live.log
