# OSK Plus

A Gboard-inspired GNOME 46 on-screen keyboard, built on the osk-dictation
service. While enabled, it replaces the standard OSK Dictation keyboard.

## Install

Run this single command in a terminal:

OSK Plus is what `install.sh` installs by default. **Keyboard style** in its settings
(gear) switches to the classic keyboard (the original, with just the mic key).

```bash
curl -fsSL https://raw.githubusercontent.com/electro-sheep/osk-dictation/main/install.sh | bash && bash "${XDG_DATA_HOME:-$HOME/.local/share}/osk-dictation/src/variants/osk-plus/switch.sh" plus
```

This installs the dictation service and OSK Plus. No `sudo` is needed. It
requires GNOME Shell 46, PipeWire (`pw-record`), and `python3-gi`. Log out and
back in once after installation so GNOME loads the new keyboard.

## What you get

- **Top bar:** copy, paste, dictation, settings, and word suggestions.
- **Swipe typing:** slide across the letters; the best match is typed and
  alternatives appear in the bar.
- **Word suggestions:** predictions adapt to what you type and stay on your
  device.
- **Number pad:** `?123` opens the number pad, `#+=` shows symbols, and `ABC`
  returns to letters.
- **Space-bar cursor:** slide on the space bar to move the cursor.
- **Themes and layouts:** colours follow your desktop or a theme you choose;
  portrait and landscape layouts are supported.
- **Dictation:** the mic provides live text and a voice-level meter. Swipe and
  dictation are disabled in password fields.

## Switch keyboards

Only one keyboard variant can be enabled at a time. To switch back to the
standard keyboard:

```bash
bash "${XDG_DATA_HOME:-$HOME/.local/share}/osk-dictation/src/variants/osk-plus/switch.sh" original
```

Switching back for the first time may require logging out and in.

## Remove

Switch back to the standard keyboard, then run the service uninstaller:

```bash
bash "${XDG_DATA_HOME:-$HOME/.local/share}/osk-dictation/src/variants/osk-plus/switch.sh" original
bash "${XDG_DATA_HOME:-$HOME/.local/share}/osk-dictation/src/uninstall.sh"
```

The uninstaller keeps downloaded models and settings by default. To remove
those too, add `--purge`. To remove the now-disabled OSK Plus extension files:

```bash
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/osk-plus@electro"
```

## Test

Run the headless shell test without logging out:

```bash
OSK_VARIANT=plus tests/shell/run.sh
```

For a portrait layout, add `OSK_TEST_MONITOR=800x1280`.
