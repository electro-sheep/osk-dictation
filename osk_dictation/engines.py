"""Speech engines behind one small interface.

An engine is loaded once, then runs any number of sessions:

    begin(words, on_partial, on_final)  then  feed(chunk)...  then  finish() or abort()

Inference happens inside feed() and finish(), so the callbacks fire on the
calling thread. on_partial(text) is the phrase still being spoken (it will
change); on_final(text, audio) is a finished phrase plus its audio, which is
kept so the phrase can be retried with Whisper.
"""
import logging
import os
import threading

import numpy as np

from .audio import RATE
from .config import models_dir

log = logging.getLogger(__name__)


class Whisper:
    """faster-whisper base.en, loaded on first use and shared by the fallback engine and Retry."""

    def __init__(self):
        self._model = None
        self._lock = threading.Lock()

    def load(self):
        with self._lock:
            if self._model is not None:
                return
            from faster_whisper import WhisperModel

            kwargs = dict(device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4,
                          download_root=str(models_dir() / "whisper"))
            try:
                self._model = WhisperModel("base.en", local_files_only=True, **kwargs)
            except Exception:
                log.info("downloading faster-whisper base.en")
                self._model = WhisperModel("base.en", **kwargs)

    def transcribe(self, audio: np.ndarray, words: list[str]) -> str:
        self.load()
        with self._lock:
            segments, _ = self._model.transcribe(
                audio, language="en", beam_size=1, without_timestamps=True,
                condition_on_previous_text=False, vad_filter=False,
                hotwords=", ".join(words) if words else None)
            return " ".join(s.text.strip() for s in segments).strip()


def _moonshine_transcriber(arch_name, update_interval, options=None):
    import moonshine_voice as mv

    arch = mv.ModelArch[arch_name]
    path, _ = mv.get_model_for_language("en", arch, cache_root=models_dir() / "moonshine")
    return mv.Transcriber(model_path=path, model_arch=arch, update_interval=update_interval, options=options)


class MoonshineEngine:
    def __init__(self, arch_name, update_interval):
        self._arch_name = arch_name
        self._update_interval = update_interval
        self._tr = None
        self._active = False

    def load(self):
        if self._tr is None:
            self._tr = _moonshine_transcriber(self._arch_name, self._update_interval)
            self._tr.add_listener(self._on_event)

    def begin(self, words, on_partial, on_final):
        self._on_partial, self._on_final = on_partial, on_final
        # The bias list only takes effect when set before start().
        self._tr.set_keyterms(words or None)
        self._active = True
        self._tr.start()

    def feed(self, chunk):
        self._tr.add_audio(chunk.tolist(), RATE)

    def finish(self):
        self._tr.stop()
        self._active = False

    def abort(self):
        self._active = False
        self._tr.stop()

    def close(self):
        if self._tr is not None:
            self._tr.close()
            self._tr = None

    def _on_event(self, event):
        if not self._active:
            return
        kind = type(event).__name__
        line = event.line
        if kind == "LineCompleted":
            self._on_final(line.text, np.asarray(line.audio_data or [], dtype=np.float32))
        elif kind == "LineTextChanged" and not line.is_complete:
            self._on_partial(line.text)


class WhisperEngine:
    """Splits speech into phrases with Moonshine's voice detector and transcribes each with Whisper.

    Whisper can't stream, so the live preview is just "…" while a phrase is being
    spoken. If the voice detector can't load, the whole session is transcribed
    in one go when it finishes.
    """

    def __init__(self, whisper, update_interval):
        self._whisper = whisper
        self._update_interval = update_interval
        self._vad = None
        self._active = False
        self._buffer = []

    def load(self):
        if self._vad is None:
            try:
                self._vad = _moonshine_transcriber("TINY", self._update_interval, {"skip_transcription": "true"})
                self._vad.add_listener(self._on_event)
            except Exception:
                log.exception("voice detector failed to load; Whisper will transcribe whole sessions")
                self._vad = False
        self._whisper.load()

    def begin(self, words, on_partial, on_final):
        self._words, self._on_partial, self._on_final = words, on_partial, on_final
        self._active = True
        self._buffer = []
        if self._vad:
            self._vad.start()

    def feed(self, chunk):
        if self._vad:
            self._vad.add_audio(chunk.tolist(), RATE)
        else:
            self._buffer.append(chunk)
            self._on_partial("…")

    def finish(self):
        if self._vad:
            self._vad.stop()
        elif self._buffer:
            self._emit(np.concatenate(self._buffer))
        self._active = False

    def abort(self):
        self._active = False
        if self._vad:
            self._vad.stop()

    def close(self):
        if self._vad:
            self._vad.close()
        self._vad = None

    def _emit(self, audio):
        text = self._whisper.transcribe(audio, self._words)
        if self._active:
            self._on_final(text, audio)

    def _on_event(self, event):
        if not self._active:
            return
        kind = type(event).__name__
        if kind == "LineStarted":
            self._on_partial("…")
        elif kind == "LineCompleted":
            self._emit(np.asarray(event.line.audio_data or [], dtype=np.float32))


def make_engine(name, whisper, update_interval):
    if name == "moonshine-small":
        return MoonshineEngine("SMALL_STREAMING", update_interval)
    if name == "moonshine-tiny":
        return MoonshineEngine("TINY_STREAMING", update_interval)
    if name == "whisper-base":
        return WhisperEngine(whisper, update_interval)
    raise ValueError(f"unknown engine {name!r}")
