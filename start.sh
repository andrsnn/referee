#!/bin/sh
# Start Art Director in the foreground. Settings come from config.json or ARTDIR_* env vars.
cd "$(dirname "$0")" && exec node server.mjs
