# Task 4 report: Pi telemetry diagnostic scenarios

## Result

- Implementation commit: `f6eb1781637ce785071445c9bc91d4a638338d17` (`test: cover Pi telemetry scenarios`).
- Claim-review fix: `e7c84dbed1fd041d6520049b1e53283fc3c2896b` (`test: harden telemetry scenario fixtures`).
- Five content-free JSONL scenarios exercise current Pi SDK lifecycle facts through `PiEventMapper`.
- Scenario output crosses the real `TelemetrySocketClient` LF queue and acknowledgement boundary.
- No provider, model, token, UI, or trajectory-view call runs in the scenario test.

## RED evidence

Harness ran before fixtures existed:

```text
node tests/pi-telemetry-scenarios-test.mjs
Error: ENOENT: no such file or directory, scandir '.../tests/fixtures/telemetry'
exit 1
```

Failure matched missing Task 4 fixtures.

After fixtures loaded, model-stall assertion reached missing mapper support:

```text
PASS cancelled: 4 normalized records
FAIL TypeError: mapper.observeStall is not a function
exit 1
```

Failure matched missing stall observation behavior. No production change preceded either RED run.

## GREEN evidence

Focused scenario command after minimal mapper support:

```text
node tests/pi-telemetry-scenarios-test.mjs
PASS cancelled: 4 normalized records
PASS long-tool: 4 normalized records
PASS model-stall: 3 normalized records
PASS normal: 6 normalized records
PASS tool-error: 4 normalized records
PASS integrated queue boundary: 21/21 accepted
PASS fixture loader rejects malformed JSONL, expectations, unsafe attributes, and name drift
exit 0
```

Independent claim review found that the first loader version required strings but did not validate expectation enums or restrict expected attribute names. Follow-up RED:

```text
node tests/pi-telemetry-scenarios-test.mjs
AssertionError: Missing expected exception: loader accepted invalid expectation enums
exit 1
```

Follow-up GREEN validates allowed kind, phase, severity, and state values plus a closed expectation-attribute set. The focused scenario command above then passed again.

Task 3 integration regression:

```text
node tests/pi-telemetry-test.mjs
PASS normal zero-token telemetry fixture
exit 0
```

Other requested gates:

```text
npm run check:protocol
PROTOCOL_VERSION v10 match passed
exit 0

npm run typecheck
exit 0

npm test -- --run
Test Files  29 passed (29)
Tests  313 passed (313)
exit 0

npm run build
vite: 549 modules transformed
build:web exit 0
build:server exit 0

git diff --check
exit 0
```

## Scenario results

- Normal: run, turn, tool start/end, turn end, run end retain causal order. Tool, turn, run durations are 50 ms, 70 ms, 90 ms.
- Model stall: 179,999 ms emits nothing. Exactly 180,000 ms emits one `agent.stall` warning in `possibly_stalled` state. It emits no end, completion, or cancellation record.
- Long tool: an observation before threshold emits nothing. Tool end retains its original request parent plus 240,000 ms duration.
- Tool error: tool end retains `kind=tool.execution`, `state=error`, `severity=error`, `is_error=true`, matching parent. Injected private argument/result sentinels do not appear in telemetry.
- Cancellation: turn and run end as `cancelled` with warning severity. No record has completed state.
- Loader: malformed JSONL, missing required expectation state, invalid expectation enums, unsafe or unknown expectation attributes, fixture/file name mismatch, and missing scenario files are rejected.
- Queue: all 21 normalized records receive valid FIFO LF acknowledgements. Queue reports zero rejected records, errors, or gaps.

## Smoke boundary

`npm run test:smoke` did not pass as a full aggregate:

```text
31/33 通过
✗ settings-test
✗ vscode-editor-plugin-test
exit 1
```

`settings-test` reproduced the existing `skill re-enabled` failure at `27 passed, 1 failed`. Task 4 did not change settings code.

`vscode-editor-plugin-test` completed 25 checks, then hit temporary cleanup `ENOTEMPTY` under its generated plugin `node_modules`. One immediate isolated rerun passed with exit 0. No Task 4 file overlaps that test or plugin.

Telemetry smoke passed inside the aggregate. This report does not claim full smoke closure.

## Limits

- `observeStall()` maps an explicit polling observation. Task 4 does not change Pi's existing UI timer, abort policy, or trajectory view.
- Stall is an observation, not proof of failure. Deep model work can remain quiet for 180 seconds.
- Fixtures use narrow lifecycle descriptors. Harness supplies SDK-required empty message metadata plus private tool sentinels in memory; fixture files contain no prompts, provider headers, tool args, tool results, or secrets.
- No live UnifiedAgent telemetry service acceptance, provider call, model token, browser, or user-observed UI run occurred.
- Full smoke remains open at existing settings failure. Aggregate also exposed one non-reproduced cleanup race.

## Changed files

- `server/telemetry/pi-event-mapper.ts`
- `tests/pi-telemetry-scenarios-test.mjs`
- `tests/fixtures/telemetry/normal.jsonl`
- `tests/fixtures/telemetry/model-stall.jsonl`
- `tests/fixtures/telemetry/long-tool.jsonl`
- `tests/fixtures/telemetry/tool-error.jsonl`
- `tests/fixtures/telemetry/cancelled.jsonl`
- `.superpowers/sdd/2026-08-31-pi-telemetry-adapter/task-4-report.md`
