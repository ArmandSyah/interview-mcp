from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

from tools.ste_dictionary import Dictionary, _pdf_rows


def table(rows: list[tuple[str, str, str]], first: int = 21, second: int = 48) -> str:
    header = f"{'Word':{first}}{'Approved meaning/':{second - first}}STE EXAMPLE"
    return "\n".join(
        [
            header,
            *(
                f"{word:{first}}{meaning:{second - first}}{example}"
                for word, meaning, example in rows
            ),
        ]
    )


def test_page_columns_keep_complete_meanings_without_example_text() -> None:
    pages = [
        (149, table([("KEEP (v)", "To retain an item", "EXAMPLE_ONLY")], 20, 43)),
        (150, table([("retain (v)", "KEEP (v)", "OTHER_EXAMPLE")], 27, 60)),
    ]
    dictionary = Dictionary(pages, "fixture")
    assert dictionary.entries["keep"][0].meaning == "To retain an item"
    assert dictionary.entries["retain"][0].meaning == "KEEP (v)"
    assert dictionary.entries["keep"][0].page == 149
    assert dictionary.lookup("keep")[0] == "entry_found"
    assert dictionary.lookup("retain")[0] == "unapproved_entry"


def test_wrapped_headword_pos_keeps_first_definition_line_and_page() -> None:
    text = table(
        [
            ("APPROXIMATE", "Close to a value", "UNRELATED"),
            ("(adj)", "with a small error", "EXAMPLE"),
        ]
    )
    dictionary = Dictionary([(165, text)], "fixture")
    entry = dictionary.entries["approximate"][0]
    assert (entry.word, entry.pos, entry.page, entry.approved) == ("APPROXIMATE", "adj", 165, True)
    assert entry.meaning == "Close to a value with a small error"


def test_entry_continues_across_pages_with_new_column_positions() -> None:
    first = table([("ITEM (n)", "One object", "EXAMPLE")], 21, 48)
    second = table(
        [("", "in a group", "MORE_EXAMPLE"), ("GROUP (n)", "Several objects", "EXAMPLE")], 26, 57
    )
    dictionary = Dictionary([(149, first), (150, second)], "fixture")
    assert dictionary.entries["item"][0].meaning == "One object in a group"
    assert dictionary.entries["item"][0].page == 149


def test_irregular_forms_reference_the_entry_without_contextual_approval() -> None:
    text = table(
        [
            ("KEEP (v),", "To retain", "EXAMPLE"),
            ("KEEPS,", "an item", "EXAMPLE"),
            ("KEPT,", "", ""),
            ("KEPT", "", ""),
            ("ITEM (n)", "One object", "EXAMPLE"),
        ]
    )
    dictionary = Dictionary([(149, text)], "fixture")
    assert dictionary.lookup("kept")[0] == "form_review"
    assert dictionary.lookup("kept")[1][0].word == "KEEP"
    assert dictionary.lookup("items")[0] == "form_review"
    assert dictionary.lookup("unknown")[0] == "not_indexed"
    assert "kept" not in dictionary.entries


def test_distinct_parts_of_speech_and_case_keep_each_sense() -> None:
    text = table(
        [("TEST (n)", "An examination", "EXAMPLE"), ("test (v)", "EXAMINE (v)", "EXAMPLE")]
    )
    dictionary = Dictionary([(149, text)], "fixture")
    status, entries = dictionary.lookup("TEST")
    assert status == "entry_found"
    assert [(entry.pos, entry.approved) for entry in entries] == [("n", True), ("v", False)]


def test_rows_without_headers_keep_the_constructor_contract() -> None:
    rows = f"{'KEEP (v)':24}{'Retain the item.':30}EXAMPLE\n{'retain (v)':24}{'KEEP (v)':30}EXAMPLE"
    dictionary = Dictionary([(149, rows)], "fixture")
    assert dictionary.entries["keep"][0].meaning == "Retain the item."


def test_unlabelled_phrase_does_not_join_the_next_entry() -> None:
    text = table([("such as", "FOR EXAMPLE", "EXAMPLE"), ("suck (v)", "REMOVE (v)", "EXAMPLE")])
    dictionary = Dictionary([(149, text)], "fixture")
    assert dictionary.entries["such as"][0].pos == ""
    assert dictionary.entries["suck"][0].meaning == "REMOVE (v)"


def test_forms_without_commas_and_indented_notes_do_not_become_headwords() -> None:
    text = table(
        [
            ("OCCUR (v)", "To take place", "EXAMPLE"),
            ("OCCURS", "", ""),
            ("OCCURRED", "", ""),
            ("       No other verb", "", ""),
            ("       forms.", "", ""),
            ("OF (prep)", "From something", "EXAMPLE"),
        ]
    )
    dictionary = Dictionary([(149, text)], "fixture")
    assert dictionary.lookup("occurred")[0] == "form_review"
    assert dictionary.lookup("of")[0] == "entry_found"
    assert "no other verb" not in dictionary.entries


def test_a_hyphenated_line_wrap_has_a_review_candidate_without_a_lost_pos() -> None:
    text = table(
        [
            ("ELECTROMAG-", "A sample definition", "EXAMPLE"),
            ("NETIC (adj)", "with a continuation", "EXAMPLE"),
        ]
    )
    dictionary = Dictionary([(149, text)], "fixture")
    assert dictionary.lookup("electromagnetic")[0] == "form_review"
    assert dictionary.lookup("electromagnetic")[1][0].pos == "adj"


def test_tagged_cells_exclude_examples_even_when_their_positions_overlap() -> None:
    class Page:
        def extract_text(self, *, visitor_text, visitor_operand_before):
            for mcid, x, y, text in [
                (0, 50, 600, "COUNTERCLOCK-"),
                (0, 50, 588, "WISE (adv)"),
                (1, 160, 600, "A synthetic meaning"),
                (2, 150, 600, "STE_EXAMPLE_SENTINEL"),
                (3, 160, 588, "NON_STE_SENTINEL"),
            ]:
                matrix = [1, 0, 0, 1, x, y]
                visitor_operand_before(b"BDC", [None, {"/MCID": mcid}], matrix, matrix)
                visitor_text(text, [1, 0, 0, 1, 0, 0], matrix, None, 11)
                visitor_operand_before(b"EMC", [], matrix, matrix)
            return ""

    text = _pdf_rows(Page(), cells={0: (0, 10), 1: (1, 11), 2: (2, 12), 3: (3, 13)})
    dictionary = Dictionary([(205, text)], "fixture")
    assert dictionary.entries["counterclockwise"][0].meaning == "A synthetic meaning"
    assert dictionary.entries["counterclockwise"][0].pos == "adv"
    assert "SENTINEL" not in text


def test_a_multiword_headword_wrap_stays_in_its_own_cell() -> None:
    class Page:
        def extract_text(self, *, visitor_text, visitor_operand_before):
            for mcid, x, y, text in [
                (0, 50, 600, "DOWNSTREAM"),
                (0, 50, 588, "OF (prep)"),
                (1, 160, 600, "A sample relation"),
                (2, 50, 576, "such as"),
                (3, 160, 576, "A sample alternative"),
            ]:
                matrix = [1, 0, 0, 1, x, y]
                visitor_operand_before(b"BDC", [None, {"/MCID": mcid}], matrix, matrix)
                visitor_text(text, [1, 0, 0, 1, 0, 0], matrix, None, 11)
                visitor_operand_before(b"EMC", [], matrix, matrix)
            return ""

    text = _pdf_rows(Page(), cells={0: (0, 10), 1: (1, 11), 2: (0, 20), 3: (1, 21)})
    dictionary = Dictionary([(223, text)], "fixture")
    assert dictionary.entries["downstream of"][0].pos == "prep"
    assert dictionary.entries["such as"][0].pos == ""
    assert "of" not in dictionary.entries


def test_wrong_edition_is_rejected(tmp_path: Path) -> None:
    from pypdf import PdfWriter

    pdf = tmp_path / "other.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    with pdf.open("wb") as output:
        writer.write(output)
    with pytest.raises(ValueError, match="official"):
        Dictionary.load(pdf)


@pytest.mark.skipif(
    not os.environ.get("INTERVIEW_STE_PDF"), reason="Local official PDF is optional"
)
def test_official_issue9_column_and_wrapped_entries() -> None:
    path = Path(os.environ["INTERVIEW_STE_PDF"])
    dictionary = Dictionary.load(path)
    assert dictionary.sha256 == hashlib.sha256(path.read_bytes()).hexdigest()
    assert dictionary.lookup("approximate")[0] == "entry_found"
    assert dictionary.lookup("approximately")[0] == "entry_found"
    assert dictionary.entries["approximate"][0].pos == "adj"
    assert dictionary.entries["approximately"][0].pos == "adv"
    for word in ["follow", "keep", "above"]:
        assert dictionary.lookup(word)[0] == "entry_found"
    assert dictionary.entries["follow"][0].meaning.startswith("To come after")
    assert dictionary.entries["keep"][0].meaning.startswith("To continue to have or hold")
    assert dictionary.entries["above"][0].meaning.startswith("In (or to) a position")
    assert dictionary.lookup("such as")[0] == "unapproved_entry"
    assert "such as suck" not in dictionary.entries
    assert dictionary.lookup("counterclockwise")[0] == "entry_found"
    assert dictionary.entries["counterclockwise"][0].page == 205
    assert "opposite" not in dictionary.entries["count"][0].meaning
    assert dictionary.entries["downstream of"][0].pos == "prep"
    assert dictionary.entries["downstream of"][0].page == 223
    assert all(entry.page != 223 for entry in dictionary.entries["of"])
    assert dictionary.entries["critical"][0].meaning == "VERY IMPORTANT CAREFUL (adj)"
    curve = next(entry for entry in dictionary.entries["curve"] if entry.pos == "n")
    assert curve.meaning.split()[0] == "The"
    assert curve.meaning.split()[-1] == "angles"
    assert "RADIUS" not in curve.meaning
