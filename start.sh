#!/bin/sh
# Start Referee in the foreground. Settings come from config.json or REFEREE_* env vars.
cd "$(dirname "$0")" && exec node server.mjs
