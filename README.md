# osk-dictation

A better on-screen keyboard for Linux, with voice-to-text built in.

I run Linux on a Surface, and typing on glass is slow. So this gives GNOME a
better on-screen keyboard (**OSK Plus**: swipe typing, word suggestions, copy
and paste, a space-bar cursor, themes that follow your desktop) with a mic key:
tap it, talk, and your words appear in whatever text field has focus. It all
runs offline, on the device.

See [DESIGN.md](DESIGN.md) for the original plan and the speech measurements, and
[variants/osk-plus](variants/osk-plus/README.md) for what the keyboard does.

## Install and use

```bash
curl -fsSL https://raw.githubusercontent.com/electro-sheep/osk-dictation/main/install.sh | bash
```

Then log out and back in once (GNOME on Wayland only loads new extensions at
login) and open the on-screen keyboard. OSK Plus is installed by default; its
settings (the gear) have a **Keyboard style** switch to the classic keyboard
(just a mic key), and `variants/osk-plus/switch.sh plus` switches back. Tap the
mic in the top bar to dictate, and again to stop.

No sudo needed. It wants PipeWire (`pw-record`) and `python3-gi`. To remove
everything: `~/.local/share/osk-dictation/src/uninstall.sh` (add `--purge` to
also delete models and settings).

## How it works

A small Python service owns the microphone and the speech engine, and talks
over the session D-Bus. The keyboard extension and the test client are just
front ends to it.

- **The mic key** sits left of the space bar (which gives up the room) on every
  keyboard layout that has one, and is left out of password fields. Tap to
  start: it turns red once the mic is open, and brightens (its icon growing)
  with your voice. Tap again to stop; the key goes amber while the last phrase
  finishes. It also stops if the keyboard hides.
- **Live text:** the phrase you're speaking appears underlined in the app and
  turns into normal text at each pause. Apps that can't show that (X11 apps, or
  when an IBus input method such as Chinese input is active) show it in the
  keyboard's suggestion bar instead.
- **Switching windows** mid-sentence stops dictation and drops the unfinished
  phrase, so it never lands in the window you switched to.

- **Engine:** [Moonshine](https://github.com/moonshine-ai/moonshine) small
  streaming, which transcribes while you talk, so text arrives about a second
  after you stop. [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
  base.en is the fallback and powers "retry this phrase".
- **Phrases** are finished at each pause and sent as soon as they're done.
- **Spacing and capitals** are fitted to the text before the cursor.
- **Your word lists** fix names and jargon (see below).
- It stops by itself after 8 s without speech, and the service exits after
  10 minutes unused to free the model's memory (~520 MB).

## Developing

```bash
git clone https://github.com/electro-sheep/osk-dictation && cd osk-dictation
./install.sh            # --no-whisper skips the fallback; --no-extension installs only the service
```

Or try it without installing:

```bash
python3 -m venv --system-site-packages .venv   # or: uv venv --system-site-packages .venv
.venv/bin/pip install -e ".[whisper,test]"
.venv/bin/osk-dictation-cli
```

The client starts a service if none is running. Keys: **Space** start/stop,
**r** retry the last phrase with Whisper, **e** switch engine, **x** cancel,
**c** clear, **q** quit. Models download on first use into
`~/.local/share/osk-dictation/models`. Logs: `journalctl --user -u osk-dictation -f`.

## Word lists

Both live in `~/.config/osk-dictation/` and are re-read every time you start
dictating.

- **`words.txt`** — names and jargon, one per line, spelled the way you want
  them. The engine is nudged towards these. It helps when what you said sounds
  close, but isn't guaranteed.
- **`fixes.txt`** — `heard | also heard = Wanted`. Whole-word, case-insensitive
  find-and-replace on everything the engine writes. This always wins.

## Settings

`~/.config/osk-dictation/settings.conf`:

```ini
[dictation]
engine = moonshine-small        ; moonshine-small, moonshine-tiny or whisper-base
auto_stop_seconds = 8.0         ; 0 = never
idle_exit_seconds = 600.0       ; 0 = never
update_interval = 1.0           ; seconds between live updates
```

## D-Bus interface

`io.github.electro_sheep.OskDictation` at `/io/github/electro_sheep/OskDictation`
on the session bus.

| Member | Kind | |
|---|---|---|
| `Prepare()` | method | Load the engine now (call when the keyboard appears). |
| `Start(s context, s purpose)` | method | Start listening. `context` is the text before the cursor; `purpose` `password` is refused. |
| `Stop()` / `Cancel()` | method | Finish and send the last phrase / drop everything. |
| `Retry()` | method | Re-transcribe the last phrase with Whisper; arrives as `Final(text, true)`. |
| `State(s)` | signal | `idle` `loading` `starting` `listening` `finishing` `retrying`, or `error:<reason>` then `idle`. |
| `Partial(s)` | signal | The phrase being spoken (replaces the previous one; `""` clears it). |
| `Final(s text, b replace)` | signal | A finished phrase to insert, already spaced and capitalised. |
| `Level(d)` | signal | Mic loudness 0–1, 20 times a second. |
| `Engine` | property (rw) | Current engine; setting it is saved. |
| `Engines`, `CurrentState`, `Version` | properties | |

## Tests

```bash
.venv/bin/python -m pytest -q
```

The end-to-end tests run the real service over D-Bus, fed from the speech
sample bundled with moonshine-voice instead of the microphone (about a minute).
To feed the service your own recording instead of the mic:
`osk-dictation --audio-file clip.wav`.

The extension has its own test, which needs no logout:

```bash
tests/shell/run.sh [clip.wav] [output-dir]
```

It starts a headless GNOME Shell on a private D-Bus, with its own settings and
extension folders, so your session is untouched. A test-driver extension
clicks the mic key with a virtual pointer while the service plays the clip,
and a GTK text box receives the words. It checks:

- the typed text;
- that live underlined text reached the app (`preedit.log`);
- that the key's colour followed the voice level;
- that switching to a second window mid-sentence cancels without typing
  anything there.

The output folder gets `result.json`, the typed text, logs, and screenshots.
It takes about 90 seconds.
