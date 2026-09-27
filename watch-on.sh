#!/bin/sh
asterisk -rx "logger add channel /tmp/ast_live.log notice,warning,error,verbose,dtmf"
sleep 1
tail -n 3 /tmp/ast_live.log
