#!/usr/bin/env bash
# One-command install: fetches (or updates) osk-dictation into ~/osk-dictation
# and runs install.sh, which sets up OSK Plus as the keyboard.
#   wget -qO- https://raw.githubusercontent.com/electro-sheep/osk-dictation/main/bootstrap.sh | bash
# Options after the pipe: ... | bash -s -- --no-whisper
# (While the repository is private, clone it with `gh repo clone electro-sheep/osk-dictation`
# and run ./install.sh instead.)
set -euo pipefail
DEST="${OSK_DICTATION_DIR:-$HOME/osk-dictation}"
REPO="https://github.com/electro-sheep/osk-dictation.git"

command -v git >/dev/null || { echo "Missing git: sudo apt install git" >&2; exit 1; }
if [ -d "$DEST/.git" ]; then
	git -C "$DEST" pull --ff-only
else
	git clone "$REPO" "$DEST"
fi
exec "$DEST/install.sh" "$@"
