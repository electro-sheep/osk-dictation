# OSK Plus

A reworked GNOME 46 on-screen keyboard, built on the osk-dictation service.
It takes ideas from Gboard and matches your desktop. While it's enabled it
replaces OSK Dictation (`extension/`), which stays as it was.

- **Top bar:** copy, paste, mic (dictation with live underlined text and a level
  meter) and settings. Copy and paste send Ctrl+C / Ctrl+V, or Ctrl+Shift+C / V
  in terminals.
- **Swipe typing:** slide across the letters. A trail follows your finger. The
  best word is typed and two alternatives appear in the bar; tap one to swap.
  Spacing and capitals follow the text before the cursor. The service matches
  your path against about 44,000 British English words plus your `words.txt`
  (method after FlorisBoard's, Apache-2.0).
- **Word suggestions:** the bar completes the word you're typing and, after a
  space, predicts the next one (best guess bold in the middle). It learns what
  you type after which word, kept only on this machine in
  `~/.local/share/osk-dictation/history.json`, and knows Linux commands, which
  get a lift in terminals. Swipe guesses use the same context, and the word the
  path spells so far shows live while you swipe.
- **Number pad:** `?123` opens a calculator-style pad; `#+=` has all the
  symbols; `ABC` returns.
- **Terminals:** with nothing to suggest, the bar offers Esc, Tab, Ctrl+C, ↑, ↓
  and Ctrl+R.
- **Space-bar cursor:** press the space bar and slide left or right to move the
  cursor one character per step.
- **Colours:** by default they follow your desktop (the Open Bar panel colours
  and accent). Settings (gear) offers themes, accents, the landscape layout and the keyboard layout (language).
  Choices are saved in `~/.config/osk-dictation/keyboard.json`.
- **Rotation:** in portrait, full-width keys; in landscape, a split layout for
  two thumbs (or full width, set in settings).
- **Hidden in password fields:** swipe and the mic are off there.

```bash
variants/osk-plus/switch.sh plus       # use OSK Plus (log out and in the first time)
variants/osk-plus/switch.sh original   # back to OSK Dictation
```

Test without logging out: `OSK_VARIANT=plus tests/shell/run.sh`. Add
`OSK_TEST_MONITOR=800x1280` for portrait.
