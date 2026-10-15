"""End-to-end: runs the real service over D-Bus, fed from a WAV file instead of the mic.

Uses the speech sample that ships with moonshine-voice. Set OSK_DICTATION_TEST_WAV
to try your own recording. These tests load real models, so they take a while.
"""
import os
import subprocess
import sys
import time
from pathlib import Path

import gi
import pytest

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

from osk_dictation import INTERFACE, OBJECT_PATH  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def sample_wav():
    if os.environ.get("OSK_DICTATION_TEST_WAV"):
        return Path(os.environ["OSK_DICTATION_TEST_WAV"])
    import moonshine_voice
    return Path(moonshine_voice.__file__).parent / "assets" / "two_cities.wav"


class ServiceRun:
    """One service process on a private bus name, with every signal recorded."""

    def __init__(self, tmp_path, engine="moonshine-small", auto_stop=0, wav=None):
        self.name = f"io.github.electro_sheep.OskDictation.Test{os.getpid()}{int(time.monotonic() * 1000) % 100000}"
        env = dict(os.environ, OSK_DICTATION_CONFIG_DIR=str(tmp_path / "config"), HF_HUB_OFFLINE="1")
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "osk_dictation", "--bus-name", self.name, "--engine", engine,
             "--audio-file", str(wav or sample_wav()), "--idle-exit", "0", "--auto-stop", str(auto_stop)],
            cwd=ROOT, env=env, stderr=subprocess.PIPE, text=True)
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        self.events = []
        self.bus.signal_subscribe(self.name, INTERFACE, None, OBJECT_PATH, None, Gio.DBusSignalFlags.NONE,
                                  lambda *a: self.events.append((time.monotonic(), a[4], a[5].unpack())))
        self.wait(lambda: self._has_owner(), 15, "service never appeared on the bus")

    def _has_owner(self):
        reply = self.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                                   "NameHasOwner", GLib.Variant("(s)", (self.name,)), None,
                                   Gio.DBusCallFlags.NONE, -1, None)
        return reply.unpack()[0]

    def call(self, method, *args, signature=None):
        params = GLib.Variant(signature, args) if signature else None
        return self.bus.call_sync(self.name, OBJECT_PATH, INTERFACE, method, params, None,
                                  Gio.DBusCallFlags.NONE, 10000, None)

    def pump(self, seconds):
        end = time.monotonic() + seconds
        ctx = GLib.MainContext.default()
        while time.monotonic() < end:
            ctx.iteration(False)
            time.sleep(0.01)

    def wait(self, condition, timeout, message):
        end = time.monotonic() + timeout
        ctx = GLib.MainContext.default()
        while time.monotonic() < end:
            ctx.iteration(False)
            if condition():
                return
            time.sleep(0.01)
        raise AssertionError(message)

    def states(self):
        return [args[0] for _, name, args in self.events if name == "State"]

    def finals(self):
        return [args for _, name, args in self.events if name == "Final"]

    def wait_idle_after(self, state, timeout):
        def done():
            s = self.states()
            return state in s and s[-1] == "idle" and s.index(state) < len(s) - 1
        self.wait(done, timeout, f"never went idle after {state}; states: {self.states()}")

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


@pytest.fixture
def service(tmp_path, request):
    runs = []

    def make(**kwargs):
        run = ServiceRun(tmp_path, **kwargs)
        runs.append(run)
        return run

    yield make
    for run in runs:
        run.close()


def text_of(finals):
    return "".join(text for text, _ in finals)


def test_moonshine_dictation_round_trip(service):
    run = service()
    run.call("Start", "", "normal", signature="(ss)")
    run.pump(12)
    stop_at = time.monotonic()
    run.call("Stop")
    run.wait_idle_after("finishing", 30)
    text = text_of(run.finals()).lower()
    assert "best of times" in text and "worst of times" in text, text
    assert run.states()[:2] == ["starting", "listening"]
    assert any(name == "Partial" and args[0] for _, name, args in run.events), "no live words"
    assert any(name == "Level" and args[0] > 0.2 for _, name, args in run.events), "no mic level"
    idle_at = max(t for t, name, args in run.events if name == "State" and args[0] == "idle")
    print(f"\nmoonshine-small: {text_of(run.finals())!r}, done {idle_at - stop_at:.2f} s after Stop")


def test_retry_replaces_last_phrase_with_whisper(service):
    run = service()
    run.call("Start", "", "normal", signature="(ss)")
    run.pump(6)
    run.call("Stop")
    run.wait_idle_after("finishing", 30)
    before = len(run.finals())
    run.call("Retry")
    run.wait_idle_after("retrying", 60)
    replaced = run.finals()[before:]
    assert len(replaced) == 1 and replaced[0][1] is True and replaced[0][0].strip(), (replaced, run.states())


def test_whisper_engine_dictates(service):
    run = service(engine="whisper-base")
    run.call("Start", "", "normal", signature="(ss)")
    run.pump(10)
    run.call("Stop")
    run.wait_idle_after("finishing", 60)
    text = text_of(run.finals()).lower()
    assert "best of times" in text, text


def test_auto_stop_after_silence(service, tmp_path):
    # Three seconds of speech then silence: the session should end by itself.
    import numpy as np
    import wave
    with wave.open(str(sample_wav())) as w:
        rate = w.getframerate()
        frames = w.readframes(rate * 3)
    short = tmp_path / "short.wav"
    with wave.open(str(short), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(rate)
        w.writeframes(frames)
    run = service(auto_stop=3, wav=short)
    run.call("Start", "", "normal", signature="(ss)")
    run.wait_idle_after("listening", 25)
    assert "finishing" in run.states()
    assert np is not None


def test_password_fields_refused(service):
    run = service()
    with pytest.raises(GLib.Error, match="password"):
        run.call("Start", "", "password", signature="(ss)")


def test_context_continues_sentence(service):
    run = service()
    run.call("Start", "and then I said", "normal", signature="(ss)")
    run.pump(5)
    run.call("Stop")
    run.wait_idle_after("finishing", 30)
    first = run.finals()[0][0]
    assert first.startswith(" ") and first[1].islower(), first
