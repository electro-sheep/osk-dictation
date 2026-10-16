#!/usr/bin/env bash
# Installs OSK Plus and switches between it and the original OSK Dictation.
#   switch.sh plus       use OSK Plus
#   switch.sh original   go back to OSK Dictation
# Only one may run at a time. A newly installed extension loads at next login.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EXT_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
PLUS=osk-plus@electro
ORIGINAL=osk-dictation@electro

case "${1:-}" in
plus) on=$PLUS off=$ORIGINAL ;;
original) on=$ORIGINAL off=$PLUS ;;
*) echo "usage: $0 plus|original" >&2; exit 1 ;;
esac

if [ "$on" = "$PLUS" ]; then
	mkdir -p "$EXT_ROOT/$PLUS"
	cp "$HERE"/{metadata.json,extension.js,themes.js} "$EXT_ROOT/$PLUS/"
fi

gnome-extensions disable "$off" 2>/dev/null || true
if gnome-extensions enable "$on" 2>/dev/null; then
	echo "Switched to $on."
else
	# The shell hasn't seen it yet: put it in the list for next login.
	python3 - "$on" "$off" <<'PY'
import sys
from gi.repository import Gio
on, off = sys.argv[1:]
s = Gio.Settings.new("org.gnome.shell")
enabled = [e for e in s.get_strv("enabled-extensions") if e != off]
s.set_strv("enabled-extensions", enabled + ([on] if on not in enabled else []))
Gio.Settings.sync()
PY
	echo "Switched to $on. Log out and back in to load it."
fi
