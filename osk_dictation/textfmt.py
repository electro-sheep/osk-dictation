"""Fits a dictated phrase onto the text already before the cursor.

The engine capitalises every phrase as if it started a sentence and knows
nothing about spacing, so each phrase is adjusted against what precedes it:
a joining space when needed, and a capital only at the start of a sentence.
"""
import re

_SENTENCE_END = (".", "!", "?", "\n")
_NO_SPACE_AFTER = ("(", "[", "{", '"', "'", "“", "‘", "/", "-", "\n")
_FIRST_WORD = re.compile(r"^([^\w]*)(\w[\w'’]*)")


def _keeps_capital(word: str, keep: set[str]) -> bool:
    return (
        word == "I"
        or re.fullmatch(r"I['’]\w+", word) is not None
        or word in {term.split()[0] for term in keep if term.split()}
        or (len(word) > 1 and word.isupper())
    )


def format_phrase(text: str, before: str, keep: set[str] = frozenset()) -> str:
    """Returns `text` ready to insert after `before`.

    `keep` holds words whose capitalisation must not change (the bias list).
    """
    text = " ".join(text.split())
    if not text:
        return ""

    tail = before.rstrip(" \t")
    starts_sentence = not tail or tail.endswith(_SENTENCE_END)

    match = _FIRST_WORD.match(text)
    if match:
        lead, word = match.groups()
        if starts_sentence:
            word = word[0].upper() + word[1:]
        elif not _keeps_capital(word, keep):
            word = word[0].lower() + word[1:]
        text = lead + word + text[match.end():]

    if before and not before[-1].isspace() and not before.endswith(_NO_SPACE_AFTER):
        text = " " + text
    return text
