"""Terminal test client: drives the service the way the keyboard extension will.

Press Space to start and stop dictating; finished phrases print as they arrive
and the live phrase shows on the status line. If the service isn't running or
installed, the client starts one for the session.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import termios
import time
import tty
from pathlib import Path

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

from . import BUS_NAME, INTERFACE, OBJECT_PATH  # noqa: E402

DIM, BOLD, RED, GREEN, YELLOW, RESET = "\033[2m", "\033[1m", "\033[31m", "\033[32m", "\033[33m", "\033[0m"
ICONS = {"idle": f"{DIM}○ idle{RESET}", "loading": f"{YELLOW}◌ loading model{RESET}",
         "starting": f"{YELLOW}◌ opening mic{RESET}", "listening": f"{RED}● listening{RESET}",
         "finishing": f"{YELLOW}◍ finishing{RESET}", "retrying": f"{YELLOW}↻ retrying with Whisper{RESET}"}


def remote_error(error):
    """The service's own message, without the GDBus.Error:<name>: prefix."""
    return re.sub(r"^GDBus\.Error:[\w.]+: ", "", error.message)


class Client:
    def __init__(self, bus_name, context):
        self.bus_name = bus_name
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        self.loop = GLib.MainLoop()
        self.text = context
        self.state = "idle"
        self.partial = ""
        self.level = 0.0
        self.stopped_at = None
        self.child = None
        self._ensure_service()
        self.bus.signal_subscribe(bus_name, INTERFACE, None, OBJECT_PATH, None,
                                  Gio.DBusSignalFlags.NONE, self._on_signal)
        self.engine = self._get("Engine")
        self.engines = self._get("Engines")

    # ------------------------------------------------------------ service

    def _bus_call(self, method, args, signature):
        return self.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", method,
                                  GLib.Variant(signature, args) if signature else None, None,
                                  Gio.DBusCallFlags.NONE, -1, None).unpack()

    def _ensure_service(self):
        if self._bus_call("NameHasOwner", (self.bus_name,), "(s)")[0]:
            return
        if self.bus_name in self._bus_call("ListActivatableNames", (), None)[0]:
            return  # D-Bus starts the installed service on the first call
        log = Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp")) / "osk-dictation-cli.log"
        print(f"{DIM}Service not running; starting one for this session (log: {log}){RESET}")
        self.child = subprocess.Popen([sys.executable, "-m", "osk_dictation", "--bus-name", self.bus_name],
                                      stdout=subprocess.DEVNULL, stderr=open(log, "w"))
        deadline = time.monotonic() + 15
        while not self._bus_call("NameHasOwner", (self.bus_name,), "(s)")[0]:
            if self.child.poll() is not None or time.monotonic() > deadline:
                sys.exit(f"The service failed to start; see {log}")
            time.sleep(0.1)

    def call(self, method, *args, signature=None):
        try:
            self.bus.call_sync(self.bus_name, OBJECT_PATH, INTERFACE, method,
                               GLib.Variant(signature, args) if signature else None, None,
                               Gio.DBusCallFlags.NONE, 10000, None)
            return True
        except GLib.Error as e:
            self.note(f"{RED}{method} failed: {remote_error(e)}{RESET}")
            return False

    def _get(self, prop):
        reply = self.bus.call_sync(self.bus_name, OBJECT_PATH, "org.freedesktop.DBus.Properties", "Get",
                                   GLib.Variant("(ss)", (INTERFACE, prop)), None, Gio.DBusCallFlags.NONE, 10000, None)
        return reply.unpack()[0]

    def _set_engine(self, name):
        try:
            self.bus.call_sync(self.bus_name, OBJECT_PATH, "org.freedesktop.DBus.Properties", "Set",
                               GLib.Variant("(ssv)", (INTERFACE, "Engine", GLib.Variant("s", name))), None,
                               Gio.DBusCallFlags.NONE, 10000, None)
            self.engine = name
            self.note(f"Engine: {BOLD}{name}{RESET}")
            self.call("Prepare")
        except GLib.Error as e:
            self.note(f"{RED}Couldn't switch engine: {remote_error(e)}{RESET}")

    # ------------------------------------------------------------ events

    def _on_signal(self, conn, sender, path, iface, name, params):
        args = params.unpack()
        if name == "Level":
            self.level = args[0]
        elif name == "Partial":
            self.partial = args[0]
        elif name == "Final":
            text, replace = args
            if replace:
                self.note(f"{GREEN}↻ Whisper:{RESET} {text.strip()}")
                if self._last_final and self.text.endswith(self._last_final):
                    self.text = self.text[: len(self.text) - len(self._last_final)]
            else:
                self.note(f"{GREEN}+{RESET} {text.strip()}")
            self.text += text
            self._last_final = text
        elif name == "State":
            state = args[0]
            if state.startswith("error:"):
                self.note(f"{RED}Error: {state[6:]}{RESET}")
                return
            if state == "idle" and self.state == "finishing" and self.stopped_at is not None:
                self.note(f"{DIM}done {time.monotonic() - self.stopped_at:.2f} s after you stopped{RESET}")
                self.note(f"{BOLD}Text:{RESET} {self.text.strip()}")
                self.stopped_at = None
            if state == "finishing" and self.stopped_at is None:
                self.stopped_at = time.monotonic()  # auto-stop
            self.state = state
        self.draw()

    _last_final = ""

    def _on_key(self, fd, condition):
        key = os.read(fd, 8).decode(errors="ignore")[:1].lower()
        if key in (" ", "\n", "\r"):
            if self.state in ("starting", "listening"):
                self.stopped_at = time.monotonic()
                self.call("Stop")
            elif self.state in ("idle", "loading"):
                self.call("Start", self.text, "normal", signature="(ss)")
        elif key == "r":
            self.call("Retry")
        elif key == "x":
            self.call("Cancel")
            self.note("Cancelled")
        elif key == "e":
            others = list(self.engines)
            self._set_engine(others[(others.index(self.engine) + 1) % len(others)])
        elif key == "c":
            self.text = ""
            self.note("Text cleared")
        elif key in ("q", "\x03", "\x04"):
            self.loop.quit()
        self.draw()
        return GLib.SOURCE_CONTINUE

    # ------------------------------------------------------------ drawing

    def note(self, line):
        sys.stdout.write("\r\033[K" + line + "\n")
        self.draw()

    def draw(self):
        width = shutil.get_terminal_size((80, 20)).columns
        status = ICONS.get(self.state, self.state)
        meter = ""
        if self.state == "listening":
            bars = round(self.level * 10)
            meter = " " + "▮" * bars + f"{DIM}" + "▯" * (10 - bars) + RESET
        live = self.partial.strip()
        room = max(10, width - 40)
        if len(live) > room:
            live = "…" + live[-room:]
        line = f"{status}{meter}  {DIM}{live}{RESET}" if live else f"{status}{meter}"
        sys.stdout.write("\r\033[K" + line)
        sys.stdout.flush()

    # ------------------------------------------------------------ main

    def run(self):
        print(f"{BOLD}osk-dictation test client{RESET}  ·  engine {self.engine}")
        print(f"{DIM}  Space  start / stop      r  retry last phrase with Whisper\n"
              f"  e  switch engine   x  cancel   c  clear text   q  quit{RESET}\n")
        self.call("Prepare")
        fd = sys.stdin.fileno()
        saved = termios.tcgetattr(fd) if os.isatty(fd) else None
        if saved:
            tty.setcbreak(fd)
        GLib.io_add_watch(fd, GLib.IO_IN, self._on_key)
        self.draw()
        try:
            self.loop.run()
        except KeyboardInterrupt:
            pass
        finally:
            if saved:
                termios.tcsetattr(fd, termios.TCSADRAIN, saved)
            if self.state in ("starting", "listening", "finishing"):
                self.call("Cancel")
            sys.stdout.write("\r\033[K")
            if self.text.strip():
                print(f"{BOLD}Final text:{RESET} {self.text.strip()}")
            if self.child:
                self.child.terminate()


def main(argv=None):
    p = argparse.ArgumentParser(prog="osk-dictation-cli", description=__doc__.splitlines()[0])
    p.add_argument("--context", default="", help="pretend this text is already before the cursor")
    p.add_argument("--bus-name", default=BUS_NAME, help=argparse.SUPPRESS)
    args = p.parse_args(argv)
    Client(args.bus_name, args.context).run()


if __name__ == "__main__":
    main()
