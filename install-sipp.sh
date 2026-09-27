#!/bin/sh
apt-get install -y sipp 2>&1 | tail -n 2
which sipp
