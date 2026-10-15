#!/usr/bin/env bash
# Removes what install.sh added. Your word lists and settings in
# ~/.config/osk-dictation and the downloaded models are kept unless you pass --purge.
set -euo pipefail

DATA="${XDG_DATA_HOME:-$HOME/.local/share}/osk-dictation"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/osk-dictation.service"
DBUS="${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services/io.github.electro_sheep.OskDictation.service"
EXT_UUID="osk-dictation@electro"

gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
python3 - "$EXT_UUID" <<'PY'
import sys
from gi.repository import Gio
settings = Gio.Settings.new("org.gnome.shell")
enabled = settings.get_strv("enabled-extensions")
if sys.argv[1] in enabled:
    settings.set_strv("enabled-extensions", [e for e in enabled if e != sys.argv[1]])
Gio.Settings.sync()
PY
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$EXT_UUID"

systemctl --user stop osk-dictation.service 2>/dev/null || true
rm -f "$UNIT" "$DBUS"
[ -L "$HOME/.local/bin/osk-dictation-cli" ] && rm "$HOME/.local/bin/osk-dictation-cli"
rm -rf "$DATA/venv" "$DATA/uv"
systemctl --user daemon-reload

if [ "${1:-}" = "--purge" ]; then
	rm -rf "$DATA" "${XDG_CONFIG_HOME:-$HOME/.config}/osk-dictation"
	echo "Removed everything, including models, word lists and settings."
else
	echo "Removed. Kept $DATA/models and ~/.config/osk-dictation (use --purge to delete them)."
fi
