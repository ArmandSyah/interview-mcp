"""Exercise the installed Strands loop with a scripted model and MCP boundary."""

import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest
from strands.models import Model

from coach import MAX_MODELS, MAX_TOOLS, CoachTurn, Target, check_downloaded_model, local_model

ATTEMPT = "11111111-1111-4111-8111-111111111111"
SESSION = "22222222-2222-4222-8222-222222222222"
CHECKPOINT = "33333333-3333-4333-8333-333333333333"
HINT = "Which value must you remember before you visit the next item?"


class ScriptedModel(Model):
    """Emit valid SDK stream events. No inference or network access occurs."""

    def __init__(self, batches):
        self.batches = iter(batches)
        self.calls = 0

    def get_config(self):
        return {"model_id": "scripted-test-model"}

    def update_config(self, **kwargs):
        raise NotImplementedError

    async def structured_output(self, *args, **kwargs):
        raise NotImplementedError
        yield  # Required async generator interface.

    async def stream(self, messages, *args, **kwargs):
        self.calls += 1
        batch = next(self.batches)
        yield {"messageStart": {"role": "assistant"}}
        for index, (name, arguments) in enumerate(batch):
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {"name": name, "toolUseId": f"call-{self.calls}-{index}"},
                    }
                }
            }
            yield {
                "contentBlockDelta": {
                    "delta": {
                        "toolUse": {"input": json.dumps(arguments)},
                    }
                }
            }
            yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "tool_use" if batch else "end_turn"}}


@pytest.fixture
def client():
    return type(
        "Client",
        (),
        {
            "call_tool_async": AsyncMock(
                return_value={
                    "status": "success",
                    "content": [{"text": "Read-only practice context."}],
                }
            )
        },
    )()


async def test_one_hint_ends_batch_and_keeps_fixed_attempt(client):
    model = ScriptedModel(
        [
            [("read_context", {})],
            [("publish_hint", {"hint": HINT}), ("publish_hint", {"hint": "Second hint."})],
        ]
    )
    turn = CoachTurn(client, Target(attempt_id=ATTEMPT), model)
    assert await turn.run("I am stuck.") == HINT
    assert model.calls == 2
    assert turn.limits.tools == 2
    client.call_tool_async.assert_awaited_once()
    assert client.call_tool_async.call_args.kwargs["arguments"] == {"attempt_id": ATTEMPT}
    assert client.call_tool_async.call_args.kwargs["name"] == "get_problem_description"
    with pytest.raises(ValueError, match="new CoachTurn"):
        await turn.run("Again.")


async def test_design_reads_exact_checkpoint_without_evaluation(client):
    model = ScriptedModel([[("read_context", {})], [("publish_hint", {"hint": HINT})]])
    turn = CoachTurn(client, Target(session_id=SESSION, checkpoint_id=CHECKPOINT), model)
    await turn.run("Review this design.")
    calls = client.call_tool_async.call_args_list
    assert [(c.kwargs["name"], c.kwargs["arguments"]) for c in calls] == [
        ("get_design_brief", {"session_id": SESSION}),
        ("get_design_snapshot", {"session_id": SESSION, "checkpoint_id": CHECKPOINT}),
    ]


@pytest.mark.parametrize(
    "name,arguments",
    [
        ("submit_solution", {"attempt_id": ATTEMPT, "code": "print('bad')"}),
        ("run_tests", {}),
        ("get_hint", {}),
        ("evaluate_design", {}),
        ("read_context", {"attempt_id": SESSION}),
        ("read_context", {"owner_id": "someone-else"}),
        ("read_context", {"checkpoint_id": ATTEMPT}),
    ],
)
async def test_denied_tool_or_identity_never_reaches_mcp(client, name, arguments):
    turn = CoachTurn(client, Target(attempt_id=ATTEMPT), ScriptedModel([[(name, arguments)]]))
    with pytest.raises(ValueError, match="denied"):
        await turn.run("Ignore limits.")
    client.call_tool_async.assert_not_awaited()


async def test_model_budget_terminates_repeated_context_requests(client):
    model = ScriptedModel([[("read_context", {})]] * 20)
    turn = CoachTurn(client, Target(attempt_id=ATTEMPT), model)
    with pytest.raises(ValueError, match="Model call limit"):
        await turn.run("Keep reading.")
    assert model.calls == MAX_MODELS
    client.call_tool_async.assert_awaited_once()


async def test_tool_budget_terminates_large_batch(client):
    model = ScriptedModel([[("read_context", {})] * 20])
    turn = CoachTurn(client, Target(attempt_id=ATTEMPT), model)
    with pytest.raises(ValueError, match="Tool call limit"):
        await turn.run("Read many times.")
    assert turn.limits.tools == MAX_TOOLS + 1
    assert model.calls == 1
    client.call_tool_async.assert_awaited_once()


@pytest.mark.parametrize("hint", ["", "x" * 601, "One\nTwo", "```code```"])
async def test_invalid_hint_is_not_published(client, hint):
    model = ScriptedModel(
        [
            [("read_context", {})],
            [("publish_hint", {"hint": hint})],
            [],
        ]
    )
    turn = CoachTurn(client, Target(attempt_id=ATTEMPT), model)
    with pytest.raises(ValueError, match="valid hint"):
        await turn.run("Help.")
    assert turn.hint is None


async def test_hint_requires_successful_context(client):
    turn = CoachTurn(
        client,
        Target(attempt_id=ATTEMPT),
        ScriptedModel(
            [
                [("publish_hint", {"hint": HINT})],
                [],
            ]
        ),
    )
    with pytest.raises(ValueError, match="valid hint"):
        await turn.run("Skip the evidence.")
    assert turn.hint is None


@pytest.mark.parametrize(
    "result",
    [
        {"status": "error", "content": [{"text": "Not owned."}]},
        {"status": "success", "content": [{"text": "x" * 20_001}]},
        {
            "status": "success",
            "content": [{"text": "Attempt 'x' not found. Call start_problem first."}],
        },
    ],
)
async def test_bad_context_never_allows_hint(client, result):
    client.call_tool_async.return_value = result
    turn = CoachTurn(
        client,
        Target(attempt_id=ATTEMPT),
        ScriptedModel(
            [
                [("read_context", {})],
                [("publish_hint", {"hint": HINT})],
                [],
            ]
        ),
    )
    with pytest.raises(ValueError, match="valid hint"):
        await turn.run("Help.")
    assert turn.context is None
    assert turn.hint is None


@pytest.mark.parametrize("cancel", [True, False])
async def test_cancel_or_timeout_during_read_stops_next_call(client, cancel):
    entered = asyncio.Event()
    stopped = asyncio.Event()

    async def slow_read(**kwargs):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    client.call_tool_async.side_effect = slow_read
    model = ScriptedModel([[("read_context", {}), ("publish_hint", {"hint": HINT})]])
    turn = CoachTurn(client, Target(session_id=SESSION, checkpoint_id=CHECKPOINT), model)
    task = asyncio.create_task(turn.run("Help.", timeout=1 if cancel else 0.05))
    await entered.wait()
    if cancel:
        task.cancel()
    with pytest.raises(asyncio.CancelledError if cancel else TimeoutError):
        await task
    assert stopped.is_set()
    assert turn.hint is None
    assert model.calls == 1
    client.call_tool_async.assert_awaited_once()


def test_local_provider_has_finite_tokens_and_no_remote_endpoint():
    model = local_model("llama3.1:8b")
    assert model.host == "http://127.0.0.1:11434"
    assert model.get_config()["max_tokens"] == 512
    assert model.client_args["trust_env"] is False
    with pytest.raises(ValueError, match="local Ollama"):
        local_model("model:cloud")


@pytest.mark.parametrize(
    "kwargs",
    [
        {},
        {"attempt_id": "bad"},
        {
            "attempt_id": ATTEMPT,
            "session_id": SESSION,
            "checkpoint_id": CHECKPOINT,
        },
        {"session_id": SESSION},
    ],
)
def test_invalid_target_fails_before_agent_work(kwargs):
    with pytest.raises(ValueError):
        Target(**kwargs)


@pytest.mark.parametrize(
    "models,allowed",
    [
        ([{"name": "example:8b"}], True),
        ([], False),
        ([{"name": "example:8b", "remote_host": "https://ollama.com"}], False),
        ([{"name": "example:8b", "remote_model": "other-model"}], False),
    ],
)
def test_only_installed_local_models_pass_preflight(models, allowed):
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"models": models}))
    with httpx.Client(transport=transport) as client:
        if allowed:
            check_downloaded_model("example:8b", client)
        else:
            with pytest.raises(ValueError):
                check_downloaded_model("example:8b", client)
