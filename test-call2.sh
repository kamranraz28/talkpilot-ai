#!/bin/sh
asterisk -rx "pjsip set logger on"
asterisk -rx "rtp set debug on"
asterisk -rx "core set verbose 5"
asterisk -rx "channel originate PJSIP/01609758377@e_09678777179_1 application Playback demo-congrats"
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  asterisk -rx "core show channels concise"
done
asterisk -rx "pjsip set logger off"
asterisk -rx "rtp set debug off"
