"""Audio input: 16 kHz mono float32 chunks delivered on a reader thread."""
import math
import subprocess
import threading
import time
import wave

import numpy as np

RATE = 16000
CHUNK = 800  # 50 ms, so the level meter updates 20 times a second
# The codec clicks at full scale for about 80 ms when the mic wakes from idle.
STARTUP_MUTE = RATE // 10


def level(chunk: np.ndarray) -> float:
    """Loudness for the UI: 0 at -60 dBFS or quieter, 1 at -10 dBFS or louder."""
    if not len(chunk):
        return 0.0
    rms = float(np.sqrt(np.mean(np.square(chunk))))
    db = 20 * math.log10(max(rms, 1e-6))
    return min(1.0, max(0.0, (db + 60) / 50))


class Capture:
    """Calls on_chunk(chunk) for every chunk, and on_error(reason) if input fails."""

    def __init__(self, on_chunk, on_error):
        self._on_chunk = on_chunk
        self._on_error = on_error
        self._stopping = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stopping.set()

    def join(self, timeout=2.0):
        if self._thread.is_alive():
            self._thread.join(timeout)

    def _run(self):
        raise NotImplementedError


class MicCapture(Capture):
    COMMAND = ["pw-record", "--rate", str(RATE), "--channels", "1", "--format", "s16", "-"]

    def __init__(self, on_chunk, on_error):
        super().__init__(on_chunk, on_error)
        self._proc = None

    def stop(self):
        super().stop()
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()

    def _run(self):
        try:
            self._proc = subprocess.Popen(self.COMMAND, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as e:
            self._on_error(f"microphone: {e}")
            return
        if self._stopping.is_set():
            self._proc.terminate()
        seen = 0
        while True:
            data = self._proc.stdout.read(CHUNK * 2)
            if len(data) < 2:
                break
            chunk = np.frombuffer(data[: len(data) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768.0
            if seen < STARTUP_MUTE:
                chunk[: max(0, STARTUP_MUTE - seen)] = 0.0
            seen += len(chunk)
            self._on_chunk(chunk)
        self._proc.wait()
        if not self._stopping.is_set():
            err = self._proc.stderr.read().decode(errors="replace").strip()
            self._on_error(f"microphone stopped: {err or 'pw-record exited'}")


class FileCapture(Capture):
    """Plays a mono 16-bit WAV in at real-time pace, then silence, as if from a microphone.

    For tests and demos without speaking: `osk-dictation --audio-file clip.wav`.
    """

    path = None

    def _run(self):
        with wave.open(str(self.path)) as w:
            if w.getnchannels() != 1 or w.getsampwidth() != 2:
                self._on_error("audio file must be mono 16-bit WAV")
                return
            rate = w.getframerate()
            audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        if rate != RATE:
            positions = np.arange(0, len(audio), rate / RATE)
            audio = np.interp(positions, np.arange(len(audio)), audio).astype(np.float32)
        start = time.monotonic()
        sent = 0
        while not self._stopping.is_set():
            chunk = audio[sent:sent + CHUNK]
            if len(chunk) < CHUNK:
                chunk = np.concatenate([chunk, np.zeros(CHUNK - len(chunk), dtype=np.float32)])
            self._on_chunk(chunk)
            sent += CHUNK
            ahead = start + sent / RATE - time.monotonic()
            if ahead > 0:
                time.sleep(ahead)


def file_capture_for(path):
    """Returns a capture class that reads `path` instead of the microphone."""
    return type("BoundFileCapture", (FileCapture,), {"path": path})
