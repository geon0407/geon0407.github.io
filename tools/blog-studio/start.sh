#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ ! -x tools/blog-studio/.venv/bin/python ]; then
  python3 -m venv tools/blog-studio/.venv
fi
tools/blog-studio/.venv/bin/python -m pip install -q -r tools/blog-studio/requirements.txt
exec tools/blog-studio/.venv/bin/python tools/blog-studio/server.py "$@"
