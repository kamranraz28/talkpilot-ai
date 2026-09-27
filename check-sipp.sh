#!/bin/sh
which sipp || apt list --installed 2>/dev/null | grep -i sipp
