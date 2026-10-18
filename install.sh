#!/usr/bin/env bash
# Installs the osk-dictation service and keyboard for the current user (no sudo needed):
#   ~/.local/share/osk-dictation/venv      Python environment with the engines
#   ~/.local/share/osk-dictation/models    speech models (downloaded on first use)
#   ~/.config/systemd/user/                systemd unit
#   ~/.local/share/dbus-1/services/        D-Bus auto-start entry
#   ~/.local/bin/osk-dictation-cli         terminal test client
#   ~/.local/share/gnome-shell/extensions/osk-plus@electro        the keyboard (default)
#   ~/.local/share/gnome-shell/extensions/osk-dictation@electro   the classic keyboard
#                                          (switch between them in the keyboard's settings)
# Options:
#   --no-whisper    skip the faster-whisper fallback (saves ~300 MB)
#   --no-extension  install only the service
set -euo pipefail

HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/osk-dictation"

# Run via `curl ... | bash`: fetch the source into $DATA/src and run from there.
if [ -z "$HERE" ] || [ ! -f "$HERE/pyproject.toml" ]; then
	command -v curl >/dev/null || { echo "Missing curl" >&2; exit 1; }
	echo "Downloading osk-dictation..."
	mkdir -p "$DATA/src"
	curl -fsSL https://github.com/electro-sheep/osk-dictation/archive/refs/heads/main.tar.gz |
		tar -xz -C "$DATA/src" --strip-components=1
	exec bash "$DATA/src/install.sh" "$@"
fi
VENV="$DATA/venv"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DBUS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services"
EXT_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
PLUS_UUID="osk-plus@electro"
CLASSIC_UUID="osk-dictation@electro"
EXTRAS="[whisper]"
WITH_EXTENSION=1
for arg in "$@"; do
	case "$arg" in
	--no-whisper) EXTRAS="" ;;
	--no-extension) WITH_EXTENSION=0 ;;
	*) echo "Unknown option $arg" >&2; exit 1 ;;
	esac
done

need() { command -v "$1" >/dev/null || { echo "Missing $1: $2" >&2; exit 1; }; }
need pw-record "install pipewire-bin"
need python3 "install python3"
python3 -c "import gi; gi.require_version('Gio', '2.0')" 2>/dev/null || {
	echo "Missing PyGObject: sudo apt install python3-gi" >&2
	exit 1
}

# uv builds the venv; Ubuntu's python3 has no venv/pip without extra packages.
UV="$(command -v uv || true)"
if [ -z "$UV" ]; then
	UV="$DATA/uv"
	if [ ! -x "$UV" ]; then
		echo "Downloading uv..."
		mkdir -p "$DATA"
		curl -fsSL https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz |
			tar -xz -C "$DATA" --strip-components=1 uv-x86_64-unknown-linux-gnu/uv
	fi
fi

echo "Creating $VENV..."
"$UV" venv --quiet --allow-existing --system-site-packages --python /usr/bin/python3 "$VENV"
"$UV" pip install --quiet --python "$VENV/bin/python" "$HERE$EXTRAS"

echo "Installing the systemd unit and D-Bus entry..."
mkdir -p "$UNIT_DIR" "$DBUS_DIR" "$HOME/.local/bin"
sed -e "s|@VENV@|$VENV|g" -e "s|@PREFIX@|$HERE|g" "$HERE/data/osk-dictation.service" > "$UNIT_DIR/osk-dictation.service"
sed -e "s|@VENV@|$VENV|g" "$HERE/data/io.github.electro_sheep.OskDictation.service" \
	> "$DBUS_DIR/io.github.electro_sheep.OskDictation.service"
ln -sf "$VENV/bin/osk-dictation-cli" "$HOME/.local/bin/osk-dictation-cli"
systemctl --user daemon-reload
# A running copy keeps the old code until it exits; restart it so this install takes effect.
systemctl --user try-restart osk-dictation.service 2>/dev/null || true

echo "Fetching speech models (skipped if already present)..."
"$VENV/bin/python" - <<'EOF'
import moonshine_voice as mv
from osk_dictation.config import models_dir
for arch in (mv.ModelArch.SMALL_STREAMING, mv.ModelArch.TINY):
    mv.get_model_for_language("en", arch, cache_root=models_dir() / "moonshine", on_progress=lambda f, n: None)
try:
    from osk_dictation.engines import Whisper
    Whisper().load()
except ImportError:
    pass
EOF

RELOGIN=0
if [ $WITH_EXTENSION -eq 1 ]; then
	echo "Installing the keyboards..."
	mkdir -p "$EXT_ROOT/$PLUS_UUID" "$EXT_ROOT/$CLASSIC_UUID"
	for f in metadata.json extension.js themes.js; do
		# GNOME Shell keeps an extension's code loaded until logout, so note any change.
		cmp -s "$HERE/variants/osk-plus/$f" "$EXT_ROOT/$PLUS_UUID/$f" || RELOGIN=1
		cp "$HERE/variants/osk-plus/$f" "$EXT_ROOT/$PLUS_UUID/"
	done
	for f in metadata.json extension.js stylesheet.css; do
		cmp -s "$HERE/extension/$f" "$EXT_ROOT/$CLASSIC_UUID/$f" || RELOGIN=1
		cp "$HERE/extension/$f" "$EXT_ROOT/$CLASSIC_UUID/"
	done
	# Only one keyboard patch may run at a time. OSK Plus is the default; if the
	# classic one is already the user's choice, that choice is kept.
	python3 - "$PLUS_UUID" "$CLASSIC_UUID" <<'EOF'
import sys
from gi.repository import Gio
plus, classic = sys.argv[1:]
settings = Gio.Settings.new("org.gnome.shell")
enabled = settings.get_strv("enabled-extensions")
if True:  # OSK Plus (Gboard-style) is the keyboard; drop the classic one
    enabled = [e for e in enabled if e != classic]
    if plus not in enabled:
        enabled.append(plus)
    settings.set_strv("enabled-extensions", enabled)
Gio.Settings.sync()
EOF
	# GNOME on Wayland only discovers new extensions at login.
	gnome-extensions list --enabled 2>/dev/null | grep -Eqx "$PLUS_UUID|$CLASSIC_UUID" || RELOGIN=1
fi

echo
echo "Installed. Try the service: osk-dictation-cli"
if [ $RELOGIN -eq 1 ]; then
	echo "Log out and back in to load the keyboard."
fi
echo "Logs: journalctl --user -u osk-dictation -f"
