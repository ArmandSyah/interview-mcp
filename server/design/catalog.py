"""Original public practice curriculum. No scraped interview questions."""

from __future__ import annotations

import hashlib
import json

from server.design.schemas import Criterion, DesignBrief, DesignProblem, DesignSummary

RUBRIC = [
    Criterion(
        key="requirements",
        title="Requirements",
        prompt="Which requirements are essential, and which are explicitly out of scope?",
    ),
    Criterion(
        key="api",
        title="API and contracts",
        prompt="Trace one request end to end. What does success mean to its caller?",
    ),
    Criterion(
        key="data",
        title="Data and ownership",
        prompt=(
            "Who owns the authoritative state, and which access patterns shape its representation?"
        ),
    ),
    Criterion(
        key="capacity",
        title="Capacity assumptions",
        prompt=(
            "Name your assumptions and units. Which estimate would actually change a design choice?"
        ),
    ),
    Criterion(
        key="tradeoffs",
        title="Decisions and tradeoffs",
        prompt="What alternative did you reject, and what would make it preferable?",
    ),
    Criterion(
        key="failure_modes",
        title="Failure modes",
        prompt="Trace a partial failure. What can users observe, and how is recovery bounded?",
    ),
]

_CASES: list[dict[str, object]] = [
    {
        "id": "design-link-aliases",
        "title": "Link Alias Service",
        "difficulty": "medium",
        "tags": ["read-heavy", "data-model", "caching"],
        "brief_md": (
            "A small publishing platform needs short links for customer campaigns. "
            "Design creation and redirection of aliases. Start with a service the team "
            "can operate today; justify any added scale or complexity."
        ),
        "requirements": [
            "Create an alias for a destination URL and redirect visitors.",
            "Owners can disable an alias; explain when that change becomes visible.",
            "Define behavior for unknown, expired, and disabled aliases.",
            "Prevent one customer's aliases from being managed by another customer.",
        ],
        "constraints": [
            (
                "Assume 20 million redirects and 100,000 creations per day, "
                "with a 5x peak-to-average factor."
            ),
            "Target p95 redirect latency below 150 ms; explain the boundary of that measurement.",
            "The initial team has four engineers and one region.",
            "Campaign links may be abused; specify a bounded abuse-control approach.",
        ],
        "scenarios": [
            "A popular campaign becomes 30% of redirect traffic.",
            "A malicious destination must be disabled within one minute.",
            "Your primary state store is unavailable for ten minutes.",
        ],
        "hints": [
            "Separate creation, redirection, and disabling. What must each caller observe?",
            (
                "Compare the access patterns and correctness needs before deciding "
                "where caching is acceptable."
            ),
            (
                "Trace a cached redirect after its owner disables the alias. "
                "Make the visibility guarantee and failure behavior explicit."
            ),
        ],
    },
    {
        "id": "design-request-admission",
        "title": "Distributed Request Admission",
        "difficulty": "hard",
        "tags": ["concurrency", "correctness", "rate-limiting"],
        "brief_md": (
            "An API platform needs per-customer request admission across multiple "
            "application instances. Define the admission contract before choosing "
            "a counter or algorithm. Explain the accuracy-versus-availability tradeoff."
        ),
        "requirements": [
            "Apply separate customer quotas and return a useful rejection response.",
            "State whether the policy permits bursts and how replenishment works.",
            "Define what happens when two instances admit a request concurrently.",
            "Support quota changes without allowing cross-customer interference.",
        ],
        "constraints": [
            "Assume 50,000 admission checks per second across 100 application instances.",
            (
                "An example customer is entitled to 100 requests per second; "
                "you must define a precise policy around that number."
            ),
            "Budget 10 ms p95 additional admission latency.",
            "Requests may be retried, and instance clocks may disagree.",
        ],
        "scenarios": [
            "The shared admission state becomes unreachable in one availability zone.",
            "One tenant generates half of all checks.",
            "An operator reduces a quota while requests are in flight.",
        ],
        "hints": [
            (
                "What exact event consumes quota, and what invariant must hold "
                "across concurrent callers?"
            ),
            "Work through a tiny burst and a retry before comparing state-placement choices.",
            (
                "Explain a partition: what is the maximum admitted traffic under your failure "
                "policy, and which requirement pays for that choice?"
            ),
        ],
    },
    {
        "id": "design-notification-delivery",
        "title": "Notification Delivery Pipeline",
        "difficulty": "medium",
        "tags": ["queues", "idempotency", "retries"],
        "brief_md": (
            "A product sends transactional email and mobile notifications. "
            "Design an observable delivery workflow from an accepted request to "
            "an external provider. Treat delivery guarantees and user preferences "
            "as explicit contracts."
        ),
        "requirements": [
            "Accept notification requests with customer-specific preferences.",
            (
                "Track acceptance, provider handoff, failures, and any delivery signals "
                "the provider supports."
            ),
            "Make retries bounded and define duplicate behavior.",
            (
                "Allow an operator to inspect a failed request without exposing "
                "another customer's messages."
            ),
        ],
        "constraints": [
            "Assume 5 million requests per day, with a 10x peak.",
            "Transactional requests should normally reach a provider within 60 seconds.",
            "Provider calls have rate limits, transient errors, and ambiguous timeout outcomes.",
            "Some notifications are no longer useful after their expiry time.",
        ],
        "scenarios": [
            "The primary provider is unavailable for an hour.",
            "A worker crashes after provider acceptance but before recording success.",
            "A user disables a channel while a queued notification waits.",
        ],
        "hints": [
            (
                "List the states you can truthfully observe. "
                "Does provider acceptance prove user delivery?"
            ),
            (
                "Choose where the request identity survives retries, "
                "and which transitions need to be durable."
            ),
            (
                "Trace a crash after a successful external side effect. Explain what your system "
                "can guarantee without assuming a transaction with the provider."
            ),
        ],
    },
    {
        "id": "design-following-feed",
        "title": "Following Feed",
        "difficulty": "hard",
        "tags": ["fanout", "pagination", "read-write-tradeoffs"],
        "brief_md": (
            "Design a chronological feed of posts from accounts a user follows. "
            "Explain the read and write paths, visibility changes, and pagination "
            "behavior. Keep ranking and advertising outside the initial scope."
        ),
        "requirements": [
            "Publish a post and read a paginated chronological following feed.",
            "Define visibility of deleted posts and changed follow relationships.",
            "Explain ordering when timestamps tie or clocks differ.",
            "Prevent private posts from leaking through cached or precomputed feeds.",
        ],
        "constraints": [
            "Assume 2 million daily active users and 20 feed opens per active user per day.",
            "A typical user follows 200 accounts; a few publishers have millions of followers.",
            "State an explicit freshness target and its failure behavior.",
            "Older pages may be read while new posts arrive.",
        ],
        "scenarios": [
            "A publisher with five million followers posts repeatedly.",
            "A user unfollows an account during pagination.",
            "A delayed worker processes a post after that post was deleted.",
        ],
        "hints": [
            (
                "Start with one user's read path. Which correctness decisions belong "
                "to ordering, membership, and visibility?"
            ),
            (
                "Compare when work happens for reads and writes, "
                "including an unusually large publisher."
            ),
            (
                "Trace a delayed update after deletion. What remains authoritative at read time, "
                "and which shortcuts are safe?"
            ),
        ],
    },
    {
        "id": "design-object-vault",
        "title": "Object Upload and Retrieval",
        "difficulty": "hard",
        "tags": ["storage", "integrity", "lifecycle"],
        "brief_md": (
            "A team needs customer-owned object upload, download, listing, and deletion. "
            "Design the metadata and object lifecycle, including partial uploads and "
            "authorization. Do not assume that upload completion alone proves durability."
        ),
        "requirements": [
            "Upload large objects with retries and verify their integrity.",
            "List a customer's completed objects and authorize every download.",
            "Define overwrite, concurrent upload, and deletion semantics.",
            "Bound storage consumed by unfinished or abandoned uploads.",
        ],
        "constraints": [
            "Assume 10 million objects, a 20 MB average size, and a 5 GB maximum object size.",
            "Support unreliable clients without restarting every large upload.",
            (
                "The initial deployment uses one region; specify the durability "
                "and availability goals separately."
            ),
            "Deletion and retention requirements must be stated rather than assumed.",
        ],
        "scenarios": [
            "A client completes data transfer but times out before receiving confirmation.",
            "Metadata commits while one object-storage operation fails.",
            "An object is deleted while an existing download link is still valid.",
        ],
        "hints": [
            "Name the authoritative states for an unfinished upload and a downloadable object.",
            (
                "Trace retries at the boundary between metadata and object bytes. "
                "What identifies the same operation?"
            ),
            (
                "Work through confirmation loss and deletion independently. Explain how integrity, "
                "authorization, and cleanup interact without assuming atomic cross-system writes."
            ),
        ],
    },
]


def _build(raw: dict[str, object]) -> DesignProblem:
    problem = DesignProblem.model_validate({**raw, "rubric": RUBRIC})
    serialized = json.dumps(
        problem.model_dump(exclude={"revision"}), sort_keys=True, separators=(",", ":")
    )
    problem.revision = hashlib.sha256(serialized.encode()).hexdigest()
    return problem


PROBLEMS = {problem.id: problem for problem in map(_build, _CASES)}


def get_problem(problem_id: str) -> DesignProblem:
    problem = PROBLEMS.get(problem_id)
    if problem is None:
        problem = next((item for item in _installed_designs() if item.id == problem_id), None)
    if problem is None:
        raise ValueError("Design problem is not available.")
    return problem.model_copy(deep=True)


def brief(problem: DesignProblem) -> DesignBrief:
    return DesignBrief.model_validate(problem.model_dump(exclude={"hints"}))


def summaries() -> list[DesignSummary]:
    return [
        DesignSummary.model_validate(problem.model_dump())
        for problem in [*PROBLEMS.values(), *_installed_designs()]
    ]


def _installed_designs() -> list[DesignProblem]:
    from server.distribution.packs import active_manifests

    result = []
    for pack in active_manifests():
        for problem in pack.design:
            serialized = json.dumps(problem.model_dump(exclude={"revision"}), sort_keys=True)
            problem.revision = hashlib.sha256(serialized.encode()).hexdigest()
            result.append(problem)
    return result
