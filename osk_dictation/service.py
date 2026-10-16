"""The D-Bus service the keyboard extension talks to."""
import argparse
import re
import logging
import signal
import sys
import threading
import time

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

from . import BUS_NAME, INTERFACE, OBJECT_PATH, __version__  # noqa: E402
from .audio import MicCapture, file_capture_for  # noqa: E402
from .config import ENGINES, Settings, ensure_user_files  # noqa: E402
from .config import config_dir  # noqa: E402
from .dictation import Dictation  # noqa: E402
from .textfmt import format_phrase  # noqa: E402
from .wordlists import load_words  # noqa: E402

log = logging.getLogger("osk_dictation")

INTROSPECTION = f"""
<node>
  <interface name="{INTERFACE}">
    <method name="Prepare"/>
    <method name="Start">
      <arg name="context" type="s" direction="in"/>
      <arg name="purpose" type="s" direction="in"/>
    </method>
    <method name="Stop"/>
    <method name="Cancel"/>
    <method name="Retry"/>
    <method name="GlideLayout">
      <arg name="keys" type="a{{s(dd)}}" direction="in"/>
      <arg name="radius" type="d" direction="in"/>
    </method>
    <method name="Glide">
      <arg name="points" type="a(dd)" direction="in"/>
      <arg name="before" type="s" direction="in"/>
      <arg name="purpose" type="s" direction="in"/>
      <arg name="words" type="as" direction="out"/>
    </method>
    <method name="Suggest">
      <arg name="before" type="s" direction="in"/>
      <arg name="purpose" type="s" direction="in"/>
      <arg name="words" type="as" direction="out"/>
    </method>
    <signal name="State"><arg name="state" type="s"/></signal>
    <signal name="Partial"><arg name="text" type="s"/></signal>
    <signal name="Final"><arg name="text" type="s"/><arg name="replace" type="b"/></signal>
    <signal name="Level"><arg name="level" type="d"/></signal>
    <property name="Engine" type="s" access="readwrite"/>
    <property name="Engines" type="as" access="read"/>
    <property name="CurrentState" type="s" access="read"/>
    <property name="Version" type="s" access="read"/>
  </interface>
</node>
"""

SIGNALS = {"state": ("State", "(s)"), "partial": ("Partial", "(s)"),
           "final": ("Final", "(sb)"), "level": ("Level", "(d)")}


class GlideTyping:
    """Swipe typing and word suggestions: a word list, ideal paths per key layout,
    and a predictor that learns which words you type after which."""

    def __init__(self):
        self._lock = threading.Lock()
        self._lexicon = None
        self._predictor = None
        self._layouts = {}
        self._current = None

    def set_layout(self, keys, radius):
        signature = (tuple(sorted((c, round(x), round(y)) for c, (x, y) in keys.items())), round(radius))
        self._current = signature
        threading.Thread(target=self._layout, args=(signature, keys, radius), daemon=True).start()

    def _ensure_lexicon(self):
        from .glide import load_lexicon
        from .predict import LINUX_WORDS, Predictor

        if self._lexicon is None:
            self._lexicon = load_lexicon(load_words(config_dir() / "words.txt") + LINUX_WORDS)
            self._predictor = Predictor(*self._lexicon)
            log.info("swipe typing and suggestions: %d words", len(self._lexicon[0]))

    def _layout(self, signature, keys=None, radius=None):
        from .glide import Layout

        with self._lock:
            if signature not in self._layouts:
                self._ensure_lexicon()
                if keys is None:
                    raise RuntimeError("no keyboard layout sent yet")
                self._layouts = {k: v for k, v in self._layouts.items() if k == self._current}  # keep two
                self._layouts[signature] = Layout(keys, radius, *self._lexicon)
            return self._layouts[signature]

    def _reply(self, invocation, work):
        def run():
            try:
                result = work()
                GLib.idle_add(lambda: invocation.return_value(GLib.Variant("(as)", (result,))) and False)
            except Exception as e:
                log.exception("keyboard request failed")
                GLib.idle_add(lambda: invocation.return_dbus_error(f"{INTERFACE}.Error", str(e)) and False)

        threading.Thread(target=run, daemon=True).start()

    def answer(self, invocation, points, before, purpose="normal"):
        def work():
            if self._current is None:
                raise RuntimeError("no keyboard layout sent yet")
            layout = self._layout(self._current)
            words = re.findall(r"[A-Za-z][A-Za-z']*", before[-200:])
            prev = words[-1] if words and not (before[-1:].isalpha()) else None
            # Re-rank the best path matches by what usually follows the previous word.
            ranked = sorted(layout.candidates(points, count=10, scores=True),
                            key=lambda ws: ws[1] + self._predictor.context(prev, ws[0], purpose), reverse=True)
            top = [w for w, _ in ranked[:3]]
            keep = set(load_words(config_dir() / "words.txt")) | {w for w in top if w[:1].isupper()}
            return [format_phrase(w, before, keep) for w in top]

        self._reply(invocation, work)

    def suggest(self, invocation, before, purpose):
        def work():
            with self._lock:
                self._ensure_lexicon()
            return self._predictor.suggest(before, purpose)

        self._reply(invocation, work)

    def save(self):
        if self._predictor:
            self._predictor.save()


class Service:
    def __init__(self, settings, bus_name=BUS_NAME, capture_factory=MicCapture):
        self.loop = GLib.MainLoop()
        self.exit_code = 0
        self.dictation = Dictation(settings, self._emit_from_thread, capture_factory)
        self.glide = GlideTyping()
        self._conn = None
        self._owns_name = False
        Gio.bus_own_name(Gio.BusType.SESSION, bus_name, Gio.BusNameOwnerFlags.DO_NOT_QUEUE,
                         self._on_bus_acquired, self._on_name_acquired, self._on_name_lost)
        GLib.timeout_add_seconds(30, self._check_idle)
        for sig in (signal.SIGINT, signal.SIGTERM):
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, self._quit)

    def run(self):
        self.loop.run()
        self.dictation.shutdown()
        self.glide.save()
        return self.exit_code

    def _quit(self):
        self.loop.quit()
        return GLib.SOURCE_REMOVE

    def _on_bus_acquired(self, conn, name):
        self._conn = conn
        info = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION).interfaces[0]
        conn.register_object(OBJECT_PATH, info, self._on_call, self._on_get, self._on_set)

    def _on_name_acquired(self, conn, name):
        self._owns_name = True
        log.info("osk-dictation %s ready on %s (engine %s)", __version__, name, self.dictation.engine_name)

    def _on_name_lost(self, conn, name):
        if not self._owns_name:
            log.error("%s is already taken; is another osk-dictation running?", name)
            self.exit_code = 1
        else:
            log.info("lost %s, exiting", name)
        self.loop.quit()

    def _on_call(self, conn, sender, path, iface, method, params, invocation):
        log.debug("%s%s from %s", method, params.unpack(), sender)
        try:
            if method == "Prepare":
                self.dictation.prepare()
            elif method == "Start":
                self.dictation.start(*params.unpack())
            elif method == "Stop":
                self.dictation.stop()
            elif method == "Cancel":
                self.dictation.cancel()
            elif method == "Retry":
                self.dictation.retry()
            elif method == "GlideLayout":
                self.glide.set_layout(*params.unpack())
            elif method == "Glide":
                self.dictation.last_used = time.monotonic()
                self.glide.answer(invocation, *params.unpack())
                return
            elif method == "Suggest":
                self.dictation.last_used = time.monotonic()
                self.glide.suggest(invocation, *params.unpack())
                return
            invocation.return_value(None)
        except Exception as e:
            log.info("%s refused: %s", method, e)
            invocation.return_dbus_error(f"{INTERFACE}.Error", str(e))

    def _on_get(self, conn, sender, path, iface, prop):
        if prop == "Engine":
            return GLib.Variant("s", self.dictation.engine_name)
        if prop == "Engines":
            return GLib.Variant("as", list(ENGINES))
        if prop == "CurrentState":
            return GLib.Variant("s", self.dictation.state)
        if prop == "Version":
            return GLib.Variant("s", __version__)
        return None

    def _on_set(self, conn, sender, path, iface, prop, value):
        if prop != "Engine":
            return False
        try:
            self.dictation.set_engine(value.unpack())
        except Exception as e:
            log.info("engine change refused: %s", e)
            return False
        conn.emit_signal(None, OBJECT_PATH, "org.freedesktop.DBus.Properties", "PropertiesChanged",
                         GLib.Variant("(sa{sv}as)", (INTERFACE, {"Engine": GLib.Variant("s", value.unpack())}, [])))
        return True

    def _emit_from_thread(self, kind, *args):
        GLib.idle_add(self._emit, kind, args)

    def _emit(self, kind, args):
        if kind == "state":
            log.info("state %s", args[0])
        elif kind == "final":
            log.debug("final %r replace=%s", *args)
        if self._conn is not None:
            name, signature = SIGNALS[kind]
            self._conn.emit_signal(None, OBJECT_PATH, INTERFACE, name, GLib.Variant(signature, args))
        return GLib.SOURCE_REMOVE

    def _check_idle(self):
        limit = self.dictation.settings.idle_exit_seconds
        if limit > 0 and not self.dictation.busy and time.monotonic() - self.dictation.last_used > limit:
            log.info("idle for %.0f s, exiting", limit)
            self.loop.quit()
            return GLib.SOURCE_REMOVE
        return GLib.SOURCE_CONTINUE


def main(argv=None):
    p = argparse.ArgumentParser(prog="osk-dictation", description="Offline dictation service for the on-screen keyboard.")
    p.add_argument("--engine", choices=ENGINES, help="engine to use (saved as the new default)")
    p.add_argument("--auto-stop", type=float, metavar="SECONDS", help="stop after this long without speech (0 = never)")
    p.add_argument("--idle-exit", type=float, metavar="SECONDS", help="exit after this long unused (0 = never)")
    p.add_argument("--audio-file", metavar="WAV", help="read this 16 kHz mono WAV instead of the microphone (testing)")
    p.add_argument("--bus-name", default=BUS_NAME, help=argparse.SUPPRESS)
    p.add_argument("-v", "--verbose", action="store_true", help="log every call and phrase")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, stream=sys.stderr,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    ensure_user_files()
    settings = Settings.load()
    if args.engine:
        settings.engine = args.engine
        settings.save()
    if args.auto_stop is not None:
        settings.auto_stop_seconds = args.auto_stop
    if args.idle_exit is not None:
        settings.idle_exit_seconds = args.idle_exit
    capture = file_capture_for(args.audio_file) if args.audio_file else MicCapture
    return Service(settings, args.bus_name, capture).run()
