# Tools

This file defines the planned tool surface for the `interview-mcp` server.
It is a design contract. Treat changes to any signature or return type as an API change — deliberate and reviewed.

---

## `list_problems`

```python
list_problems(difficulty: str | None = None, tag: str | None = None) -> list[ProblemSummary]
```

**Inputs**

- `difficulty`: Optional filter. Accepted values: `"easy"`, `"medium"`, `"hard"`. Omit to return all difficulties.
- `tag`: Optional filter. Matches against a problem's pattern tags (e.g. `"hash-map"`, `"sliding-window"`). Omit to return all tags.

**Behavior**

Returns a filtered list of available problems. Does not return full problem content — descriptions, test cases, and starter code are only loaded when a problem is started.

**Returns**

A list of `ProblemSummary` objects. Each contains:

- `id` — stable problem identifier (e.g. `"0001-two-sum"`)
- `title` — human-readable name
- `difficulty` — `"easy"`, `"medium"`, or `"hard"`
- `tags` — list of pattern tags
- `status` — `"not_started"`, `"in_progress"`, or `"completed"`

---

## `start_problem`

```python
start_problem(problem_id: str) -> StartProblemResult
```

**Inputs**

- `problem_id`: Stable identifier for the problem to load (e.g. `"0001-two-sum"`). Use `list_problems` to browse available IDs.

**Behavior**

Loads the specified problem and sets it as the active problem for the session. Writes the problem description and a starter code file to disk so they are available as editable files in your IDE. Only one problem can be active at a time.

**Returns**

A `StartProblemResult` object containing:

- `attempt_id` — identifier for this attempt, required by `get_hint`, `run_tests`, and `submit_solution`
- `problem_title` — confirmation of which problem was loaded
- `files_written` — paths to the files written to disk
- `instructions` — short guidance string displayed in the IDE chat

---

## `get_hint`

```python
get_hint(attempt_id: str, current_code: str) -> HintResult
```

**Inputs**

- `attempt_id`: Identifier returned by `start_problem` for the current attempt.
- `current_code`: Your current solution code as a string. Used to tailor the hint to where you are in the problem.

**Behavior**

Returns a hint calibrated to your current code and how far into the problem you are. Hints never contain solution code.

**Returns**

A `HintResult` object containing:

- `hint` — the hint string to display in the IDE
- `depth` — the hint depth that was used (`1`, `2`, or `3`)

---

## `run_tests`

```python
run_tests(attempt_id: str, code: str, write_results: bool = False) -> TestRunResult
```

**Inputs**

- `attempt_id`: Identifier returned by `start_problem` for the current attempt.
- `code`: Your current solution code as a string.
- `write_results`: If true, writes the full untruncated test results to `test_results.json` in the current working directory. Defaults to false.

**Behavior**

Runs your code against the problem's test cases and returns a pass/fail result for each one. Passing tests return a slim result. Failing tests include truncated input, expected output, and actual output so you can diagnose what went wrong without flooding the context window. If `write_results` is true, the full untruncated results are written to disk regardless of pass/fail status.

**Returns**

A `TestRunResult` object containing:

- `passed` — count of tests that passed
- `failed` — count of tests that failed
- `total` — total number of test cases
- `results` — list of per-test objects. Passing tests include only `passed: true`. Failing tests also include `input`, `expected`, `actual` (all capped at 200 characters), and `stderr` if execution errored
- `results_path` — absolute path to the written results file, only present when `write_results` is true

---

## `submit_solution`

```python
submit_solution(attempt_id: str, code: str) -> SubmitResult
```

**Inputs**

- `attempt_id`: Identifier returned by `start_problem` for the current attempt.
- `code`: Your final solution code as a string.

**Behavior**

Runs all test cases one final time against your submitted code. If any test fails, returns a failure result with the test output — the attempt remains open so you can fix and resubmit. If all tests pass, marks the attempt as completed and returns two follow-up interviewer-style questions about your solution focused on complexity, edge cases, and trade-offs. The questions are not answered for you.

**Returns**

A `SubmitResult` object containing:

- `accepted` — boolean, true if all tests passed
- `test_run` — the full `TestRunResult` from the final run
- `follow_up_questions` — list of two strings, only present when `accepted` is true

---

## `get_progress`

```python
get_progress(limit: int = 50) -> ProgressReport
```

**Inputs**

- `limit`: Maximum number of recent attempts to include. Defaults to 50.

**Behavior**

Returns a summary of your practice history across all problems — how many you have completed, how many are in progress, and how many you have not started. Formatted for display directly in the IDE chat.

**Returns**

A `ProgressReport` object containing:

- `summary` — a short header string (e.g. `"3 completed, 1 in progress, 16 not started"`)
- `table` — a Markdown-formatted table with columns: `Problem`, `Difficulty`, `Status`, `Hints Used`, `Submitted At`
