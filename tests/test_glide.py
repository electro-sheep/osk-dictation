"""Swipe typing accuracy on simulated swipes over a QWERTY layout."""
import time

import numpy as np
import pytest

from osk_dictation.glide import Layout, load_lexicon

ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
KEY = 60.0  # key pitch in pixels; radius is half of it


def qwerty():
    keys = {}
    for r, row in enumerate(ROWS):
        for c, ch in enumerate(row):
            keys[ch] = (KEY * (c + 0.5 + 0.5 * r), KEY * (r + 0.5))
    return keys


@pytest.fixture(scope="module")
def layout():
    words, freqs = load_lexicon(user_words=["Catppuccin"])
    return Layout(qwerty(), KEY / 2, words, freqs)


def swipe(word, keys, rng, wobble=0.3):
    """A human-ish swipe: wobbly key centres joined by short straight runs."""
    centres = [np.array(keys[c]) + rng.normal(0, wobble * KEY / 2, 2) for c in word.lower() if c != "'"]
    points = []
    for a, b in zip(centres, centres[1:]):
        for t in np.linspace(0, 1, 8, endpoint=False):
            points.append(a + t * (b - a))
    points.append(centres[-1])
    return np.array(points)


def test_common_words_top1(layout):
    rng = np.random.default_rng(1)
    words = ["hello", "the", "keyboard", "thanks", "tomorrow", "because", "people", "working",
             "morning", "little", "would", "should", "great", "please", "really", "different",
             "question", "answer", "together", "something", "computer", "microphone", "typing", "about"]
    hits = sum(layout.candidates(swipe(w, qwerty(), rng))[:1] == [w] for w in words)
    assert hits >= 0.85 * len(words), f"{hits}/{len(words)}"


def test_top3_and_british_spelling(layout):
    rng = np.random.default_rng(2)
    assert "colour" in layout.candidates(swipe("colour", qwerty(), rng))
    assert "color" not in layout.words
    assert "I'm" in layout.candidates(swipe("im", qwerty(), rng))
    assert "Catppuccin" in layout.candidates(swipe("catppuccin", qwerty(), rng))


def test_fast_enough(layout):
    rng = np.random.default_rng(3)
    path = swipe("something", qwerty(), rng)
    layout.candidates(path)
    start = time.perf_counter()
    for _ in range(20):
        layout.candidates(path)
    assert (time.perf_counter() - start) / 20 < 0.05


def test_suggestions_learn_and_know_linux(tmp_path, monkeypatch, layout):
    monkeypatch.setenv("OSK_DICTATION_DATA_DIR", str(tmp_path))
    from osk_dictation.predict import Predictor
    p = Predictor(layout.words, layout.freqs)
    assert p.suggest("Can you check the batt")[0].lower().startswith("batt")
    assert "install" in p.suggest("sudo apt ", "terminal")
    for _ in range(3):
        p.learn("Surface " * 1 + "Go ")
        p._last_learned = None
    assert "Go" in p.suggest("my Surface ") or "go" in p.suggest("my Surface ")
