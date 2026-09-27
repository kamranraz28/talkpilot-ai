#!/bin/sh
apt-get update 2>&1 | tail -n 2
apt-get install -y sipp 2>&1 | tail -n 3
which sipp
