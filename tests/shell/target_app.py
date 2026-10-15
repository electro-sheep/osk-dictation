"""Text boxes for the headless-shell test to dictate into.

    target_app.py OUT target   "dictation target": mirrors its text to OUT/typed.txt
                               and logs every preedit (live, underlined) update
                               to OUT/preedit.log
    target_app.py OUT other    "other window": mirrors to OUT/other.txt; the test
                               switches to it mid-dictation and checks nothing
                               leaks in

They run as separate processes so they don't race for focus at startup.
"""
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk  # noqa: E402

OUT = Path(sys.argv[1])
ROLE = sys.argv[2]
START_TEXT = "Quick note:"


def text_box(path, start_text="", preedit_log=None):
    view = Gtk.TextView(wrap_mode=Gtk.WrapMode.WORD, left_margin=12, top_margin=12)
    buffer = view.get_buffer()
    buffer.set_text(start_text)
    buffer.place_cursor(buffer.get_end_iter())

    def save(buf):
        path.write_text(buf.get_text(buf.get_start_iter(), buf.get_end_iter(), False))

    buffer.connect("changed", save)
    save(buffer)
    if preedit_log:
        view.connect("preedit-changed", lambda _v, text: preedit_log.open("a").write(text + "\n"))
    return view


def on_activate(app):
    if ROLE == "other":
        win = Gtk.ApplicationWindow(application=app, title="other window")
        win.set_default_size(500, 200)
        view = text_box(OUT / "other.txt")
    else:
        win = Gtk.ApplicationWindow(application=app, title="dictation target")
        win.set_default_size(900, 300)
        view = text_box(OUT / "typed.txt", START_TEXT, OUT / "preedit.log")
    win.set_child(view)
    win.present()
    view.grab_focus()


app = Gtk.Application(application_id=f"io.github.electro_sheep.OskDictationTest.{ROLE}")
app.connect("activate", on_activate)
app.run([])
