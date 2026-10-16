"""Word suggestions: completes the word being typed and predicts the next one.

Ranking mixes how common a word is, what you have typed after the previous
word before (learned locally from the text around the cursor and kept in
~/.local/share/osk-dictation/history.json), and a Linux vocabulary that gets
an extra lift in terminals. The same context score re-ranks swipe guesses.
"""
import bisect
import json
import math
import re
import threading
from collections import defaultdict

from .config import data_dir

# Words a Linux tablet user types that general English frequency lists rank low.
LINUX_WORDS = """
sudo apt install update upgrade remove purge autoremove systemctl journalctl
enable disable restart status start stop reload daemon user grep sed awk find
xargs git commit push pull clone checkout branch merge rebase stash diff log
cd ls mkdir rmdir rm cp mv chmod chown ln cat less tail head echo export source
ssh scp rsync tar unzip curl wget python python3 pip venv pytest nano vim
flatpak snap gnome wayland xorg terminal kernel ubuntu linux bash zsh config
localhost github gitlab docker podman sudoers dconf gsettings extension
extensions pipewire bluetooth wifi usb ext4 btrfs fstab cron systemd dpkg deb
""".split()

# Phrases worth predicting before you've ever typed them.
SEED_BIGRAMS = [
    ("sudo", "apt"), ("apt", "install"), ("apt", "update"), ("apt", "upgrade"),
    ("sudo", "systemctl"), ("systemctl", "restart"), ("systemctl", "status"),
    ("systemctl", "enable"), ("git", "commit"), ("git", "push"), ("git", "pull"),
    ("git", "status"), ("git", "clone"), ("git", "checkout"), ("git", "add"),
    ("pip", "install"), ("python3", "-m"), ("journalctl", "--user"),
    ("flatpak", "install"), ("snap", "install"), ("cd", ".."),
]
TERMINAL_LIFT = 1.5     # Zipf points added to Linux words in a terminal
BIGRAM_WEIGHT = 1.6     # per log(1 + times seen after the previous word)
UNIGRAM_WEIGHT = 0.6    # per log(1 + times you've typed the word)
WORD = re.compile(r"[A-Za-z][A-Za-z']*")


class Predictor:
    def __init__(self, words, freqs):
        self.freq = {}
        self.shown = {}
        for w, f in zip(words, freqs):
            key = w.lower()
            if f > self.freq.get(key, -1):
                self.freq[key], self.shown[key] = float(f), w
        self.sorted = sorted(self.freq)
        self.common = sorted(self.freq, key=self.freq.get, reverse=True)[:40]
        self.linux = set(LINUX_WORDS)
        self.bigrams = defaultdict(lambda: defaultdict(int))
        self.unigrams = defaultdict(int)
        for a, b in SEED_BIGRAMS:
            self.bigrams[a][b] += 3
        self._lock = threading.Lock()
        self._last_learned = None
        self._unsaved = 0
        self._load()

    # ------------------------------------------------------------ history

    def _path(self):
        return data_dir() / "history.json"

    def _load(self):
        try:
            data = json.loads(self._path().read_text())
        except (OSError, ValueError):
            return
        for a, nexts in data.get("bigrams", {}).items():
            for b, n in nexts.items():
                self.bigrams[a][b] += n
        for w, n in data.get("unigrams", {}).items():
            self.unigrams[w] += n

    def save(self):
        with self._lock:
            if not self._unsaved:
                return
            data = {"bigrams": {a: dict(b) for a, b in self.bigrams.items()}, "unigrams": dict(self.unigrams)}
            self._unsaved = 0
        self._path().parent.mkdir(parents=True, exist_ok=True)
        self._path().write_text(json.dumps(data))

    def learn(self, before):
        """Counts the last finished word (and the one before it) once."""
        if not before or before[-1].isalpha() or before[-1] == "'":
            return
        words = [w.lower() for w in WORD.findall(before[-200:])]
        if not words:
            return
        key = (len(before), tuple(words[-2:]))
        with self._lock:
            if key == self._last_learned:
                return
            self._last_learned = key
            self.unigrams[words[-1]] += 1
            if len(words) > 1:
                self.bigrams[words[-2]][words[-1]] += 1
            self._unsaved += 1
        if self._unsaved >= 20:
            self.save()

    # ------------------------------------------------------------ ranking

    def context(self, prev, word, purpose="normal"):
        """Extra score for `word` after `prev` (both any case)."""
        w = word.lower()
        score = UNIGRAM_WEIGHT * math.log1p(self.unigrams.get(w, 0))
        if prev:
            score += BIGRAM_WEIGHT * math.log1p(self.bigrams.get(prev.lower(), {}).get(w, 0))
        if purpose == "terminal" and w in self.linux:
            score += TERMINAL_LIFT
        return score

    def _completions(self, prefix):
        p = prefix.lower()
        i = bisect.bisect_left(self.sorted, p)
        out = []
        while i < len(self.sorted) and self.sorted[i].startswith(p) and len(out) < 4000:
            out.append(self.sorted[i])
            i += 1
        return out

    def suggest(self, before, purpose="normal", count=3):
        """Up to `count` words: completions of the word at the cursor, or next words."""
        self.learn(before)
        words = WORD.findall(before[-200:])
        typing = bool(before) and (before[-1].isalpha() or before[-1] == "'")
        prefix = words[-1] if typing and words else ""
        prev = (words[-2] if typing else words[-1]) if len(words) > (1 if typing else 0) else None

        if prefix:
            pool = set(self._completions(prefix))
            pool |= {w for w in self.unigrams if w.startswith(prefix.lower())}
        else:
            pool = set(self.bigrams.get((prev or "").lower(), {})) | set(self.common)
        def score(w):
            return self.freq.get(w, 3.0) + self.context(prev, w, purpose)
        ranked = sorted(pool, key=score, reverse=True)

        out = []
        for w in ranked:
            shown = self.shown.get(w, w)
            if prefix and prefix[0].isupper():
                shown = shown[0].upper() + shown[1:]
            if shown not in out and shown != prefix:
                out.append(shown)
            if len(out) == count:
                break
        return out
