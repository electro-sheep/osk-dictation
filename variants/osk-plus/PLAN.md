# Gboard-style variant: plan

Status: built 2026-10-16 as OSK Plus (see variants/osk-plus/README.md) in one update instead of phases. This file is kept as the original plan.

## Ground rules

- **The working version stays untouched.** `extension/` (`osk-dictation@electro`)
  on `main` is the keyboard you use every day. The variant is a separate
  extension, `osk-gboard@electro`, in `variants/gboard/`, developed on the
  `gboard-variant` branch. It starts as a copy of the working extension and
  changes from there.
- **Only one runs at a time.** Both patch the same GNOME keyboard, so the
  variant refuses to start while `osk-dictation@electro` is enabled and says
  why. Switching is two commands (disable one, enable the other). After both
  have been installed and loaded once, switching needs no logout.
- **One shared dictation service.** Its D-Bus API only gains new methods
  (for swipe typing and suggestions). Nothing existing changes, so the working
  extension keeps working against it.
- **Every step is tested before it reaches your session.** The headless GNOME
  Shell test (`tests/shell/run.sh`) is extended for the variant, with
  screenshots of each design change for you to approve.

## What to borrow from Gboard

| Gboard feature | How it maps onto GNOME's keyboard | Effort | Phase |
|---|---|---|---|
| Flat rounded keys, letter keys lighter than function keys, accent-coloured Enter, small gaps, clean font | Stylesheet for `.keyboard-key` and friends | Small | A |
| Gboard layout: bottom row `?123 · , · space · . · Enter`, emoji on long-press of comma, optional number row | Rewrite each row as GNOME builds it (the same hook the mic key uses) | Small–medium | A |
| Mic in the top strip, as in Gboard, giving the space bar its width back | Move the dictation key into the strip above the keys | Small | A |
| Top strip: tools when idle (mic, emoji, clipboard, settings), three word suggestions while typing, middle one bold | Take over GNOME's suggestion bar | Medium | B |
| Letter bubble above the key when pressed; small hint characters on keys with long-press extras | Hooks on each key's press and release; small label overlays | Medium | B |
| Slide along the space bar to move the cursor; slide left from Backspace to delete whole words, with a brief undo | Touch tracking on those two keys, sending arrow keys or Ctrl+Backspace | Medium | B |
| Word suggestions and completion while tapping | Service: prefix lookup in a frequency-ranked word list plus your `words.txt`; the extension reads the current word from the text around the cursor | Medium–large | C |
| Glide (swipe) typing with a trail | See below | Large | D |
| Later: one-handed and floating modes, keyboard height setting, theme picker | Layout and stylesheet options | Medium | Later |

The Surface Go 2 has no vibration motor, so Gboard's haptic feedback isn't
possible. A soft click sound could stand in, if you want one.

## Swipe typing

No GNOME keyboard extension does this yet (searched 2026-10-16), so this part
is new ground. The algorithm is not. FlorisBoard, an open-source Android
keyboard (Apache-2.0), has a proven statistical glide classifier. Its
approach, which we would port with credit:

1. **Narrow the dictionary.** Keep only words whose first and last letters are
   among the two keys nearest where the swipe started and ended, then drop words
   whose ideal path length is far off the swipe's length.
2. **Compare paths.** Resample the swipe and each word's ideal key-to-key path
   to the same number of points, then measure two distances:
   - **shape**: both paths scaled to the same size;
   - **location**: on the actual keyboard.
3. **Score.** Turn both distances into Gaussian probabilities and multiply
   them by the word's frequency. The best three words win.

How it would fit our pieces:

- **Extension.** The swipe is noticed once a finger leaves the key it went down
  on. That key's press is cancelled, a fading trail is drawn over the keys, and
  the touch points are collected. On release, the extension sends the path and
  the key centres to the service. The best word is typed (with a space before
  it if needed), and the next two go in the top strip for a one-tap swap.
  Ordinary taps behave exactly as now.
- **Service.** A NumPy port of the classifier, with the ideal paths cached per
  layout. It runs in the service rather than inside GNOME Shell, so a slow
  lookup can never freeze the desktop.
- **Dictionary.** Words ranked by how common they are, from the `wordfreq`
  package (MIT code, CC-BY-SA data), limited to British spellings from
  `/usr/share/dict/british-english`, plus your own names from `words.txt`.
- **Speed target.** Under 50 ms per word on the m3, to be measured like the
  speech engines were.
- **Improvements over FlorisBoard, later:** favour words that commonly follow the
  previous word, learn from the corrections you pick, and add new words you
  type.

## Phases

- **A. The look and the layout.** The variant extension is set up, with the
  Gboard-style stylesheet, the Gboard bottom row and the mic in the top strip.
  Delivered as before/after screenshots from the headless shell. You switch to
  it in your real session only when you like it.
- **B. Feel.** Key bubbles, long-press hints, space-bar cursor, Backspace
  swipe, top-strip tools.
- **C. Suggestions** while tapping.
- **D. Swipe typing.**

Each phase ends with a passing headless test and a commit on `gboard-variant`.
The variant replaces the original on `main` only when you say so.

## Open questions

1. Colours: Gboard's own light and dark (following GNOME's dark style), or
   matching your Catppuccin theme?
2. Number row: always shown, or off as in Gboard's default?
3. Mic: in the top strip as in Gboard, or keep it beside the space bar?
4. Swipe typing dictionary: British English only?

## Related: the keyboard not opening in the Claude app

This isn't caused by our extension.

**Why it happens.** Claude's desktop app is Electron 44 running natively on
Wayland. It isn't started with Chromium's input-method switches
(`--enable-wayland-ime --wayland-text-input-version=3`), so it never tells
GNOME that a text box has focus. Even with those switches, Chromium-based apps
on GNOME currently send the "text box focused" message without GNOME opening
the keyboard. That's an open upstream Chromium bug.

**What works today.**
- Swipe up from the bottom edge to open the keyboard. Typing then works.
- Dictation also works: phrases are typed as key presses, and the live text
  shows in the suggestion bar, because the app can't show underlined text.

**Possible fixes to try later (not in phases A to D):**
- Launch Claude with those switches through a small wrapper in `~/.local/bin`.
  That would give underlined live text and context inside Claude.
- Have the variant open the keyboard itself when you tap into a Chromium app's
  text box.
