"""Run cloud contracts in disposable PostgreSQL, with a local Auth identity fixture.

Set INTERVIEW_TEST_CLOUD_POSTGRES=1. No host port or real Supabase account is used.
The fixture supplies auth.uid()/auth.jwt(). It does not test Supabase token verification.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import pytest

from tools import cloud_catalog
from tools.cloud_catalog import OUTPUT, build_seed

ROOT = Path(__file__).resolve().parents[1]
ALICE = "11111111-1111-4111-8111-111111111111"
BOB = "22222222-2222-4222-8222-222222222222"
CODING = "0011-conveyor-permit-route"
DESIGN = "design-link-aliases"
DIGEST = "a" * 64


def test_cloud_seed_matches_public_sources() -> None:
    assert OUTPUT.read_text(encoding="utf-8") == build_seed(), (
        "python -m tools.cloud_catalog --check: expected public catalog parity, actual stale SQL"
    )


def test_catalog_builder_does_not_replace_a_migration(tmp_path, monkeypatch) -> None:
    target = tmp_path / "catalog.sql"
    target.write_text("Earlier migration\n")
    monkeypatch.setattr("sys.argv", ["cloud_catalog", "--output", str(target)])
    with pytest.raises(SystemExit, match="Do not replace a migration"):
        cloud_catalog.main()
    assert target.read_text() == "Earlier migration\n"


def test_catalog_builder_creates_a_new_migration(tmp_path, monkeypatch) -> None:
    target = tmp_path / "catalog.sql"
    monkeypatch.setattr("sys.argv", ["cloud_catalog", "--output", str(target)])
    cloud_catalog.main()
    assert target.read_text() == build_seed()


class Database:
    def __init__(self, name: str):
        self.name = name

    def sql(self, query: str, *, success: bool = True) -> str:
        result = subprocess.run(
            [
                "docker",
                "exec",
                "-i",
                self.name,
                "psql",
                "-h",
                "127.0.0.1",
                "-X",
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
            ],
            input=query,
            text=True,
            capture_output=True,
            timeout=40,
        )
        if success:
            assert result.returncode == 0, (
                f"psql call={query[:1200]!r}, expected=success, actual={result.stderr!r}"
            )
        else:
            assert result.returncode != 0, (
                f"psql call={query[:1200]!r}, expected=failure, actual={result.stdout!r}"
            )
        return result.stdout.strip() if success else result.stderr

    def call(
        self,
        operation: str,
        arguments: dict[str, object],
        *,
        owner: str = ALICE,
        success: bool = True,
    ):
        encoded = json.dumps(arguments, ensure_ascii=False).replace("'", "''")
        query = (
            "set role authenticated; set request.jwt.claims = "
            f'\'{{"sub":"{owner}","role":"authenticated"}}\';'
            f" select public.iwb_practice('{operation}', '{encoded}'::jsonb);"
        )
        result = self.sql(query, success=success)
        return json.loads(result) if success else result


@pytest.fixture(scope="module")
def database():
    if os.environ.get("INTERVIEW_TEST_CLOUD_POSTGRES") != "1":
        pytest.skip("Opt-in disposable PostgreSQL contract test")
    name = "interview-cloud-test-" + uuid4().hex[:12]
    start = subprocess.run(
        [
            "docker",
            "run",
            "--detach",
            "--rm",
            "--name",
            name,
            "--network",
            "none",
            "--label",
            "io.interview-workbench.test=cloud-postgres",
            "--memory=512m",
            "--cpus=1",
            "--tmpfs",
            "/var/lib/postgresql/data:rw",
            "-e",
            "POSTGRES_HOST_AUTH_METHOD=trust",
            "postgres:17-alpine",
        ],
        capture_output=True,
        text=True,
        timeout=40,
    )
    assert start.returncode == 0, start.stderr
    db = Database(name)
    try:
        for _ in range(50):
            ready = subprocess.run(
                ["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                capture_output=True,
                timeout=5,
            )
            if ready.returncode == 0:
                break
            time.sleep(0.1)
        else:
            pytest.fail("Disposable PostgreSQL did not become ready")
        db.sql("""
            create role anon nologin;
            create role authenticated nologin;
            create schema auth;
            create table auth.users(id uuid primary key);
            grant usage on schema auth to authenticated, anon;
            create function auth.jwt() returns jsonb language sql stable as
              $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
            create function auth.uid() returns uuid language sql stable as
              $$ select (auth.jwt()->>'sub')::uuid $$;
        """)
        db.sql(f"insert into auth.users values ('{ALICE}'), ('{BOB}');")
        for migration in sorted((ROOT / "supabase/migrations").glob("*.sql")):
            db.sql(migration.read_text())
        yield db
    finally:
        # The exact container belongs to this fixture. No named volume exists.
        stopped = subprocess.run(
            ["docker", "stop", "--time", "5", name], capture_output=True, timeout=15
        )
        assert stopped.returncode == 0, stopped.stderr


def checkpoint_arguments(session_id: str, **changes: object) -> dict[str, object]:
    return {
        "session_id": session_id,
        "checkpoint_id": str(uuid4()),
        "scene_digest": DIGEST,
        "notes": {
            "requirements": (
                "Owners can disable their aliases. "
                "The service must reject changes from other accounts."
            )
        },
        "diagram": [{"id": "client", "type": "rectangle", "label": "Client"}],
        **changes,
    }


def test_catalog_and_attempt_contract(database: Database) -> None:
    catalog = database.call("list_problems", {})
    assert len(catalog) == 5 and all("fallback_hints" not in item for item in catalog)
    assert database.call("list_problems", {"tag": "nonexistent"}) == []
    assert set(database.call("get_problem_catalog", {})) == {"difficulties", "tags", "pattern_tags"}
    started = database.call("start_problem", {"problem_id": CODING})
    scaffold = started["files_to_create"][0]
    assert started["mode"] == "remote" and scaffold["relative_path"] == f"{CODING}/solution.py"
    assert "Example call and expected return" in scaffold["contents"]
    assert "Conveyor Permit Route" in database.call(
        "get_problem_description", {"attempt_id": started["attempt_id"]}
    )
    hint = database.call(
        "get_hint", {"attempt_id": started["attempt_id"], "current_code": "pass", "depth": 99}
    )
    assert hint["depth"] == 3 and hint["used_fallback"] is True
    assert "Conveyor Permit Route" in database.call("get_progress", {})
    assert "Attempt not found" in database.call(
        "get_hint", {"attempt_id": started["attempt_id"]}, owner=BOB, success=False
    )
    assert (
        database.call("get_progress", {}, owner=BOB)
        == "No attempts yet. Call `start_problem` to begin."
    )


def test_design_evidence_review_finish_and_ownership(database: Database) -> None:
    assert len(database.call("list_design_problems", {})) == 5
    session = database.call("start_design_session", {"problem_id": DESIGN})
    assert "hints" not in session["brief"] and len(session["brief"]["revision"]) == 64
    arguments = checkpoint_arguments(session["id"])
    checkpoint = database.call("save_design_checkpoint", arguments)
    assert database.call("save_design_checkpoint", arguments) == checkpoint
    assert checkpoint["notes"]["api"] == "" and checkpoint["diagram"][0]["from_id"] is None
    ids = {"session_id": session["id"], "checkpoint_id": checkpoint["id"]}
    assert database.call("get_design_snapshot", ids) == checkpoint
    assert database.call("list_design_checkpoints", {"session_id": session["id"]}) == [checkpoint]
    assert "immutable" in database.call(
        "save_design_checkpoint", {**arguments, "label": "Changed"}, success=False
    )
    for operation, values in [
        ("get_design_brief", {"session_id": session["id"]}),
        ("get_design_snapshot", ids),
        ("save_design_checkpoint", arguments),
        ("evaluate_design", ids),
        ("finish_design_session", ids),
    ]:
        assert "Design session not found" in database.call(
            operation, values, owner=BOB, success=False
        )
    assert "Review this checkpoint" in database.call("finish_design_session", ids, success=False)
    review = database.call("evaluate_design", ids)
    assert (
        review["scene_digest"] == DIGEST
        and review["rubric_version"] == session["brief"]["revision"]
    )
    assert [item["status"] for item in review["items"]] == ["discussed"] + ["not_discussed"] * 5
    assert database.call("finish_design_session", ids)["status"] == "completed"
    assert "Start a new practice session" in database.call(
        "save_design_checkpoint", arguments, success=False
    )
    assert database.call("get_design_snapshot", ids) == checkpoint


def test_database_rejects_direct_mutation_and_identity_injection(database: Database) -> None:
    for table in [
        "iwb_content",
        "iwb_attempts",
        "iwb_design_sessions",
        "iwb_checkpoints",
        "iwb_design_reviews",
    ]:
        assert "permission denied" in database.sql(
            f"set role authenticated; select * from public.{table};", success=False
        )
        assert "permission denied" in database.sql(
            f"set role authenticated; delete from public.{table};", success=False
        )
    assert "permission denied" in database.sql(
        "set role anon; select public.iwb_practice('list_problems', '{}');", success=False
    )
    assert "User authentication" in database.sql(
        "set role authenticated; select public.iwb_practice('list_problems', '{}');", success=False
    )
    for key in [
        "owner_id",
        "user_id",
        "revision",
        "payload",
        "status",
        "requirements",
        "unexpected",
    ]:
        assert "not permitted" in database.call(
            "start_problem", {"problem_id": CODING, key: BOB}, success=False
        )
    assert "immutable" in database.sql(
        'update public.iwb_content set payload=payload || \'{"title":"changed"}\';', success=False
    )
    assert "immutable" in database.sql(
        "update public.iwb_checkpoints set label='changed';", success=False
    )
    assert "immutable" in database.sql(
        "update public.iwb_design_reviews set payload='{}';", success=False
    )


def test_row_policies_work_even_if_read_grants_are_added(database: Database) -> None:
    # Grants exist only in this rolled-back transaction. App RPC remains the sole data interface.
    query = f"""
      begin;
      grant select on public.iwb_design_sessions to authenticated;
      set local role authenticated;
      set local request.jwt.claims = '{{"sub":"{BOB}","role":"authenticated"}}';
      select count(*) from public.iwb_design_sessions;
      rollback;
    """
    assert database.sql(query) == "0"


def test_attempt_keeps_revision_after_catalog_update(database: Database) -> None:
    started = database.call("start_problem", {"problem_id": CODING})
    revision = "f" * 64
    database.sql(f"""
      begin;
      update public.iwb_content set available=false where kind='coding' and problem_id='{CODING}';
      insert into public.iwb_content(kind, problem_id, revision, payload, scaffold)
        select kind, problem_id, '{revision}', payload ||
          jsonb_build_object('title', 'Changed public title',
            'fallback_hints', jsonb_build_array('New hint one','New hint two','New hint three')),
          scaffold from public.iwb_content where kind='coding' and problem_id='{CODING}' limit 1;
      commit;
    """)
    attempt_id = started["attempt_id"]
    assert "Conveyor Permit Route" in database.call(
        "get_problem_description", {"attempt_id": attempt_id}
    )
    assert database.call("get_hint", {"attempt_id": attempt_id})["hint"] != "New hint one"
    fresh = database.call("start_problem", {"problem_id": CODING})
    assert fresh["problem_title"] == "Changed public title"
    assert database.call("get_hint", {"attempt_id": fresh["attempt_id"]})["hint"] == "New hint one"


@pytest.mark.parametrize(
    "changes, message",
    [
        ({"notes": {"unknown": "text"}}, "six design-note"),
        ({"notes": {"api": "x" * 5001}}, "six design-note"),
        ({"notes": {"api": None}}, "six design-note"),
        ({"diagram": [{"id": "a", "type": "rectangle", "unexpected": True}]}, "Invalid diagram"),
        ({"diagram": [{"id": "a", "type": "rectangle", "label": None}]}, "Invalid diagram"),
        ({"diagram": [{"id": "a", "type": "rectangle", "from_id": 12}]}, "Invalid diagram"),
        ({"diagram": [{"id": str(i), "type": "rectangle"} for i in range(3001)]}, "too large"),
        (
            {
                "diagram": [
                    {"id": str(i), "type": "rectangle", "label": ", " * 900} for i in range(400)
                ]
            },
            "too large",
        ),
        ({"label": " "}, "label"),
        ({"scene_digest": "bad"}, "fingerprint"),
    ],
)
def test_invalid_evidence_does_not_create_checkpoint(database: Database, changes, message) -> None:
    session = database.call("start_design_session", {"problem_id": DESIGN})
    assert message in database.call(
        "save_design_checkpoint", checkpoint_arguments(session["id"], **changes), success=False
    )
    assert database.call("list_design_checkpoints", {"session_id": session["id"]}) == []


def test_full_diagram_and_unicode_notes_round_trip(database: Database) -> None:
    session = database.call("start_design_session", {"problem_id": DESIGN})
    diagram = [{"id": str(i), "type": "rectangle", "label": f"Client {i}"} for i in range(3000)]
    arguments = checkpoint_arguments(session["id"], diagram=diagram, notes={"api": "😀" * 5000})
    checkpoint = database.call("save_design_checkpoint", arguments)
    assert len(checkpoint["diagram"]) == 3000 and checkpoint["notes"]["api"] == "😀" * 5000
    assert database.call("save_design_checkpoint", arguments) == checkpoint


def test_compact_diagram_byte_limit_keeps_spaces_in_labels(database: Database) -> None:
    session = database.call("start_design_session", {"problem_id": DESIGN})
    diagram = [
        {
            "id": str(index),
            "type": "rectangle",
            "label": "",
            "kind": "",
            "label_truncated": False,
            "from_id": None,
            "to_id": None,
        }
        for index in range(400)
    ]

    def size():
        return len(json.dumps(diagram, ensure_ascii=False, separators=(",", ":")).encode())

    remaining = 700_000 - size()
    for element in diagram:
        count = min(1999, remaining)
        element["label"] = (", " * 1000)[:count]
        remaining -= count
    assert size() == 700_000
    arguments = checkpoint_arguments(session["id"], diagram=diagram)
    saved = database.call("save_design_checkpoint", arguments)
    assert saved["diagram"] == diagram
    diagram[-1]["label"] += "x"
    assert size() == 700_001
    assert "too large" in database.call(
        "save_design_checkpoint", {**arguments, "checkpoint_id": str(uuid4())}, success=False
    )


def local_report(plan, *, submitted=False):
    return {
        "attempt_id": plan["attempt_id"],
        "execution_id": str(uuid4()),
        "code_digest": "b" * 64,
        "submitted": submitted,
        "tests": [
            {
                "index": index,
                "actual": case["expected"],
                "user_stdout": "",
                "user_stderr": "",
                "error": None,
                "wall_time_ms": 1,
            }
            for index, case in enumerate(plan["test_cases"])
        ],
    }


def test_local_reports_are_owned_idempotent_and_explicitly_not_server_verified(
    database: Database,
) -> None:
    started = database.call("start_problem", {"problem_id": CODING})
    attempt_id = started["attempt_id"]
    plan = database.call("get_local_execution_plan", {"attempt_id": attempt_id})
    assert plan["function_name"] == "fewest_conveyor_steps"
    assert plan["verification"] == "not_server_verified"
    assert len(plan["test_cases"]) == 8
    report = local_report(plan)
    result = database.call("record_local_execution", report)
    assert result["all_passed"] and result["tests_total"] == 8
    assert result["execution_source"] == "local_report"
    assert result["tests"][0]["input"] == plan["test_cases"][0]["input"]
    assert database.call("record_local_execution", report) == result
    assert (
        database.sql(f"select status from public.iwb_attempts where id='{attempt_id}'")
        == "in_progress"
    )
    assert "immutable" in database.call(
        "record_local_execution", {**report, "submitted": True}, success=False
    )
    for operation, arguments in [
        ("get_local_execution_plan", {"attempt_id": attempt_id}),
        ("record_local_execution", report),
    ]:
        assert "Attempt not found" in database.call(operation, arguments, owner=BOB, success=False)
    submitted = local_report(plan, submitted=True)
    completed = database.call("record_local_execution", submitted)
    assert completed["completed"] and completed["test_run"]["all_passed"]
    assert completed["verification"] == "not_server_verified"
    assert database.call("record_local_execution", submitted) == completed
    assert (
        database.sql(
            f"select count(*) from public.iwb_local_executions where attempt_id='{attempt_id}'"
        )
        == "2"
    )
    assert (
        database.sql(f"select status from public.iwb_attempts where id='{attempt_id}'")
        == "completed"
    )
    assert "permission denied" in database.sql(
        "set role authenticated; select * from public.iwb_local_executions", success=False
    )
    assert "permission denied" in database.sql(
        "set role authenticated; select iwb_private.iwb_practice('list_problems','{}')",
        success=False,
    )


def test_failed_local_submission_does_not_complete_an_attempt(database: Database) -> None:
    started = database.call("start_problem", {"problem_id": CODING})
    attempt_id = started["attempt_id"]
    plan = database.call("get_local_execution_plan", {"attempt_id": attempt_id})
    report = local_report(plan, submitted=True)
    report["tests"][0]["error"] = "Local execution failed"
    result = database.call("record_local_execution", report)
    assert result["completed"] is False and result["test_run"]["tests_passed"] == 7
    assert (
        database.sql(f"select status from public.iwb_attempts where id='{attempt_id}'")
        == "in_progress"
    )
    forged = {
        **report,
        "execution_id": str(uuid4()),
        "tests": [{**case, "passed": True} for case in report["tests"]],
    }
    assert "Invalid local execution report" in database.call(
        "record_local_execution", forged, success=False
    )
    assert "not permitted" in database.call(
        "record_local_execution", {**report, "owner_id": ALICE}, success=False
    )


def test_conflicting_concurrent_checkpoint_writes_do_not_replace_evidence(
    database: Database,
) -> None:
    session = database.call("start_design_session", {"problem_id": DESIGN})
    arguments = checkpoint_arguments(session["id"])

    def save(label: str):
        try:
            return database.call("save_design_checkpoint", {**arguments, "label": label})
        except AssertionError as error:
            assert "immutable" in str(error)
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(save, ["First", "Second"]))
    assert sum(result is not None for result in results) == 1
    saved = database.call(
        "get_design_snapshot",
        {"session_id": session["id"], "checkpoint_id": arguments["checkpoint_id"]},
    )
    assert saved in results
