"""Dictation sessions: microphone, engine and formatting, without any D-Bus.

`emit(kind, *args)` reports progress, called from worker threads:

    ("state", name)          idle, loading, starting, listening, finishing,
                             retrying, or error:<reason> (always followed by idle)
    ("partial", text)        the phrase being spoken, formatted; "" clears it
    ("final", text, replace) a finished phrase to insert; replace=True means
                             it replaces the previous final (Retry)
    ("level", value)         microphone loudness 0..1, 20 times a second
"""
import logging
import queue
import threading
import time
from dataclasses import dataclass, field

import numpy as np

from .audio import MicCapture, level
from .config import ENGINES, Settings, config_dir
from .engines import Whisper, make_engine
from .textfmt import format_phrase
from .wordlists import Fixer, load_words

log = logging.getLogger(__name__)

STOP = "stop"
CANCEL = "cancel"


@dataclass
class _Session:
    before: str
    inbox: queue.Queue = field(default_factory=queue.Queue)
    capture: object = None
    heard_audio: bool = False
    stopping: bool = False
    cancelled: bool = False
    last_activity: float = field(default_factory=time.monotonic)


@dataclass
class _Phrase:
    audio: np.ndarray
    before: str
    text: str


class Dictation:
    def __init__(self, settings: Settings, emit, capture_factory=MicCapture):
        self.settings = settings
        self._emit = emit
        self._capture_factory = capture_factory
        self._whisper = Whisper()
        self._engine = None
        self._engine_lock = threading.Lock()
        self._lock = threading.Lock()
        self._session = None
        self._last_phrase = None
        self.state = "idle"
        self.last_used = time.monotonic()

    # ------------------------------------------------------------ requests

    @property
    def engine_name(self):
        return self.settings.engine

    @property
    def busy(self):
        return self.state != "idle"

    def prepare(self):
        """Loads the engine in the background so the first Start is quick."""
        if self._engine is not None or self.busy:
            return
        self._set_state("loading")

        def load():
            try:
                self._ensure_engine()
            except Exception as e:
                log.exception("engine failed to load")
                self._error(f"engine failed to load: {e}")
            if self.state == "loading":
                self._set_state("idle")

        threading.Thread(target=load, daemon=True).start()

    def start(self, context: str, purpose: str = "normal"):
        if purpose.lower() == "password":
            raise ValueError("won't dictate into a password field")
        with self._lock:
            # Starting while Prepare is still loading is fine: audio queues up
            # until the engine is ready.
            if self._session is not None or self.state == "retrying":
                raise RuntimeError(f"busy ({self.state})")
            session = self._session = _Session(before=context)
        self.last_used = time.monotonic()
        self._set_state("starting")
        session.capture = self._capture_factory(
            on_chunk=lambda chunk: self._on_chunk(session, chunk),
            on_error=lambda reason: self._on_capture_error(session, reason))
        threading.Thread(target=self._run, args=(session,), daemon=True).start()
        session.capture.start()

    def stop(self):
        with self._lock:
            session = self._session
            if session is None or session.stopping:
                return
            session.stopping = True
        session.capture.stop()
        session.inbox.put(STOP)
        self._set_state("finishing")

    def cancel(self):
        with self._lock:
            session = self._session
            if session is None:
                return
            session.cancelled = session.stopping = True
        session.capture.stop()
        session.inbox.put(CANCEL)
        self._emit("partial", "")

    def retry(self):
        """Re-transcribes the last phrase with Whisper and sends it as a replacement."""
        phrase = self._last_phrase
        with self._lock:
            if self._session is not None or self.busy:
                raise RuntimeError(f"busy ({self.state})")
            if phrase is None or not len(phrase.audio):
                raise RuntimeError("nothing to retry yet")
            self.state = "retrying"
        self._emit("state", "retrying")

        def work():
            try:
                words, fixer = self._word_lists()
                text = format_phrase(fixer.apply(self._whisper.transcribe(phrase.audio, words)),
                                     phrase.before, set(words))
                phrase.text = text
                self._emit("final", text, True)
            except Exception as e:
                log.exception("retry failed")
                self._error(f"retry failed: {e}")
            self.last_used = time.monotonic()
            self._set_state("idle")

        threading.Thread(target=work, daemon=True).start()

    def set_engine(self, name: str):
        if name not in ENGINES:
            raise ValueError(f"unknown engine {name!r}; choose from {', '.join(ENGINES)}")
        if self.busy:
            raise RuntimeError(f"busy ({self.state})")
        with self._engine_lock:
            if name == self.settings.engine:
                return
            if self._engine is not None:
                self._engine.close()
                self._engine = None
            self.settings.engine = name
        self.settings.save()

    def shutdown(self):
        self.cancel()
        with self._engine_lock:
            if self._engine is not None:
                self._engine.close()
                self._engine = None

    # ------------------------------------------------------------ workers

    def _ensure_engine(self):
        with self._engine_lock:
            if self._engine is None:
                engine = make_engine(self.settings.engine, self._whisper, self.settings.update_interval)
                try:
                    engine.load()
                except Exception:
                    if self.settings.engine == "whisper-base":
                        raise
                    log.exception("%s failed to load, falling back to whisper-base", self.settings.engine)
                    engine = make_engine("whisper-base", self._whisper, self.settings.update_interval)
                    engine.load()
                self._engine = engine
            return self._engine

    def _word_lists(self):
        words = load_words(config_dir() / "words.txt")
        return words, Fixer.load(config_dir() / "fixes.txt")

    def _on_chunk(self, session, chunk):
        if session.stopping:
            return
        if not session.heard_audio:
            session.heard_audio = True
            self._set_state("listening")
        self._emit("level", level(chunk))
        session.inbox.put(chunk)

    def _on_capture_error(self, session, reason):
        self._error(reason)
        with self._lock:
            if self._session is session and not session.stopping:
                session.stopping = True
                session.inbox.put(STOP)

    def _run(self, session):
        try:
            engine = self._ensure_engine()
        except Exception as e:
            log.exception("engine failed to load")
            session.capture.stop()
            self._error(f"engine failed to load: {e}")
            self._end(session)
            return

        words, fixer = self._word_lists()
        keep = set(words)

        def on_partial(text):
            if session.cancelled:
                return
            text = fixer.apply(text)
            if text.strip():
                session.last_activity = time.monotonic()
            self._emit("partial", format_phrase(text, session.before, keep))

        def on_final(text, audio):
            if session.cancelled:
                return
            formatted = format_phrase(fixer.apply(text), session.before, keep)
            self._emit("partial", "")
            if formatted:
                self._last_phrase = _Phrase(audio, session.before, formatted)
                session.before += formatted
                session.last_activity = time.monotonic()
                self._emit("final", formatted, False)

        try:
            engine.begin(words, on_partial, on_final)
            session.last_activity = time.monotonic()
            while True:
                try:
                    item = session.inbox.get(timeout=0.5)
                except queue.Empty:
                    item = None
                chunks, signal = [], None
                while item is not None:
                    if isinstance(item, np.ndarray):
                        chunks.append(item)
                    else:
                        signal = item
                        break
                    try:
                        item = session.inbox.get_nowait()
                    except queue.Empty:
                        item = None
                if chunks and signal != CANCEL:
                    engine.feed(np.concatenate(chunks))
                if signal == CANCEL:
                    engine.abort()
                    break
                if signal == STOP:
                    engine.finish()
                    break
                quiet = time.monotonic() - session.last_activity
                if self.settings.auto_stop_seconds > 0 and quiet > self.settings.auto_stop_seconds:
                    log.info("auto-stop after %.0f s without speech", quiet)
                    self.stop()
        except Exception as e:
            log.exception("dictation failed")
            session.capture.stop()
            self._error(f"dictation failed: {e}")
            try:
                engine.abort()
            except Exception:
                pass
        self._end(session)

    def _end(self, session):
        session.capture.join()
        with self._lock:
            if self._session is session:
                self._session = None
        self.last_used = time.monotonic()
        self._emit("level", 0.0)
        self._set_state("idle")

    def _set_state(self, state):
        self.state = state
        self._emit("state", state)

    def _error(self, reason):
        self._emit("state", f"error:{reason}")
