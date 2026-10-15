from osk_dictation.textfmt import format_phrase
from osk_dictation.wordlists import Fixer


def test_empty_field_capitalises():
    assert format_phrase("hello there.", "") == "Hello there."


def test_new_sentence_gets_space_and_capital():
    assert format_phrase("then it stopped.", "It worked.") == " Then it stopped."


def test_continuing_sentence_lowercases():
    assert format_phrase("The finished text.", "and then drop") == " the finished text."


def test_after_trailing_space_no_extra_space():
    assert format_phrase("Second part.", "First part, ") == "second part."


def test_keeps_i_and_acronyms_and_bias_words():
    assert format_phrase("I think so.", "well") == " I think so."
    assert format_phrase("I'm in.", "ok so") == " I'm in."
    assert format_phrase("GNOME Shell is slow.", "today") == " GNOME Shell is slow."
    assert format_phrase("FreeCAD opened.", "then", keep={"FreeCAD"}) == " FreeCAD opened."


def test_bias_word_prefix_does_not_keep_capital():
    assert format_phrase("The theme.", "and", keep={"Theme Park"}) == " the theme."


def test_no_space_after_open_bracket_or_newline():
    assert format_phrase("Note.", "(") == "note."
    assert format_phrase("next line.", "done.\n") == "Next line."


def test_collapses_whitespace_and_ignores_blank():
    assert format_phrase("  lots   of   space ", "") == "Lots of space"
    assert format_phrase("   ", "anything") == ""


def test_leading_punctuation_kept():
    assert format_phrase('"Quote" here.', "He said") == ' "quote" here.'


def test_fixes_whole_words_any_case_and_separators():
    fixer = Fixer.parse(["cat pachin | cat per cheen = Catppuccin", "no shell = GNOME Shell", "# comment = ignored"])
    assert fixer.apply("the Cat Pachin theme") == "the Catppuccin theme"
    assert fixer.apply("the cat-per-cheen theme") == "the Catppuccin theme"
    assert fixer.apply("but no shell sometimes") == "but GNOME Shell sometimes"
    assert fixer.apply("noshell and concatpachin stay") == "noshell and concatpachin stay"


def test_longest_fix_wins():
    fixer = Fixer.parse(["no = No", "no shell = GNOME Shell"])
    assert fixer.apply("no shell") == "GNOME Shell"
