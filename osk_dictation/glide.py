"""Swipe (glide) typing: turns a finger path over the keys into likely words.

Statistical template matching after FlorisBoard's StatisticalGlideTypingClassifier
(Apache-2.0, https://github.com/florisboard/florisboard). Candidates are narrowed
to words starting and ending near where the swipe did, with a plausible path
length, then scored by how closely the swipe matches each word's ideal
key-to-key path in shape (both scaled to a unit box) and in location (on the
real keys), weighted by how common the word is.
"""
import re
from pathlib import Path

import numpy as np

POINTS = 48            # every path is resampled to this many points
SHAPE_SIGMA = 0.11     # shape distance spread, in unit-box widths
LOCATION_SIGMA = 0.6   # location distance spread, in key radii
FREQ_WEIGHT = 1.4      # weight of word frequency (Zipf scale) against fit
LENGTH_SLACK = 3.5     # allowed path-length difference, in key radii, plus 35%
USER_WORD_ZIPF = 5.0   # how common your own words.txt names count as

_BRITISH = Path("/usr/share/dict/british-english")
_AMERICAN = Path("/usr/share/dict/american-english")


def _dict_words(path):
    try:
        return path.read_text(errors="ignore").split()
    except OSError:
        return []


def load_lexicon(user_words=(), size=60000):
    """Returns (words as typed, Zipf frequencies). British spellings win."""
    import wordfreq

    british = _dict_words(_BRITISH)
    british_lower = {w.lower() for w in british}
    american_only = {w.lower() for w in _dict_words(_AMERICAN)} - british_lower
    casing = {}
    for w in british:  # prefer the lower-case form when both exist (polish, Polish)
        if w.lower() not in casing or w.islower():
            casing[w.lower()] = w

    words, freqs, seen = [], [], set()
    for w in wordfreq.top_n_list("en", size):
        if not w.isascii() or not re.fullmatch(r"[a-z']+", w) or len(w.replace("'", "")) < 2:
            continue
        if w in american_only:
            continue
        zipf = wordfreq.zipf_frequency(w, "en")
        if w not in british_lower and "'" not in w and zipf < 3.5:
            continue  # rare and not a dictionary word: likely noise
        shown = casing.get(w, w)
        if shown.lower().startswith("i'") or shown == "i":
            shown = "I" + shown[1:]
        words.append(shown)
        freqs.append(zipf)
        seen.add(w)
    for w in user_words:
        if " " not in w and w.lower() not in seen and re.fullmatch(r"[A-Za-z']{2,}", w):
            words.append(w)
            freqs.append(USER_WORD_ZIPF)
    return words, np.array(freqs, dtype=np.float32)


def resample(paths):
    """Resamples a batch of polylines (B, k, 2) to (B, POINTS, 2), evenly by length."""
    paths = np.asarray(paths, dtype=np.float32)
    b, k, _ = paths.shape
    if k == 1:
        return np.repeat(paths, POINTS, axis=1)
    seg = np.linalg.norm(np.diff(paths, axis=1), axis=2)
    cum = np.concatenate([np.zeros((b, 1), np.float32), np.cumsum(seg, axis=1)], axis=1)
    t = np.linspace(0, 1, POINTS, dtype=np.float32)[None, :] * cum[:, -1:]
    idx = np.clip((cum[:, None, :] <= t[:, :, None]).sum(axis=2) - 1, 0, k - 2)
    start = np.take_along_axis(cum, idx, axis=1)
    length = np.maximum(np.take_along_axis(seg, idx, axis=1), 1e-6)
    frac = np.clip((t - start) / length, 0, 1)[..., None]
    p0 = np.take_along_axis(paths, idx[..., None].repeat(2, axis=2), axis=1)
    p1 = np.take_along_axis(paths, (idx + 1)[..., None].repeat(2, axis=2), axis=1)
    return p0 + frac * (p1 - p0)


def normalise(paths):
    """Centres each path on its bounding box and scales the box's longer side to 1."""
    lo, hi = paths.min(axis=1, keepdims=True), paths.max(axis=1, keepdims=True)
    side = np.maximum((hi - lo).max(axis=2, keepdims=True), 1e-6)
    return (paths - (lo + hi) / 2) / side


def path_length(points):
    return float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum()) if len(points) > 1 else 0.0


class Layout:
    """Ideal paths for every word that can be swiped on one keyboard layout."""

    def __init__(self, keys, radius, words, freqs):
        self.radius = float(radius)
        self.chars = sorted(keys)
        self.centres = np.array([keys[c] for c in self.chars], dtype=np.float32)
        index = {c: i for i, c in enumerate(self.chars)}

        sequences, kept = [], []
        for n, word in enumerate(words):
            letters = [index.get(c) for c in word.lower() if c != "'"]
            if None in letters:
                continue
            seq = [letters[0]] + [b for a, b in zip(letters, letters[1:]) if a != b]
            sequences.append(seq)
            kept.append(n)
        self.words = [words[n] for n in kept]
        self.freqs = freqs[kept]
        self.first = np.array([s[0] for s in sequences])
        self.last = np.array([s[-1] for s in sequences])

        self.paths = np.empty((len(sequences), POINTS, 2), dtype=np.float32)
        by_length = {}
        for i, seq in enumerate(sequences):
            by_length.setdefault(len(seq), []).append(i)
        for _, rows in by_length.items():
            pts = self.centres[np.array([sequences[r] for r in rows])]
            self.paths[rows] = resample(pts)
        self.shapes = normalise(self.paths)
        self.lengths = np.linalg.norm(np.diff(self.paths, axis=1), axis=2).sum(axis=1)

    def nearest_keys(self, point, n=2):
        return np.argsort(np.linalg.norm(self.centres - point, axis=1))[:n]

    def candidates(self, points, count=3, scores=False):
        points = np.asarray(points, dtype=np.float32)
        if len(points) < 2:
            return []
        user = resample(points[None])[0]
        user_shape = normalise(user[None])[0]
        user_len = path_length(points)

        mask = np.isin(self.first, self.nearest_keys(points[0])) & np.isin(self.last, self.nearest_keys(points[-1]))
        mask &= np.abs(self.lengths - user_len) < LENGTH_SLACK * self.radius + 0.35 * user_len
        rows = np.nonzero(mask)[0]
        if not len(rows):
            return []
        location = np.linalg.norm(self.paths[rows] - user, axis=2).mean(axis=1) / self.radius
        shape = np.linalg.norm(self.shapes[rows] - user_shape, axis=2).mean(axis=1)
        score = (-0.5 * (shape / SHAPE_SIGMA) ** 2 - 0.5 * (location / LOCATION_SIGMA) ** 2
                 + FREQ_WEIGHT * self.freqs[rows])
        order = np.argsort(-score)
        out, seen = [], set()
        for i in order:
            word = self.words[rows[i]]
            if word not in seen:
                seen.add(word)
                out.append((word, float(score[i])))
            if len(out) == count:
                break
        return out if scores else [w for w, _ in out]
