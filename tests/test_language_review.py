from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import httpx
import pytest

from tests.test_curriculum import payload
from tests.test_repo import SAMPLE_PROBLEM
from tools import language_review as language


def dictionary() -> language.Dictionary:
    # Synthetic parser rows. These definitions are test data, not an STE dictionary.
    rows = [
        f"{'KEEP (v)':24}{'Retain the item.':30}EXAMPLE",
        f"{'retain (v)':24}{'KEEP (v)':30}EXAMPLE",
        f"{'ITEM (n)':24}{'An individual object.':30}EXAMPLE",
        f"{'THE (art)':24}{'Definite article.':30}EXAMPLE",
    ]
    return language.Dictionary([(149, "\n".join(rows))], "a" * 64)


def source() -> dict:
    result = copy.deepcopy(SAMPLE_PROBLEM)
    result.update(
        description_md="Retain the item.",
        canonical_solution_md="PRIVATE_SOLUTION_SENTINEL",
        fallback_hints=["First hint.", "Second hint.", "Third hint."],
        constraints=["item_count <= 100"],
        examples=[
            {
                "input": "PRIVATE_INPUT_SENTINEL",
                "output": "PRIVATE_OUTPUT_SENTINEL",
                "explanation": "Retain the item.",
            }
        ],
    )
    return result


def replacements(fields: list[language.TextField]) -> dict[str, str]:
    return {field.pointer: field.text for field in fields}


def test_dictionary_keeps_approval_pos_meaning_and_pdf_page() -> None:
    lexicon = dictionary()
    status, entries = lexicon.lookup("retain")
    assert status == "unapproved_entry"
    assert entries[0].pos == "v"
    assert entries[0].meaning == "KEEP (v)"
    assert entries[0].page == 149
    assert lexicon.lookup("keep")[0] == "entry_found"
    assert lexicon.lookup("items")[0] == "form_review"
    assert lexicon.lookup("invented")[0] == "not_indexed"


def test_audit_keeps_context_checks_explicit_and_binds_all_artifacts() -> None:
    original = source()
    fields = language.select_fields(original, [original["id"]])
    changed = replacements(fields)
    changed["/description_md"] = "Keep the item."
    candidate = language.candidate_from(original, fields, changed)
    report = language.make_report(original, candidate, fields, dictionary(), [])
    assert report["source_sha256"] == language.digest(original)
    assert report["candidate_sha256"] == language.digest(candidate)
    assert report["dictionary"]["sha256"] == "a" * 64
    assert report["conformity"] == "not_determined"
    assert report["publishable"] is False
    assert len(report["unchecked_requirements"]) == 5
    assert report["counts"]["changed_fields"] == 1
    assert report["counts"]["unchanged_fields"] == len(fields) - 1
    assert original["description_md"] == "Retain the item."
    assert candidate["starter_code"] == original["starter_code"]
    assert candidate["test_cases"] == original["test_cases"]
    assert candidate["canonical_solution_md"] == "PRIVATE_SOLUTION_SENTINEL"
    assert candidate["examples"][0]["input"] == "PRIVATE_INPUT_SENTINEL"
    assert candidate["examples"][0]["output"] == "PRIVATE_OUTPUT_SENTINEL"


@pytest.mark.parametrize("selected", [[], ["unknown"], ["test-problem", "test-problem"]])
def test_unknown_duplicate_and_empty_item_selections_fail(selected: list[str]) -> None:
    original = source()
    with pytest.raises(ValueError):
        language.select_fields(original, selected)


def test_pack_selection_leaves_unselected_items_and_default_hints_unchanged() -> None:
    original = payload()
    second = copy.deepcopy(original["design"][0])
    second["id"] = "fixture-lab-second"
    original["design"].append(second)
    lesson = copy.deepcopy(original["curriculum"][0])
    lesson["problem_id"] = second["id"]
    original["curriculum"].append(lesson)
    selected = original["design"][0]["id"]
    fields = language.select_fields(original, [selected])
    assert all(field.pointer.startswith("/design/0/") for field in fields)
    assert not any("/hints/" in field.pointer for field in fields)
    with_hints = language.select_fields(original, [selected], hints=True)
    assert sum("/hints/" in field.pointer for field in with_hints) == 3
    candidate = language.candidate_from(original, fields, replacements(fields))
    candidate["design"][1]["title"] = "Changed protected title"
    with pytest.raises(ValueError, match="protected fields"):
        language.make_report(original, candidate, fields, dictionary(), [])


@pytest.mark.parametrize(
    "text,changed",
    [
        ("Use item_count <= 100.", "Use item_count < 100."),
        ("Use item_count <= 100.", "Use item_total <= 100."),
        ("Use 1e3 items.", "Use 1e4 items."),
        ("Use 0xFF items.", "Use 0xFE items."),
        ("Use c - b.", "Use c + b."),
        ("Use 10^5.", "Use 10/5."),
        ("Use 10**5.", "Use 10*5."),
        ("Use 10-5.", "Use 10 5."),
        ("Use count-offset.", "Use count offset."),
        ("Use count + offset.", "Use count - offset."),
        ("Use count + offset.", "Use count + total."),
        ('Return "READY".', 'Return "DONE".'),
        ("Use `item_count`.", "Use `item_total`."),
        ("Use ``a ` b``.", "Use ``a ` c``."),
        ("See [diagram](images/original.png).", "See [diagram](images/changed.png)."),
        (
            "![scene][ref]\n\n[ref]: images/original.png\n",
            "![scene][ref]\n\n[ref]: images/changed.png\n",
        ),
        ("Use https://example.invalid/original.", "Use https://example.invalid/changed."),
        ("Use:\n\n    return 1\n", "Use:\n\n    return 2\n"),
        ("Use:\n\n> ````py\n> x=1\n> ```\n> ````\n", "Use:\n\n> ````py\n> x=2\n> ```\n> ````\n"),
        ("Use:\n\n~~~py\nx=1\n~~~\n", "Use:\n\n~~~py\nx=2\n~~~\n"),
        ("Use:\n\n```py\nx=1\n", "Use:\n\n```py\nx=2\n"),
    ],
)
def test_rewrite_rejects_changes_to_literals_code_numbers_and_identifiers(
    text: str, changed: str
) -> None:
    original = source()
    original["description_md"] = text
    fields = language.select_fields(original, [original["id"]])
    values = replacements(fields)
    values["/description_md"] = changed
    with pytest.raises(ValueError, match="protected tokens"):
        language.candidate_from(original, fields, values)


def test_rewrite_cannot_add_drop_or_replace_paths() -> None:
    original = source()
    fields = language.select_fields(original, [original["id"]])
    values = replacements(fields)
    values["/canonical_solution_md"] = "New solution"
    with pytest.raises(ValueError, match="selected text path"):
        language.candidate_from(original, fields, values)
    del values["/canonical_solution_md"]
    del values[fields[0].pointer]
    with pytest.raises(ValueError, match="selected text path"):
        language.candidate_from(original, fields, values)


def test_declared_prose_hyphen_can_change_but_still_needs_dictionary_review() -> None:
    original = source()
    original["description_md"] = "Use non-overlapping ranges."
    fields = language.select_fields(original, [original["id"]])
    values = replacements(fields)
    values["/description_md"] = "Use ranges without overlap."
    with pytest.raises(ValueError, match="protected tokens"):
        language.candidate_from(original, fields, values)
    fields = [language.replace(field, prose_hyphens=("non-overlapping",)) for field in fields]
    candidate = language.candidate_from(original, fields, values)
    report = language.make_report(original, candidate, fields, dictionary(), [])
    entry = report["fields"][0]
    assert entry["prose_hyphens"] == ["non-overlapping"]
    assert report["counts"]["changed_fields"] == 1
    assert report["conformity"] == "not_determined"
    source_words = language.audit(fields, dictionary(), [])[0]["words"]
    assert any(word["word"] == "non-overlapping" for word in source_words)


@pytest.mark.parametrize(
    "flags", [["unknown-word"], ["non-overlapping", "non-overlapping"], ["10-5"]]
)
def test_cli_rejects_invalid_prose_hyphen_declarations(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, flags: list[str]
) -> None:
    original = source()
    original["description_md"] = "Use non-overlapping ranges."
    path = tmp_path / "source.json"
    path.write_text(json.dumps(original))
    arguments = [
        "review",
        "audit",
        str(path),
        "--item",
        original["id"],
        "--dictionary-pdf",
        "unused",
        "--report",
        str(tmp_path / "report.json"),
    ]
    for flag in flags:
        arguments.extend(["--prose-hyphen", flag])
    monkeypatch.setattr(sys, "argv", arguments)
    with pytest.raises(SystemExit) as error:
        language.main()
    assert error.value.code == 2
    assert json.loads(path.read_text()) == original
    assert not (tmp_path / "report.json").exists()


@pytest.mark.parametrize(
    "text",
    [
        'Use "non-overlapping".',
        "Use `non-overlapping`.",
        "```\nnon-overlapping\n```\n",
        r'Return "A \"non-overlapping\" B".',
        r"Return 'A \'non-overlapping\' B'.",
        'Return "non-overlapping\ntext".',
        'Return """non-overlapping\ntext""".',
        "Return 'non-overlapping\ntext'.",
        "Return \u201cnon-overlapping\ntext\u201d.",
        "Return \u2018non-overlapping\ntext\u2019.",
    ],
)
def test_prose_hyphen_never_waives_quoted_or_code_literals(text: str) -> None:
    field = language.TextField(("description_md",), "fixture", text, ("non-overlapping",))
    with pytest.raises(ValueError, match="protected tokens"):
        language.validate_replacements(
            [field], {field.pointer: text.replace("non-overlapping", "other")}
        )


@pytest.mark.parametrize("missing", ["coding", "design"])
def test_omitted_optional_pack_arrays_keep_their_raw_shape(missing: str) -> None:
    original = payload()
    if missing == "design":
        coding = source()
        coding["id"] = "fixture-lab-code"
        coding["test_cases"] = {"python": [{"input": [], "expected": None}]}
        original["coding"] = [coding]
        original["design"] = []
        original["curriculum"][0]["problem_id"] = coding["id"]
    del original[missing]
    chosen = original["curriculum"][0]["problem_id"]
    fields = language.select_fields(original, [chosen])
    report = language.make_report(original, original, fields, dictionary(), [])
    assert report["counts"]["included_items"] == 1
    assert report["counts"]["skipped_items"] == 0
    assert missing not in original


@pytest.mark.parametrize("changed", [True, 1.0])
def test_protected_numeric_types_cannot_change(changed: bool | float) -> None:
    original = source()
    original["expected_time_minutes"] = 1
    fields = language.select_fields(original, [original["id"]])
    candidate = copy.deepcopy(original)
    candidate["expected_time_minutes"] = changed
    with pytest.raises(ValueError, match="protected fields"):
        language.make_report(original, candidate, fields, dictionary(), [])


def test_candidate_array_structure_cannot_change() -> None:
    original = source()
    fields = language.select_fields(original, [original["id"]])
    candidate = copy.deepcopy(original)
    candidate["constraints"] = []
    with pytest.raises(ValueError, match="selected field structure"):
        language.make_report(original, candidate, fields, dictionary(), [])


def test_declared_terms_do_not_create_a_conformity_verdict() -> None:
    field = language.TextField(
        ("description_md",), "fixture", "A widget keeps sorting; it isn't done."
    )
    term = language.Term(text="widget", kind="technical_noun", meaning="A test object.")
    result = language.audit([field], dictionary(), [term])[0]
    assert result["declared_terms_need_review"] == [term.model_dump()]
    assert not any(word["word"] == "widget" for word in result["words"])
    assert {screen["check"] for screen in result["rule_screens"]} >= {
        "semicolon",
        "ing_form",
        "contraction_or_possessive",
    }


@pytest.mark.parametrize("change", [False, True])
def test_model_receives_only_selected_prose_and_no_solutions_tests_or_full_pdf(
    monkeypatch: pytest.MonkeyPatch,
    change: bool,
) -> None:
    original = source()
    fields = language.select_fields(original, [original["id"]])
    calls = []
    client = httpx.Client

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/api/show":
            return httpx.Response(
                200,
                json={
                    "details": {"family": "fixture"},
                    "model_info": {"general.architecture": "fixture"},
                },
            )
        body = json.loads(request.content)
        text = json.dumps(body["messages"])
        assert "PRIVATE_SOLUTION_SENTINEL" not in text
        assert "PRIVATE_INPUT_SENTINEL" not in text
        assert "PRIVATE_OUTPUT_SENTINEL" not in text
        assert "test_cases" not in text
        assert "ASD-STE100 Simplified Technical English" not in text
        assert body["options"] == {"num_ctx": 32768, "num_predict": 6000, "temperature": 0}
        assert body["stream"] is False
        return httpx.Response(
            200,
            json={
                "done": True,
                "message": {
                    "content": json.dumps(
                        {
                            "changes": [
                                {"path": "/description_md", "replacement": "Keep the item."}
                            ]
                            if change
                            else []
                        }
                    )
                },
            },
        )

    monkeypatch.setattr(
        language.httpx,
        "Client",
        lambda **kwargs: client(**kwargs, transport=httpx.MockTransport(respond)),
    )
    result = language.rewrite(fields, dictionary(), [], "http://127.0.0.1:12345", "fixture")
    expected = replacements(fields)
    if change:
        expected["/description_md"] = "Keep the item."
    assert result == expected
    assert [request.url.path for request in calls] == ["/api/show", "/api/chat"]


@pytest.mark.parametrize(
    "url,model",
    [
        ("https://127.0.0.1:1", "fixture"),
        ("http://remote.invalid", "fixture"),
        ("http://user:password@localhost", "fixture"),
        ("http://localhost/path", "fixture"),
        ("http://localhost", "fixture:cloud"),
    ],
)
def test_private_rewrite_refuses_nonlocal_or_ambiguous_endpoints(url: str, model: str) -> None:
    with pytest.raises(ValueError):
        language.rewrite(
            [language.TextField(("description_md",), "fixture", "Keep the item.")],
            dictionary(),
            [],
            url,
            model,
        )


def test_cloud_alias_is_rejected_before_inference(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    client = httpx.Client

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"remote_model": "cloud-provider"})

    monkeypatch.setattr(
        language.httpx,
        "Client",
        lambda **kwargs: client(**kwargs, transport=httpx.MockTransport(respond)),
    )
    with pytest.raises(ValueError, match="Cloud"):
        language.rewrite(
            [language.TextField(("description_md",), "fixture", "Keep the item.")],
            dictionary(),
            [],
            "http://localhost",
            "alias",
        )
    assert len(calls) == 1


def test_oversized_prompt_fails_before_any_request() -> None:
    with pytest.raises(ValueError, match="24000 bytes"):
        language.rewrite(
            [language.TextField(("description_md",), "fixture", "x" * 24_000)],
            dictionary(),
            [],
            "http://localhost",
            "fixture",
        )


def test_duplicate_model_fields_are_rejected() -> None:
    with pytest.raises(ValueError, match="Duplicate"):
        json.loads('{"path":"first","path":"second"}', object_pairs_hook=language.unique_object)


def test_audit_cli_uses_exclusive_output_and_preserves_source(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    original = source()
    source_path = tmp_path / "source.json"
    source_path.write_text(json.dumps(original))
    report = tmp_path / "report.json"
    monkeypatch.setattr(language.Dictionary, "load", lambda _path: dictionary())
    argv = [
        "language-review",
        "audit",
        str(source_path),
        "--item",
        original["id"],
        "--dictionary-pdf",
        "unused.pdf",
        "--report",
        str(report),
    ]
    monkeypatch.setattr(sys, "argv", argv)
    language.main()
    assert json.loads(report.read_text())["source_sha256"] == language.digest(original)
    before = report.read_bytes()
    with pytest.raises(SystemExit) as error:
        language.main()
    assert error.value.code == 2
    assert report.read_bytes() == before
    assert json.loads(source_path.read_text()) == original
    assert "PRIVATE_SOLUTION_SENTINEL" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "state",
    [
        {"authored_with": "human"},
        {"review_status": "human-reviewed"},
        {"workflow_stage": "release"},
    ],
)
def test_rewrite_refuses_human_only_or_approved_sources_before_inference(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, state: dict
) -> None:
    original = source() | state
    source_path = tmp_path / "source.json"
    source_path.write_text(json.dumps(original))
    monkeypatch.setattr(language.Dictionary, "load", lambda _path: dictionary())
    calls = []
    monkeypatch.setattr(language, "rewrite", lambda *_args: calls.append(True))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "review",
            "rewrite",
            str(source_path),
            "--item",
            original["id"],
            "--dictionary-pdf",
            "unused",
            "--output",
            str(tmp_path / "candidate.json"),
            "--report",
            str(tmp_path / "report.json"),
        ],
    )
    with pytest.raises(SystemExit) as error:
        language.main()
    assert error.value.code == 2
    assert calls == []
    assert not (tmp_path / "candidate.json").exists()
    assert not (tmp_path / "report.json").exists()


def test_report_collision_after_candidate_creation_keeps_both_source_and_prior_report(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    original = source()
    source_path = tmp_path / "source.json"
    source_path.write_text(json.dumps(original))
    candidate = tmp_path / "candidate.json"
    report = tmp_path / "report.json"
    write = language.write_artifact

    def collision(path: Path, value: dict) -> None:
        if path == report:
            report.write_text("An existing owner report.")
        write(path, value)

    monkeypatch.setattr(language.Dictionary, "load", lambda _path: dictionary())
    monkeypatch.setattr(language, "rewrite", lambda fields, *_args: replacements(fields))
    monkeypatch.setattr(language, "write_artifact", collision)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "review",
            "rewrite",
            str(source_path),
            "--item",
            original["id"],
            "--dictionary-pdf",
            "unused",
            "--output",
            str(candidate),
            "--report",
            str(report),
        ],
    )
    with pytest.raises(SystemExit) as error:
        language.main()
    assert error.value.code == 2
    assert json.loads(candidate.read_text()) == original
    assert json.loads(source_path.read_text()) == original
    assert report.read_text() == "An existing owner report."
    assert "created the candidate file" in capsys.readouterr().err


@pytest.mark.parametrize(
    "body",
    [
        {"done": False, "message": {"content": "{}"}},
        {"done": True, "done_reason": "length", "message": {"content": "{}"}},
        {"done": True, "message": {"content": "not json"}},
        {
            "done": True,
            "message": {"content": "{}", "tool_calls": [{"function": {"name": "submit_solution"}}]},
        },
        {
            "done": True,
            "message": {"content": '{"/description_md":"first","/description_md":"second"}'},
        },
        {"done": True, "message": {"content": "{}"}},
        {"done": True, "message": {"content": '{"/description_md":3}'}},
        {"done": True, "message": {"content": '{"changes":{},"other":[]}'}},
        {
            "done": True,
            "message": {"content": '{"changes":[{"path":"/description_md","replacement":3}]}'},
        },
        {
            "done": True,
            "message": {
                "content": '{"changes":[{"path":"/starter_code/python","replacement":"code"}]}'
            },
        },
        {
            "done": True,
            "message": {
                "content": '{"changes":[{"path":"/description_md","replacement":"Keep the item."},'
                '{"path":"/description_md","replacement":"Keep the item."}]}'
            },
        },
        {
            "done": True,
            "message": {
                "content": '{"changes":[{"path":"/description_md",'
                '"replacement":"Keep the item.","extra":true}]}'
            },
        },
        {
            "done": True,
            "message": {"content": '{"/description_md":"a","/starter_code/python":"new code"}'},
        },
    ],
)
def test_model_errors_never_start_an_automatic_repair(
    monkeypatch: pytest.MonkeyPatch, body: dict
) -> None:
    calls = []
    client = httpx.Client

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"model_info": {"general.architecture": "fixture"}})
        return httpx.Response(200, json=body)

    monkeypatch.setattr(
        language.httpx,
        "Client",
        lambda **kwargs: client(**kwargs, transport=httpx.MockTransport(respond)),
    )
    with pytest.raises(ValueError):
        language.rewrite(
            [language.TextField(("description_md",), "fixture", "Keep the item.")],
            dictionary(),
            [],
            "http://localhost",
            "fixture",
        )
    assert [request.url.path for request in calls] == ["/api/show", "/api/chat"]


@pytest.mark.parametrize("copy_source", [False, True])
def test_approximate_word_count_cannot_require_model_changes(
    monkeypatch: pytest.MonkeyPatch, copy_source: bool
) -> None:
    text = "Keep the item " * 10 + "."
    field = language.TextField(("description_md",), "fixture", text)
    client = httpx.Client
    calls = []

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"model_info": {"general.architecture": "fixture"}})
        body = json.loads(request.content)
        assert "minItems" not in body["format"]["properties"]["changes"]
        changes = [{"path": field.pointer, "replacement": text}] if copy_source else []
        return httpx.Response(
            200, json={"done": True, "message": {"content": json.dumps({"changes": changes})}}
        )

    monkeypatch.setattr(
        language.httpx,
        "Client",
        lambda **kwargs: client(**kwargs, transport=httpx.MockTransport(respond)),
    )
    assert language.rewrite([field], dictionary(), [], "http://localhost", "fixture") == {
        field.pointer: text
    }
    assert calls == ["/api/show", "/api/chat"]


def test_source_prose_changes_invalidate_previous_content_approval() -> None:
    from datetime import UTC, datetime

    from tests.test_curriculum import approved
    from tools.curriculum import DraftManifest, compile_release

    original = payload()
    draft = DraftManifest.model_validate(original)
    approval = approved(draft)
    fields = language.select_fields(original, [original["design"][0]["id"]])
    values = replacements(fields)
    values["/design/0/brief_md"] += "\n\nKeep the requirements clear."
    changed = language.candidate_from(original, fields, values)
    with pytest.raises(ValueError, match="Approval is stale"):
        compile_release(
            DraftManifest.model_validate(changed), approval, datetime(2026, 1, 3, tzinfo=UTC)
        )


def test_interrupted_rewrite_keeps_source_and_creates_no_artifacts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    original = source()
    source_path = tmp_path / "source.json"
    source_path.write_text(json.dumps(original))

    def stop(*_args: object) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr(language.Dictionary, "load", lambda _path: dictionary())
    monkeypatch.setattr(language, "rewrite", stop)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "review",
            "rewrite",
            str(source_path),
            "--item",
            original["id"],
            "--dictionary-pdf",
            "unused",
            "--output",
            str(tmp_path / "candidate.json"),
            "--report",
            str(tmp_path / "report.json"),
        ],
    )
    with pytest.raises(SystemExit) as error:
        language.main()
    assert error.value.code == 130
    assert json.loads(source_path.read_text()) == original
    assert not (tmp_path / "candidate.json").exists()
    assert not (tmp_path / "report.json").exists()


def test_oversized_model_response_stops_stream_reads(monkeypatch: pytest.MonkeyPatch) -> None:
    reads = []

    class Body(httpx.SyncByteStream):
        def __iter__(self):
            for index in range(3):
                reads.append(index)
                yield b"x" * 40_000

    client = httpx.Client

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"model_info": {"general.architecture": "fixture"}})
        return httpx.Response(200, stream=Body())

    monkeypatch.setattr(
        language.httpx,
        "Client",
        lambda **kwargs: client(**kwargs, transport=httpx.MockTransport(respond)),
    )
    with pytest.raises(ValueError, match="60000 bytes"):
        language.rewrite(
            [language.TextField(("description_md",), "fixture", "Keep the item.")],
            dictionary(),
            [],
            "http://localhost",
            "fixture",
        )
    assert reads == [0, 1]
