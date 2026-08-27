#!/bin/bash
set -e
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH=~/node-v22/bin:$JAVA_HOME/bin:$PATH
export ANDROID_HOME=$HOME/.bubblewrap/android-sdk
export NODE_TLS_REJECT_UNAUTHORIZED=0
export BUBBLEWRAP_KEYSTORE_PASSWORD=AGENTMAIL_TWA_STORE_2026
export BUBBLEWRAP_KEY_PASSWORD=AGENTMAIL_TWA_KEY_2026
export SIGNING_KEY_PATH=/home/user/twa/agentmail.release.keystore
export SIGNING_KEY_ALIAS=agentmail
cd ~/twa/app
NODE_PATH=~/twa/node_modules node "$(wslpath 'C:\Users\setup\ZCodeProject\MoA_stars\fedev\twa_noint_build.js')"
ls -la *.apk
