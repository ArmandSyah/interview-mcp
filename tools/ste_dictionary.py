"""Read word entries from a local ASD-STE100 Issue 9 PDF."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, cast

_POS = r"v|n|adj|adv|prep|conj|pron|art"
_HEAD = re.compile(rf"^\s*([A-Za-z][A-Za-z .'\u2019-]*?)\s*\(({_POS})\)")
_POS_ONLY = re.compile(rf"^\s*\(({_POS})\)\s*,?\s*$")
_WORD_ONLY = re.compile(r"^[A-Za-z][A-Za-z '\u2019-]*$")
_HEADER = re.compile(r"ASD-STE100|Issue 9|2025-01-15|Part 2|^\s*\(part of speech\)")


@dataclass(frozen=True)
class Entry:
    word: str
    pos: str
    page: int
    approved: bool
    meaning: str


def _columns(lines: list[str]) -> tuple[int, int]:
    meaning = next(
        (line.index("Approved meaning") for line in lines if "Approved meaning" in line), None
    )
    example = next((line.index("STE EXAMPLE") for line in lines if "STE EXAMPLE" in line), None)
    if meaning is not None and example is not None and 0 < meaning < example:
        return meaning, example
    for line in lines:
        if _HEAD.match(line):
            fields = list(re.finditer(r"\S(?:.*?\S)?(?= {2,}|$)", line))
            if len(fields) >= 3:
                return fields[1].start(), fields[2].start()
    raise ValueError("Cannot find the dictionary columns.")


def _layout_rows(text: str) -> list[tuple[str, str]]:
    if not text.strip():
        return []
    if "\t" in text:
        rows: list[tuple[str, str]] = []
        for line in text.splitlines():
            if "\t" in line:
                left, right = line.split("\t", 1)
                rows.append((left, right))
        return rows
    lines = text.splitlines()
    start, end = _columns(lines)
    result = []
    for line in lines:
        if _HEADER.search(line) or "Approved meaning" in line:
            continue
        left = line[:start]
        # Headwords and their forms start at the left edge. Notes have an indent.
        word = left.strip() if len(left) - len(left.lstrip()) <= 2 else ""
        result.append((word, line[start:end].strip()))
    return result


def _parent_arrays(tree: Any) -> dict[int, Any]:
    result: dict[int, Any] = {}
    pending = [tree]
    seen: set[int] = set()
    while pending:
        node = pending.pop().get_object()
        if id(node) in seen:
            continue
        seen.add(id(node))
        numbers = node.get("/Nums", [])
        for index in range(0, len(numbers), 2):
            result[int(numbers[index])] = numbers[index + 1].get_object()
        pending.extend(node.get("/Kids", []))
    return result


def _tagged_cells(page: Any, arrays: dict[int, Any]) -> dict[int, tuple[int, int]]:
    cells: dict[int, tuple[int, int]] = {}
    parents = arrays.get(int(page["/StructParents"]), [])
    for mcid, reference in enumerate(parents):
        node = reference.get_object()
        for _ in range(32):
            if not isinstance(node, dict) or node.get("/S") in {"/TD", "/TH"}:
                break
            node = node.get("/P")
            if node is None:
                break
            node = node.get_object()
        if not isinstance(node, dict) or node.get("/S") not in {"/TD", "/TH"}:
            continue
        row = node["/P"]
        siblings = row.get("/K", [])
        if not isinstance(siblings, list) or len(siblings) != 4:
            continue
        cell_reference = cast(Any, node).indirect_reference
        for column, sibling in enumerate(siblings):
            if sibling == cell_reference:
                cells[mcid] = (column, cell_reference.idnum)
                break
    if not cells:
        if "Blank Page" in page.extract_text():
            return {}
        raise ValueError("Cannot read the dictionary table cells.")
    return cells


def _pdf_rows(
    page: Any,
    arrays: dict[int, Any] | None = None,
    *,
    cells: dict[int, tuple[int, int]] | None = None,
) -> str:
    """Read the word and meaning cells from the tagged PDF table."""
    if cells is None:
        if arrays is None:
            reader = page.indirect_reference.pdf
            arrays = _parent_arrays(reader.trailer["/Root"]["/StructTreeRoot"]["/ParentTree"])
        cells = _tagged_cells(page, arrays)
    stack: list[int | None] = []
    fragments: list[tuple[int, int, float, float, str]] = []

    def operation(operator: bytes, arguments: list[Any], _cm: Any, _tm: Any) -> None:
        if operator == b"BDC":
            properties = arguments[-1]
            if not isinstance(properties, dict):
                properties = page.get("/Resources", {}).get("/Properties", {}).get(properties, {})
            stack.append(properties.get("/MCID") if isinstance(properties, dict) else None)
        elif operator == b"BMC":
            stack.append(None)
        elif operator == b"EMC" and stack:
            stack.pop()

    def visit(text: str, cm: list[float], tm: list[float], _font: Any, _size: float) -> None:
        mcid = next((value for value in reversed(stack) if value is not None), None)
        assignment = cells.get(mcid) if mcid is not None else None
        if text and assignment and assignment[0] < 2:
            x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
            y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
            fragments.append((*assignment, x, y, text))

    page.extract_text(visitor_text=visit, visitor_operand_before=operation)
    word_x = min(
        (x for column, _, x, _, text in fragments if column == 0 and text.strip()), default=0
    )
    rows: dict[float, tuple[list[tuple[float, str, int]], list[tuple[float, str, int]]]] = {}
    for column, cell, x, y, text in fragments:
        rows.setdefault(round(y, 1), ([], []))[column].append((x, text, cell))
    ordered: list[list[str]] = []
    word_cells: dict[int, list[int]] = {}
    for y in sorted(rows, reverse=True):
        word, meaning = rows[y]
        left = "".join(text for _, text, _ in sorted(word, key=lambda item: item[0]))
        if min((x for x, text, _ in word if text.strip()), default=word_x) > word_x + 2:
            left = ""
        right = "".join(text for _, text, _ in sorted(meaning, key=lambda item: item[0]))
        ordered.append([" ".join(left.split()), " ".join(right.split())])
        if left.strip():
            for cell in {cell for _, text, cell in word if text.strip()}:
                word_cells.setdefault(cell, []).append(len(ordered) - 1)
    for indices in word_cells.values():
        first = ordered[indices[0]][0]
        if _HEAD.match(first) or len(indices) == 1:
            continue
        name = first
        used = [indices[0]]
        for index in indices[1:]:
            part = ordered[index][0]
            name = name[:-1] + part if name.endswith("-") else name + " " + part
            used.append(index)
            if _HEAD.match(name):
                break
        ordered[indices[0]][0] = name
        for index in used[1:]:
            ordered[index][0] = ""
    return "\n".join(word + "\t" + meaning for word, meaning in ordered)


def _join(parts: list[str]) -> str:
    value = ""
    for part in parts:
        part = " ".join(part.split())
        if part:
            value += ("" if not value or value.endswith("-") else " ") + part
    return value


class Dictionary:
    """Keep dictionary references. A reviewer must examine each word in its sentence."""

    def __init__(self, pages: Iterable[tuple[int, str]], pdf_sha256: str):
        self.sha256 = pdf_sha256
        self.entries: dict[str, list[Entry]] = {}
        self._forms: dict[str, list[Entry]] = {}
        self._wrapped: dict[str, list[Entry]] = {}
        rows = [
            (page, word, meaning) for page, text in pages for word, meaning in _layout_rows(text)
        ]
        current: tuple[str, str, int] | None = None
        meanings: list[str] = []
        forms: list[str] = []
        had_wrap = False

        def finish() -> None:
            nonlocal current, meanings, forms, had_wrap
            if current:
                word, pos, page = current
                entry = Entry(word, pos, page, word.isupper(), _join(meanings))
                self.entries.setdefault(word.lower(), []).append(entry)
                if had_wrap:
                    self._wrapped.setdefault(word.replace("-", "").lower(), []).append(entry)
                for form in dict.fromkeys(forms):
                    self._forms.setdefault(form.lower(), []).append(entry)
            current, meanings, forms, had_wrap = None, [], [], False

        for index, (page, word, meaning) in enumerate(rows):
            head = _HEAD.match(word)
            pos_only = _POS_ONLY.fullmatch(word)
            next_word = (
                next((other_word for _, other_word, _ in rows[index + 1 :] if other_word), "")
                if word and not head and not pos_only
                else ""
            )
            wrapped = bool(_POS_ONLY.fullmatch(next_word))
            if head:
                if current and current[1] == "" and current[0].endswith("-"):
                    current = (current[0] + head.group(1).strip(), head.group(2), current[2])
                    had_wrap = True
                else:
                    finish()
                    current = (head.group(1).strip(), head.group(2), page)
                suffix = word[head.end() :]
                forms.extend(
                    value.strip() for value in suffix.strip(", ").split(",") if value.strip()
                )
            elif pos_only and current and current[1] == "":
                current = (current[0], pos_only.group(1), current[2])
            elif (
                word
                and current
                and current[1] == "v"
                and current[0].isupper()
                and not wrapped
                and not word.endswith("-")
            ):
                values = [value.strip() for value in word.strip(", ").split(",")]
                roots = current[0].split()
                if word.startswith("(also "):
                    forms.extend(re.findall(r"[A-Z]+", word))
                elif all(
                    _WORD_ONLY.fullmatch(value)
                    and value.isupper()
                    and value.split()[1:] == roots[1:]
                    for value in values
                ):
                    forms.extend(values)
                elif _WORD_ONLY.fullmatch(word):
                    finish()
                    current = (word, "", page)
            elif word and _WORD_ONLY.fullmatch(word):
                if current and current[1] == "" and current[0].endswith("-"):
                    current = (current[0] + word, "", current[2])
                    had_wrap = True
                else:
                    finish()
                    current = (word, "", page)
            if meaning and current:
                meanings.append(meaning)
        finish()

    @classmethod
    def load(cls, path: Path) -> Dictionary:
        try:
            from pypdf import PdfReader
            from pypdf.errors import PdfReadError
        except ImportError:
            raise ValueError("Install the authoring dependency group before PDF review.") from None
        with path.open("rb") as source:
            raw = source.read(10_000_001)
        if len(raw) > 10_000_000:
            raise ValueError("The dictionary PDF has more than 10 MB.")
        try:
            reader = PdfReader(BytesIO(raw))
            first = reader.pages[0].extract_text()
            if "ASD-STE100" not in first or "ISSUE 9" not in first or len(reader.pages) != 434:
                raise ValueError("Use the official ASD-STE100 Issue 9 PDF.")
            root = cast(Any, reader.trailer["/Root"])
            arrays = _parent_arrays(root["/StructTreeRoot"]["/ParentTree"])
            result = cls(
                ((index + 1, _pdf_rows(reader.pages[index], arrays)) for index in range(148, 434)),
                hashlib.sha256(raw).hexdigest(),
            )
        except (PdfReadError, IndexError):
            raise ValueError("Cannot read the Issue 9 PDF.") from None
        if len(result.entries) < 1500 or not all(
            result.entries.get(word) for word in ["a", "the", "use", "write"]
        ):
            raise ValueError("Cannot read the Issue 9 dictionary entries.")
        return result

    def lookup(self, word: str) -> tuple[str, list[Entry]]:
        base = word.lower()
        exact = self.entries.get(base, [])
        if exact:
            return (
                "entry_found" if any(entry.approved for entry in exact) else "unapproved_entry"
            ), exact
        if base in self._forms:
            return "form_review", self._forms[base]
        if base in self._wrapped:
            return "form_review", self._wrapped[base]
        candidates = {
            base.removesuffix("s"),
            base.removesuffix("es"),
            base.removesuffix("ed"),
            base.removesuffix("d"),
            base.removesuffix("ing"),
            base.removesuffix("ing") + "e",
        }
        if base.endswith("ies"):
            candidates.add(base[:-3] + "y")
        found = [
            entry for form in sorted(candidates - {base}) for entry in self.entries.get(form, [])
        ]
        return ("form_review" if found else "not_indexed"), found
