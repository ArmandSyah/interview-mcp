"""Billing contracts in disposable PostgreSQL. No real account or payment is used.

Set INTERVIEW_TEST_CLOUD_POSTGRES=1 to use the normal Docker fixture.
INTERVIEW_TEST_BILLING_PG_BIN can instead select local PostgreSQL binaries.
That alternative creates an owned temporary cluster with a Unix socket and no TCP listener.
The Auth fixture tests SQL permissions and ownership, not Supabase token verification.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from uuid import uuid4

import pytest

ROOT = Path(__file__).resolve().parents[1]
ALICE = "11111111-1111-4111-8111-111111111111"
BOB = "22222222-2222-4222-8222-222222222222"
TABLES = "billing_checkouts, iwb_private.billing_subscriptions, iwb_private.billing_events"


class Database:
    def __init__(self, command: list[str]):
        self.command = command

    def sql(self, query: str, *, success: bool = True) -> str:
        result = subprocess.run(
            self.command,
            input=query,
            text=True,
            capture_output=True,
            timeout=40,
        )
        assert (result.returncode == 0) == success, (
            f"SQL call={query!r}, expected_success={success}, "
            f"actual_exit={result.returncode}, stdout={result.stdout!r}, stderr={result.stderr!r}"
        )
        return result.stdout.strip() if success else result.stderr

    def call(
        self,
        operation: str,
        *,
        account_id: str = ALICE,
        mode: str = "sandbox",
        role: str = "service_role",
        success: bool = True,
        **fields: object,
    ):
        data = {"account_id": account_id, "mode": mode, **fields}
        # Events have no caller-supplied owner. Their customer binding determines ownership.
        if operation == "apply_event":
            data.pop("account_id")
        args = json.dumps(data).replace("'", "''")
        result = self.sql(
            f"set role {role}; select public.iwb_billing('{operation}', '{args}'::jsonb);",
            success=success,
        )
        return json.loads(result) if success else result

    def bind(self, account_id: str = ALICE, mode: str = "sandbox", customer_id: str = "ctm_alice"):
        binding = self.call("customer", account_id=account_id, mode=mode)
        assert self.call(
            "bind_customer",
            account_id=account_id,
            mode=mode,
            binding_id=binding["binding_id"],
            customer_id=customer_id,
        ) == {"customer_id": customer_id}
        return binding["binding_id"]


@pytest.fixture(scope="module")
def billing_server():
    if os.environ.get("INTERVIEW_TEST_CLOUD_POSTGRES") != "1":
        pytest.skip("Opt-in disposable PostgreSQL billing contract test")
    options = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres"]
    native = os.environ.get("INTERVIEW_TEST_BILLING_PG_BIN")
    if native:
        binaries = Path(native).resolve()
        with tempfile.TemporaryDirectory(prefix="iwb-billing-pg-") as temporary:
            root = Path(temporary)
            data = root / "data"
            share = binaries.parents[3] / "share/postgresql" / binaries.parent.name
            initialized = subprocess.run(
                [
                    str(binaries / "initdb"),
                    "-D",
                    str(data),
                    "-U",
                    "postgres",
                    "--auth=trust",
                    "--no-locale",
                    "-E",
                    "UTF8",
                    "-L",
                    str(share),
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
            assert initialized.returncode == 0, initialized.stderr
            control = [str(binaries / "pg_ctl"), "-D", str(data), "-w"]
            started = subprocess.run(
                [*control, "-l", str(root / "server.log"), "-o", f"-F -h '' -k {root}", "start"],
                capture_output=True,
                text=True,
                timeout=30,
            )
            assert started.returncode == 0, started.stderr
            try:
                yield Database([str(binaries / "psql"), "-h", str(root), *options])
            finally:
                stopped = subprocess.run(
                    [*control, "-m", "immediate", "stop"],
                    capture_output=True,
                    timeout=15,
                )
                assert stopped.returncode == 0, stopped.stderr
        return
    name = "interview-billing-test-" + uuid4().hex[:12]
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
            "io.interview-workbench.test=billing-postgres",
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
            pytest.fail("Disposable billing PostgreSQL did not become ready")
        yield Database(["docker", "exec", "-i", name, "psql", "-h", "127.0.0.1", *options])
    finally:
        stopped = subprocess.run(
            ["docker", "stop", "--time", "5", name],
            capture_output=True,
            timeout=15,
        )
        assert stopped.returncode == 0, stopped.stderr


@pytest.fixture(scope="module")
def migrated_billing(billing_server: Database):
    billing_server.sql("""
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin bypassrls;
        create schema auth;
        create table auth.users(id uuid primary key);
        grant usage on schema auth to authenticated, anon;
        create function auth.jwt() returns jsonb language sql stable as
          $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
        create function auth.uid() returns uuid language sql stable as
          $$ select (auth.jwt()->>'sub')::uuid $$;
    """)
    for migration in sorted((ROOT / "supabase/migrations").glob("*.sql")):
        billing_server.sql(migration.read_text())
    return billing_server


@pytest.fixture
def database(migrated_billing: Database):
    migrated_billing.sql(f"""
        truncate iwb_private.{TABLES}, iwb_private.billing_customers;
        delete from auth.users;
        insert into auth.users values ('{ALICE}'), ('{BOB}');
    """)
    return migrated_billing


def event(**changes: object) -> dict[str, object]:
    return {
        "event_id": "evt_" + uuid4().hex,
        "occurred_at": "2030-01-01T00:00:00Z",
        "subscription_id": "sub_alice",
        "customer_id": "ctm_alice",
        "status": "active",
        "price_id": "pri_monthly_10_usd",
        "price_matches": True,
        "current_period_end": "2100-02-01T00:00:00Z",
        "scheduled_cancel_at": None,
        "payload_hash": "a" * 64,
        **changes,
    }


def apply(database: Database, **changes: object):
    return database.call("apply_event", **event(**changes))


def test_customer_binding_is_durable_owned_and_environment_scoped(database: Database) -> None:
    first = database.call("customer")
    assert first["customer_id"] is None
    assert database.call("customer") == first
    assert "invalid" in database.call(
        "bind_customer",
        customer_id="ctm_missing_binding",
        success=False,
    )
    assert database.bind() == first["binding_id"]
    assert database.call(
        "bind_customer", binding_id=first["binding_id"], customer_id="ctm_other"
    ) == {
        "customer_id": "ctm_alice",
    }
    bob = database.call("customer", account_id=BOB)
    assert "invalid" in database.call(
        "bind_customer",
        account_id=BOB,
        binding_id=first["binding_id"],
        customer_id="ctm_stolen",
        success=False,
    )
    assert "unique" in database.call(
        "bind_customer",
        account_id=BOB,
        binding_id=bob["binding_id"],
        customer_id="ctm_alice",
        success=False,
    )
    assert database.bind(mode="live") != first["binding_id"]
    assert database.call("status", account_id=BOB) == {
        "mode": "sandbox",
        "status": "none",
        "entitled": False,
        "currentPeriodEnd": None,
        "scheduledCancelAt": None,
    }


@pytest.mark.parametrize("role", ["anon", "authenticated"])
def test_client_roles_cannot_call_billing_even_with_forged_claims(database: Database, role: str):
    assert "permission denied" in database.sql(
        f'set role {role}; set request.jwt.claims = \'{{"role":"service_role"}}\';'
        f'select public.iwb_billing(\'customer\', \'{{"mode":"sandbox",'
        f'"account_id":"{ALICE}"}}\');',
        success=False,
    )


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("table", ["customers", "checkouts", "events", "subscriptions"])
def test_billing_tables_deny_direct_access(database: Database, role: str, table: str):
    for statement in [
        f"select * from iwb_private.billing_{table}",
        f"delete from iwb_private.billing_{table}",
        f"insert into iwb_private.billing_{table} default values",
    ]:
        assert "permission denied" in database.sql(f"set role {role}; {statement};", success=False)


def test_concurrent_customer_and_checkout_claims_make_one_reservation(database: Database):
    with ThreadPoolExecutor(max_workers=4) as pool:
        bindings = list(pool.map(lambda _: database.call("customer"), range(4)))
    assert len({item["binding_id"] for item in bindings}) == 1
    database.bind()
    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = list(pool.map(lambda _: database.call("checkout_claim"), range(4)))
    assert sorted(item["state"] for item in claims) == ["claimed", "pending", "pending", "pending"]
    assert database.sql("select count(*) from iwb_private.billing_checkouts") == "1"
    database.bind(mode="live")
    assert database.call("checkout_claim", mode="live")["state"] == "claimed"


def test_first_checkout_reserves_before_provider_customer_creation(database: Database):
    claim = database.call("checkout_claim")
    assert claim["state"] == "claimed"
    assert database.call("customer")["customer_id"] is None
    assert "not bound" in database.call(
        "checkout_finish",
        reservation_id=claim["reservation_id"],
        transaction_id="txn_not_bound",
        checkout_url=None,
        success=False,
    )
    database.call("checkout_fail", reservation_id=claim["reservation_id"], uncertain=False)
    replacement = database.call("checkout_claim")
    database.bind()
    assert database.call(
        "checkout_finish",
        reservation_id=replacement["reservation_id"],
        transaction_id="txn_initial",
        checkout_url=None,
    ) == {"state": "ready"}


def test_checkout_failure_retry_preserves_new_reservation_and_owner(database: Database):
    database.bind()
    old = database.call("checkout_claim")["reservation_id"]
    database.call("checkout_fail", reservation_id=old, uncertain=False)
    new = database.call("checkout_claim")["reservation_id"]
    assert old != new
    assert "does not match" in database.call(
        "checkout_finish",
        reservation_id=old,
        transaction_id="txn_old",
        checkout_url=None,
        success=False,
    )
    database.bind(account_id=BOB, customer_id="ctm_bob")
    assert "does not match" in database.call(
        "checkout_fail",
        account_id=BOB,
        reservation_id=new,
        uncertain=False,
        success=False,
    )
    assert database.call("checkout_claim")["state"] == "pending"
    database.call("checkout_fail", reservation_id=new, uncertain=True)
    database.call("checkout_fail", reservation_id=new, uncertain=False)
    assert database.call("checkout_claim")["state"] == "uncertain"
    assert database.call(
        "checkout_finish",
        reservation_id=new,
        transaction_id="txn_known",
        checkout_url=None,
    ) == {"state": "ready"}
    database.call("checkout_fail", reservation_id=new, uncertain=False)
    assert database.call("checkout_claim") == {
        "state": "ready",
        "transaction_id": "txn_known",
        "checkout_url": None,
    }
    assert database.call(
        "checkout_finish",
        reservation_id=new,
        transaction_id="txn_known",
        checkout_url=None,
    ) == {"state": "ready"}
    assert "cannot change" in database.call(
        "checkout_finish",
        reservation_id=new,
        transaction_id="txn_replacement",
        checkout_url=None,
        success=False,
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"status": "trialing"},
        {"status": "past_due"},
        {"status": "paused"},
        {"status": "canceled"},
        {"price_matches": False},
        {"current_period_end": None},
        {"current_period_end": "2000-01-01T00:00:00Z"},
        {"scheduled_cancel_at": "2000-01-01T00:00:00Z"},
    ],
)
def test_access_requires_active_matching_plan_and_future_period(database: Database, changes):
    database.bind()
    assert apply(database, **changes) == {"outcome": "applied"}
    assert database.call("status")["entitled"] is False


def test_scheduled_cancellation_retains_access_until_paid_period_and_is_owned(database: Database):
    database.bind()
    assert apply(database, scheduled_cancel_at="2100-02-01T00:00:00Z") == {"outcome": "applied"}
    status = database.call("status")
    assert status["entitled"] is True
    assert status["scheduledCancelAt"] == status["currentPeriodEnd"]
    assert database.call("checkout_claim") == {"state": "subscribed"}
    assert database.call("status", account_id=BOB)["entitled"] is False
    assert database.call("status", mode="live")["entitled"] is False


def test_event_retries_stale_updates_and_changed_facts_cannot_restore_access(database: Database):
    database.bind()
    initial = event()
    assert database.call("apply_event", **initial) == {"outcome": "applied"}
    assert database.call("apply_event", **initial) == {"outcome": "duplicate"}
    assert database.call("apply_event", **{**initial, "payload_hash": "b" * 64}) == {
        "outcome": "conflict",
    }
    assert database.call("apply_event", **{**initial, "customer_id": "ctm_bob"}) == {
        "outcome": "conflict",
    }
    assert apply(database, status="canceled", occurred_at="2030-01-03T00:00:00Z") == {
        "outcome": "applied",
    }
    stale = event(occurred_at="2030-01-02T00:00:00Z")
    assert database.call("apply_event", **stale) == {"outcome": "stale"}
    assert database.call("apply_event", **stale) == {"outcome": "duplicate"}
    assert database.call("status")["status"] == "canceled"
    assert database.call("status")["entitled"] is False


@pytest.mark.parametrize("first,second", [("active", "canceled"), ("canceled", "active")])
def test_equal_timestamp_events_fail_closed_in_both_orders(database: Database, first, second):
    database.bind()
    assert apply(database, status=first) == {"outcome": "applied"}
    tie = event(status=second)
    assert database.call("apply_event", **tie) == {"outcome": "conflict"}
    assert database.call("status")["status"] == "needs_reconciliation"
    assert database.call("status")["entitled"] is False
    assert database.call("checkout_claim") == {"state": "uncertain"}
    assert database.call("apply_event", **tie) == {"outcome": "conflict"}
    assert apply(database, occurred_at="2030-01-02T00:00:00Z") == {"outcome": "applied"}
    assert database.call("status")["entitled"] is True


def test_unbound_event_can_retry_after_binding_without_losing_digest_guard(database: Database):
    pending = event()
    assert database.call("apply_event", **pending) == {"outcome": "unbound"}
    assert database.call("apply_event", **{**pending, "payload_hash": "b" * 64}) == {
        "outcome": "conflict",
    }
    database.bind()
    assert database.call("apply_event", **pending) == {"outcome": "applied"}
    assert database.call("apply_event", **pending) == {"outcome": "duplicate"}
    database.bind(mode="live")
    assert database.call("apply_event", mode="live", **pending) == {"outcome": "applied"}
    assert database.sql("select count(*) from iwb_private.billing_events") == "2"


def test_concurrent_duplicate_events_apply_once(database: Database):
    database.bind()
    pending = event()
    barrier = Barrier(4)

    def submit(_):
        barrier.wait(timeout=10)
        return database.call("apply_event", **pending)["outcome"]

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(submit, range(4)))
    assert sorted(results) == ["applied", "duplicate", "duplicate", "duplicate"]
    assert database.sql("select count(*) from iwb_private.billing_events") == "1"


def test_concurrent_first_subscription_claim_cannot_reassign_customer(database: Database):
    database.bind()
    database.bind(account_id=BOB, customer_id="ctm_bob")
    # Hold both first-insert candidates long enough to expose an unlocked INSERT/UPSERT race.
    database.sql("""
        create function iwb_private.test_delay_subscription() returns trigger language plpgsql as $$
        begin perform pg_sleep(0.2); return new; end $$;
        create trigger test_delay_subscription before insert on iwb_private.billing_subscriptions
          for each row execute function iwb_private.test_delay_subscription();
    """)
    barrier = Barrier(2)

    def submit(customer):
        barrier.wait(timeout=10)
        return customer, apply(database, customer_id=customer)["outcome"]

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = dict(pool.map(submit, ["ctm_alice", "ctm_bob"]))
        assert sorted(results.values()) == ["applied", "conflict"]
        winner = next(customer for customer, outcome in results.items() if outcome == "applied")
        assert (
            database.sql(
                "select customer_id from iwb_private.billing_subscriptions "
                "where subscription_id='sub_alice'"
            )
            == winner
        )
        assert database.call("status")["entitled"] == (winner == "ctm_alice")
        assert database.call("status", account_id=BOB)["entitled"] == (winner == "ctm_bob")
    finally:
        database.sql("""
            drop trigger test_delay_subscription on iwb_private.billing_subscriptions;
            drop function iwb_private.test_delay_subscription();
        """)


def test_existing_subscription_cannot_move_to_another_account(database: Database):
    database.bind()
    database.bind(account_id=BOB, customer_id="ctm_bob")
    assert apply(database) == {"outcome": "applied"}
    reassigned = event(customer_id="ctm_bob", occurred_at="2030-01-03T00:00:00Z")
    assert database.call("apply_event", **reassigned) == {"outcome": "conflict"}
    assert database.call("apply_event", **reassigned) == {"outcome": "conflict"}
    assert database.call("status")["entitled"] is True
    assert database.call("status", account_id=BOB)["entitled"] is False


def test_account_cleanup_retains_billing_binding_without_restoring_access(database: Database):
    database.bind()
    database.call("checkout_claim")
    apply(database)
    database.sql(f"delete from auth.users where id='{ALICE}';")
    assert (
        database.sql(
            "select account_id is null from iwb_private.billing_customers "
            "where customer_id='ctm_alice'"
        )
        == "t"
    )
    for table in ["customers", "checkouts", "subscriptions", "events"]:
        assert database.sql(f"select count(*) from iwb_private.billing_{table}") == "1"
    assert "does not exist" in database.call("status", success=False)
    database.bind(account_id=BOB, customer_id="ctm_bob")
    bob = database.call("customer", account_id=BOB)
    assert database.call(
        "bind_customer",
        account_id=BOB,
        binding_id=bob["binding_id"],
        customer_id="ctm_alice",
    ) == {"customer_id": "ctm_bob"}
    assert database.call("status", account_id=BOB)["entitled"] is False
    assert apply(database, occurred_at="2030-01-02T00:00:00Z") == {"outcome": "unbound"}


def test_billing_changes_do_not_replace_existing_practice_records(database: Database):
    claims = json.dumps({"sub": ALICE, "role": "authenticated"})
    database.sql(
        f"set role authenticated; set request.jwt.claims='{claims}';"
        "select public.iwb_practice('start_problem', "
        '\'{"problem_id":"0011-conveyor-permit-route"}\');'
        "select public.iwb_practice('start_design_session', "
        '\'{"problem_id":"design-link-aliases"}\');'
    )
    query = """
        select jsonb_build_object(
          'content', (select jsonb_agg(to_jsonb(t) order by kind, problem_id, revision)
            from public.iwb_content t),
          'attempts', (select jsonb_agg(to_jsonb(t) order by id) from public.iwb_attempts t),
          'designs', (select jsonb_agg(to_jsonb(t) order by id) from public.iwb_design_sessions t)
        );
    """
    before = database.sql(query)
    database.bind()
    apply(database)
    apply(database, status="past_due", occurred_at="2030-01-02T00:00:00Z")
    apply(database, status="canceled", occurred_at="2030-01-03T00:00:00Z")
    assert database.sql(query) == before


@pytest.mark.parametrize(
    "changes",
    [
        {"mode": "preview"},
        {"payload_hash": "bad"},
        {"price_matches": "true"},
        {"occurred_at": None},
        {"occurred_at": "infinity"},
        {"current_period_end": "infinity"},
        {"status": "paid"},
        {"raw_payload": {"email": "do-not-retain@example.invalid"}},
    ],
)
def test_invalid_events_leave_no_partial_billing_records(database: Database, changes):
    database.bind()
    database.call("apply_event", **event(**changes), success=False)
    assert database.sql("select count(*) from iwb_private.billing_events") == "0"
    assert database.sql("select count(*) from iwb_private.billing_subscriptions") == "0"
