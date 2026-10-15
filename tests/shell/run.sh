#!/usr/bin/env bash
# Runs the keyboard extension in a headless GNOME Shell with its own private
# D-Bus and its own settings, so your desktop session is untouched. A test
# driver extension clicks the mic key; the service is fed a WAV instead of the
# microphone; a GTK text box receives the text.
#
#   tests/shell/run.sh [WAV] [OUTPUT_DIR]
#
# Results land in OUTPUT_DIR: result.json, typed.txt, screenshots, logs.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PY="$ROOT/.venv/bin/python"
WAV="${1:-$("$PY" -c 'import moonshine_voice, pathlib; print(pathlib.Path(moonshine_voice.__file__).parent / "assets/two_cities.wav")')}"
OUT="${2:-$(mktemp -d -t osk-shell-test.XXXXXX)}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
rm -f "$OUT"/result.json "$OUT"/typed.txt "$OUT"/other.txt "$OUT"/preedit.log "$OUT"/*.png

if [ "${OSK_TEST_INSIDE:-}" != 1 ]; then
	# Separate settings and extension folders for everything in the test session.
	REAL_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/osk-dictation"
	mkdir -p "$OUT/config" "$OUT/data/gnome-shell/extensions"
	ln -sfn "$ROOT/extension" "$OUT/data/gnome-shell/extensions/osk-dictation@electro"
	ln -sfn "$HERE/osk-test-driver@electro" "$OUT/data/gnome-shell/extensions/osk-test-driver@electro"
	export XDG_CONFIG_HOME="$OUT/config" XDG_DATA_HOME="$OUT/data" OSK_DICTATION_DATA_DIR="$REAL_DATA"
	unset WAYLAND_DISPLAY DISPLAY
	OSK_TEST_INSIDE=1 exec dbus-run-session -- "$0" "$WAV" "$OUT"
fi

cleanup() { kill $(jobs -p) 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT

gsettings set org.gnome.shell enabled-extensions "['osk-dictation@electro', 'osk-test-driver@electro']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings set org.gnome.desktop.a11y.applications screen-keyboard-enabled true

HF_HUB_OFFLINE=1 "$PY" -m osk_dictation --audio-file "$WAV" --idle-exit 0 --auto-stop 0 >"$OUT/service.log" 2>&1 &
until grep -q ready "$OUT/service.log" 2>/dev/null; do sleep 0.2; done

DISPLAY_NAME="osk-test-$$"
OSK_TEST_OUT="$OUT" gnome-shell --mode=user --headless --wayland --no-x11 --virtual-monitor 1280x800 \
	--wayland-display "$DISPLAY_NAME" >"$OUT/shell.log" 2>&1 &
for _ in $(seq 100); do [ -S "$XDG_RUNTIME_DIR/$DISPLAY_NAME" ] && break; sleep 0.1; done

export WAYLAND_DISPLAY="$DISPLAY_NAME" GDK_BACKEND=wayland
python3 "$HERE/target_app.py" "$OUT" other >"$OUT/other-app.log" 2>&1 &
sleep 3
python3 "$HERE/target_app.py" "$OUT" target >"$OUT/app.log" 2>&1 &

for _ in $(seq 1500); do [ -f "$OUT/result.json" ] && break; sleep 0.1; done
[ -f "$OUT/result.json" ] || echo '{"ok": false, "error": "no result after 150 s"}' >"$OUT/result.json"

echo "Output: $OUT"
cat "$OUT/result.json"
echo
echo "Typed into the text box: $(cat "$OUT/typed.txt" 2>/dev/null)"
echo "Live (preedit) updates the app saw: $(grep -c . "$OUT/preedit.log" 2>/dev/null || echo 0)"
echo "Typed into the other window: '$(cat "$OUT/other.txt" 2>/dev/null)'"
