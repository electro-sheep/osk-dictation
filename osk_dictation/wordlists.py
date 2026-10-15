"""The two word lists: terms to bias the engine towards, and guaranteed fix-ups.

words.txt  one term per line, spelled the way it should come out.
fixes.txt  `heard | other way it's heard = Wanted`, matched as whole words,
           ignoring case, with spaces or hyphens between the heard words.
Lines starting with # are comments in both.
"""
import re
from pathlib import Path


def _lines(path: Path) -> list[str]:
    try:
        text = path.read_text()
    except OSError:
        return []
    return [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]


def load_words(path: Path) -> list[str]:
    return _lines(path)


class Fixer:
    def __init__(self, rules: list[tuple[str, str]]):
        # Longest heard phrase first, so "no shell" wins over "no".
        rules = sorted(rules, key=lambda rule: len(rule[0]), reverse=True)
        self._rules = [(self._pattern(heard), wanted) for heard, wanted in rules]

    @staticmethod
    def _pattern(heard: str) -> re.Pattern:
        words = [re.escape(word) for word in re.split(r"[\s\-]+", heard.strip()) if word]
        return re.compile(r"(?<!\w)" + r"[\s\-]+".join(words) + r"(?!\w)", re.IGNORECASE)

    @classmethod
    def parse(cls, lines: list[str]) -> "Fixer":
        rules = []
        for line in lines:
            if "=" not in line:
                continue
            heard, wanted = line.rsplit("=", 1)
            wanted = wanted.strip()
            for variant in heard.split("|"):
                if variant.strip() and wanted:
                    rules.append((variant.strip(), wanted))
        return cls(rules)

    @classmethod
    def load(cls, path: Path) -> "Fixer":
        return cls.parse(_lines(path))

    def apply(self, text: str) -> str:
        for pattern, wanted in self._rules:
            text = pattern.sub(wanted, text)
        return text
