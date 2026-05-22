#!/bin/bash
set -e
apt-get update -qq
apt-get install -y ffmpeg
curl -fsSL https://deno.land/install.sh | sh
pip install -r requirements.txt
