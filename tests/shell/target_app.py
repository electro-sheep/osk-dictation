"""A text box for the headless-shell test to dictate into; mirrors its text to a file."""
import sys

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk  # noqa: E402

OUT = sys.argv[1]
START_TEXT = "Quick note:"


def save(buffer):
    with open(OUT, "w") as f:
        f.write(buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), False))


def on_activate(app):
    win = Gtk.ApplicationWindow(application=app, title="dictation target")
    win.set_default_size(900, 300)
    view = Gtk.TextView(wrap_mode=Gtk.WrapMode.WORD, left_margin=12, top_margin=12)
    buffer = view.get_buffer()
    buffer.set_text(START_TEXT)
    buffer.place_cursor(buffer.get_end_iter())
    buffer.connect("changed", save)
    save(buffer)
    win.set_child(view)
    win.present()
    view.grab_focus()


app = Gtk.Application(application_id="io.github.electro_sheep.OskDictationTarget")
app.connect("activate", on_activate)
app.run([])
