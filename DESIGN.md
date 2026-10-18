# OSK Dictation: design

Status: phases 1 to 3 (service, terminal client, keyboard extension with live
text and level meter) built 2026-10-15; see the "as built" sections at the
end for where they differ from this plan. Written for the Surface Go 2 (Ubuntu 24.04+ (now 26.04), GNOME 46-50, Wayland, Core m3-8100Y, 8 GB).

## Goal

Tap a mic key on GNOME's swipe-up on-screen keyboard, talk, and have the words
appear in whatever text field has focus. The words show up while you speak,
everything stays on the device, and it should feel instant on this tablet,
even in Power Saver.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Speech engine | **Moonshine small streaming** (MIT) | It transcribes while you talk, so text arrives 0.6 to 1.2 s after you stop, with 5.2% word errors on your voice ([bench](../whisper-bench/results/summary.md)). It also got your "six" right, which every Whisper model heard as "sex". |
| Fallback engine | **faster-whisper base.en** (int8) | It's the best Whisper option measured: 1.4 to 1.7 s per phrase, 6.5% errors. It's used when you pick it, when Moonshine fails to load, and for "retry this phrase". |
| Names and jargon | **Two layers: a bias list and a fix-up list** | Moonshine's bias list only nudges. In tests it fixed "GNOME Shell" in some runs and not others, and never fixed "Catppuccin". A plain find-and-replace list is the guaranteed layer. |
| Keyboard | **Patch GNOME's own OSK from an extension** | Every existing key, layout, language and the swipe-up gesture stay as they are. A separate keyboard app can't type into other apps on GNOME Wayland. |
| Where the speech engine runs | **A separate user service**, never inside gnome-shell | GNOME Shell does all its work on one thread, so running the engine inside it would freeze the desktop. |
| Service language | **Python first** | Both engines are C++ underneath; the bench showed the glue language doesn't change speed. The service can be ported to C++ or Rust later through Moonshine's C API if its idle memory ever matters. |

## Architecture

```
GNOME Shell                                       Session D-Bus           osk-dictation service (Python, user systemd)
┌────────────────────────────────────┐                                  ┌─────────────────────────────────────────┐
│ extension: osk-dictation@electro   │  Prepare() on keyboard shown ──▶ │ load model in background                │
│                                    │  Start(context, purpose) ──────▶ │ pw-record 16 kHz mono ─▶ engine         │
│  🎤 key in the OSK bottom row      │  Stop() / Cancel() ────────────▶ │                                         │
│  live words  = preedit (underlined)│ ◀─────────── Partial(text) ───── │ Moonshine small streaming               │
│  done phrase = commit into the app │ ◀─────────── Final(text) ─────── │   bias list (set_keyterms)              │
│  level meter on the key            │ ◀─────────── Level(0..1) ─────── │   fix-up list (find and replace)        │
│  undo / retry menu (long-press)    │ ◀─────────── State(name) ─────── │ faster-whisper base.en (fallback/retry) │
└────────────────────────────────────┘  Retry() ──────────────────────▶ └─────────────────────────────────────────┘
```

## 1. Keyboard extension (GJS, `osk-dictation@electro`)

These are the GNOME 46 hook points, checked in `ui/keyboard.js` and `misc/inputMethod.js`:

- **Adding the key.** `Keyboard` is exported from `resource:///org/gnome/shell/ui/keyboard.js`.
  Wrap `Keyboard.prototype._addRowKeys(keys, layout, emojiVisible)` to insert a
  `dictate` key into the bottom row of each level, next to emoji, taking one unit
  of width from the space bar. Capture the created button (by wrapping
  `layout.appendKey` for that call) and connect press, release and long-press.
  On enable or disable, rebuild with `Main.keyboard.keyboardActor?._updateKeys()`.
- **Typing the final text.** Use `keyboard._keyboardController.commit(text)`, the
  same path the emoji panel uses. With no input-method focus (X11 apps) it falls
  back to synthetic key events by itself.
- **Live words.** Use `Main.inputMethod.set_preedit_text(text, cursor, anchor, mode)`
  to show the in-progress phrase underlined in the app. A commit replaces it.
- **Context.** Call `Main.inputMethod.request_surrounding()`, wait for the
  `surrounding-text-set` signal, then `getSurroundingText()` returns
  `[text, cursor]`. This decides spacing and capitals, and the text goes to
  the service.
- **Password fields.** Hide the mic key when the content purpose is `PASSWORD`
  (the keyboard already tracks the purpose for the emoji key).

## 2. Dictation service (`osk-dictation`, Python)

- **Install location.** Its own venv in `~/.local/share/osk-dictation`, with
  `moonshine-voice`, `numpy` and, optionally, `faster-whisper`.
- **Startup and shutdown.** A D-Bus activation file plus a `Type=dbus` systemd user
  unit, so it starts on the first `Prepare()`. It exits after 10 minutes idle,
  which frees the roughly 520 MB the model uses while loaded.
- **D-Bus library.** Use PyGObject's Gio (python3-gi 3.48 is already on the
  system; the venv uses `--system-site-packages`), or `dbus-fast` if that
  causes trouble.
- **Audio.** `pw-record --rate 16000 --channels 1 --format s16 -` writes raw
  samples to stdout, so no PortAudio is needed. The service replaces the first
  100 ms with silence, because the mic codec clicks at full volume for about
  80 ms when it wakes from idle (measured).
- **Engine interface.** `prepare()`, `start(context)`, `feed(pcm)`, `stop()`,
  plus `on_partial` and `on_final` callbacks. There are two implementations:
  - **Moonshine:** `Transcriber.add_audio` in 100 ms chunks with an update interval
    of 1.0 s. `LineTextChanged` becomes `Partial` and `LineCompleted` becomes
    `Final`, so phrases are committed one by one while you talk and nothing
    is lost if something crashes mid-dictation.
  - **Whisper fallback:** run Moonshine's own voice detector with
    `skip_transcription=true` to split phrases, and give each finished phrase's
    audio (`line.audio_data`) to faster-whisper base.en. The live preview shows
    "…" instead of words, because Whisper can't stream.
- **Retry with Whisper.** The service keeps the last phrase's audio (Moonshine
  returns it per line). `Retry()` re-transcribes it with faster-whisper, and
  the extension swaps the text in place.

### D-Bus interface `io.github.electro_sheep.OskDictation`

| Member | Kind | Purpose |
|---|---|---|
| `Prepare()` | method | Load the model now (the keyboard just appeared). |
| `Start(s context, s purpose)` | method | Open the mic and begin a session. `context` is the text around the cursor. |
| `Stop()` | method | Finish the current phrase, send `Final`, close the mic. |
| `Cancel()` | method | Drop everything and close the mic. |
| `Retry()` | method | Re-transcribe the last phrase with the fallback engine; sends `Final` with a `replace` flag. |
| `State(s)` | signal | `idle`, `loading`, `listening`, `finishing`, `error:<reason>` |
| `Partial(s text)` | signal | In-progress phrase (replaces the previous partial). |
| `Final(s text, b replace)` | signal | A finished phrase to commit. |
| `Level(d)` | signal | Mic level 0 to 1, about 20 times per second, for the key animation. |
| `Engine` | property | `moonshine-small`, `moonshine-tiny` or `whisper-base`. |

## 3. User experience

- **Key states.**
  - idle: mic icon
  - loading: spinner (first use only, about 1 s)
  - listening: red, pulsing with your voice
  - finishing: dimmed
  - error: warning icon, plus a notification saying what went wrong
- **Tap** starts and stops dictation.
- **Long-press** opens a small menu: Undo last phrase, Retry with Whisper,
  Engine, Edit word lists.
- **Start delay.** The mic takes about 250 ms to open (measured). Open it on
  touch-down rather than release, and turn the key red only when the first
  audio arrives, so the red key means "talk now".
- **Live text.** The phrase appears underlined as you speak and becomes normal
  text at each pause. Apps that ignore preedit still get each phrase when it's
  finished.
- **Spacing and capitals.** Add a leading space unless the cursor is at the start of the
  field or after whitespace. Lower-case the first letter when continuing a
  sentence (unless the word is on the bias list or is "I"). Put a space
  between consecutive phrases.
- **Auto-stop.** Dictation stops after 8 s of silence, or when the keyboard
  hides or focus moves; whatever was heard is committed first.
- **Undo.** Deletes the last committed phrase (the extension knows its length).
- **Privacy.** Everything runs on the device. GNOME's mic indicator shows while
  listening, the mic key is hidden in password fields, and audio is never
  written to disk.

## 4. Word lists (`~/.config/osk-dictation/`)

- **`words.txt`: bias list.** One term per line, spelled and capitalised the way
  you want to see it (`GNOME Shell`, `FreeCAD`, `Catppuccin`). Moonshine gets it
  through `set_keyterms()` before each `start()`. In a single test each,
  setting it after `start()` or as a load option had no effect. Whisper gets it as
  `hotwords`. It helps when the sound is close but isn't guaranteed.
- **`fixes.txt`: fix-up list.** Lines like `cat pachin | cat per cheen = Catppuccin`
  and `no shell = GNOME Shell`. These are case-insensitive, whole-word
  replacements applied to partial and final text from either engine. This is
  the layer that guarantees names come out right.
- Both files are editable from the extension's preferences page and reloaded on
  every `Start`.
- **Later:** after you edit a dictated phrase, offer to add the correction to
  `fixes.txt`.

## 5. Power and memory

- **CPU while listening.** Moonshine live uses about 2 of the 4 CPU threads while
  you talk: 2.3 cores at 0.5 s updates, 2.0 cores at 1.0 s, with the same wait
  times. Default to 1.0 s.
- **Model memory.** It's loaded only between `Prepare()` and the idle timeout:
  about 520 MB loaded, nothing when the service has exited.
- **Battery option to test.** Moonshine's `decode_incomplete_lines=false` decodes
  only at each pause: no live words, but it should cut CPU sharply. This
  hasn't been measured yet. Switching to Moonshine tiny barely reduced CPU
  (1.9 cores), so it isn't the battery option.

## 6. Measured on this tablet (battery, Power Saver, 7 clips of your voice)

| Engine | Wait after you stop (3 s / 7 s / 17 s clip) | Word errors (155 words) | RAM |
|---|---|---|---|
| Moonshine small streaming, live | 0.6–0.9 / 1.0–1.3 / 1.2–1.9 s | 5.2% | 520 MB |
| Moonshine tiny streaming, live | 0.4 / 0.65–0.9 / 0.4–0.6 s | 7.1–7.7% | 254 MB |
| faster-whisper base.en int8 | 1.4 / 1.5 / 1.7 s | 6.5% | 348 MB |
| faster-whisper small.en int8 | 4.0 / 4.3 / 4.9 s | 3.2% | 803 MB |

Ranges come from two separate runs. Full results and transcripts are in
`../whisper-bench/results/`.

## 7. Risks

- **GNOME upgrades.** `_addRowKeys` and `_keyboardController` are private. Ubuntu
  26.04 (GNOME 50) will likely need small fixes. Keep the patch surface to
  those two, and refuse to enable on an untested GNOME version, with a clear
  message.
- **Preedit support varies.** GTK, Qt, Firefox and Chromium on Wayland should
  show it; some XWayland or Electron apps won't. They still get final phrases.
- **IBus.** An IBus engine with its own preedit (e.g. Chinese input) could clash
  with ours. Disable live text while one is active.
- **Moonshine is young.** The Python package is at 0.1.5 and its API is still
  moving. Pin the version.
- **Memory.** 520 MB loaded, on a machine that had about 3 GB free when
  measured. The idle exit keeps that bounded.

## 8. Build plan

1. **Service and a terminal test client.** Press Enter to talk and see partial
   and final text, with no GNOME involved. This proves the engine, word lists,
   audio and D-Bus API.
2. **Minimal extension.** The mic key, start and stop, final text committed.
   Test in a nested GNOME Shell (`dbus-run-session gnome-shell --nested --wayland`).
3. **Live text and polish.** Preedit, the level meter, the context-aware spacing,
   auto-stop, password-field hiding.
4. **Fallback and editing.** Retry with Whisper, undo, the preferences page for
   the word lists, prepare and idle exit.
5. **Packaging (optional).** A module in the `surface-go2-ubuntu` repo so the
   second tablet gets it too.

## Open questions

Answered 2026-10-15 with the defaults: tap to toggle, auto-stop after 8 s of
silence, commit each phrase at the pause, and a new GitHub repo (not created
yet).

## Phase 1 as built

Differences from the plan above:

- **Spacing and capitals moved into the service.** Every `Partial` and
  `Final` arrives ready to insert, so the extension only has to send the text
  before the cursor in `Start(context, …)` and commit what comes back. This is
  easier to test, and keeps the extension small.
- **Two extra states.** `starting` covers the mic opening (about 250 ms); the
  key should turn red on `listening`. `retrying` covers a Retry.
- **Starting while Prepare is loading is allowed.** Audio queues up until the
  model is ready, so a quick tap after the keyboard appears isn't refused.
- **The Whisper fallback works without the voice detector.** If Moonshine's
  library can't load at all, Whisper transcribes the whole session when it
  stops. If only the Moonshine model fails, the service falls back to
  whisper-base automatically.
- **More properties:** `Engines`, `CurrentState` and `Version`, alongside
  `Engine`.
- **Settings live in `settings.conf`** next to the word lists, and models in
  `~/.local/share/osk-dictation/models`.
- **`--audio-file`** feeds a WAV instead of the mic, for tests and demos.

Phase 1 findings:

- With your names clip, the fix-up list turned "Cat Pachin" into
  "Catppuccin", and the bias list got "GNOME Shell" right. But Moonshine
  sometimes splits a word across a pause ("Catppuccin. In. Theme"), and a
  fix-up can't reach across two phrases.
- On battery in Power Saver, the final phrase arrived 1.1 to 2.2 s after
  Stop in end-to-end runs. The bench measured 0.6 to 1.9 s for the engine
  alone.

## Phase 2 as built

The extension (`extension/`, GNOME Shell 46) follows section 1, with these
details:

- **Placement.** The key goes immediately left of the space bar on any row that
  has one at least 3 units wide. It takes 1.5 units from the space bar (1 unit
  on the narrower symbol rows), so the other keys keep their size.
- **Hiding.** It is left out when the field's purpose is `PASSWORD`. Clutter in
  GNOME 46 has no `PIN` purpose; an undefined entry in the hide list hid the
  key whenever the purpose was unknown (for example, the keyboard swiped up
  with nothing focused). The headless test caught this.
- **Tap timing.** It reacts on touch-down (`pressed`). The key shows amber at
  once, red on `listening`, amber again on `finishing`.
- **When the keyboard opens and closes.** `Prepare()` is sent each time the keyboard
  becomes visible; if it hides while listening, `Stop()` is sent.
- **Errors.** Error states and refused calls show as a GNOME notification
  titled "Dictation". A refused `Prepare()` is only logged.
- **Not yet.** Partial text (preedit), the level meter, and `Final(…, replace)`
  for Retry are ignored until phases 3 and 4.
- **Install.** `install.sh` copies the extension and adds it to
  `enabled-extensions`. On Wayland it only loads after the next login.

Testing without logging out: `tests/shell/run.sh` runs a headless GNOME Shell
(`--headless --virtual-monitor 1280x800 --mode=user`) inside `dbus-run-session`,
with `XDG_CONFIG_HOME` and `XDG_DATA_HOME` pointed at the test folder, so
settings and extensions are separate from the real session. A test-driver
extension clicks the key with a Clutter virtual pointer. In the first passing
run, the key went red 0.16 s after the click, and the text was typed 1.2 s
after the second click.

## Phase 3 as built

- **Live text.** `Partial` goes to
  `Main.inputMethod.set_preedit_text(text, len, len, Clutter.PreeditResetMode.CLEAR)`.
  CLEAR rather than COMMIT, because a COMMIT preedit gets typed by the system
  when the field resets (for example, you tap to move the cursor). The `Final`
  for the same phrase would then type it a second time. With CLEAR the preview
  just vanishes, and the finished phrase is typed when it arrives. Before each
  commit, the preedit is cleared.
- **Fallback.** The preedit is used only when the input method has focus,
  `can-show-preedit` is true, and the input source isn't an IBus engine.
  Otherwise the partial goes to the keyboard's suggestion bar, trimmed to the
  last 60 characters.
- **Level meter.** `Level` (20 a second) is smoothed: it jumps up with the voice
  and decays by ×0.7 per update. While listening, the key's background moves
  from rgb(165, 29, 45) to rgb(255, 80, 80), and the icon scales up to 1.35×.
  This is an inline style, cleared when listening ends.
- **Window switches.** The focused window is recorded at Start. If
  `notify::focus-window` reports a different window during a session, the
  extension clears the live text, sends `Cancel`, ignores any `Final` still in
  flight, and shows a notification. Phrases already typed stay; only the
  unfinished one is lost. Moving to another field in the same window is
  allowed: text goes where the cursor now is.
- **Small polish.**
  - The key's accessible name is "Dictate".
  - A missing service gives a "run install.sh" message instead of the raw D-Bus
    error.
  - `install.sh` says when an updated extension needs a re-login.

Test additions: `tests/shell/run.sh` now also checks the preedit updates the
GTK view saw (via `preedit-changed`), how many key colours appeared while
listening, and the window-switch case. That case uses a second window in a
separate process: two windows from one process raced for focus at startup,
and the "focused" window and the one receiving text briefly disagreed. In the
passing run:

- 25 preedit updates reached the app;
- the key showed 84 colours;
- the switch was cancelled within 1.3 s, with nothing typed in the other window.
