# Task 3 report: minimal conversation telemetry integration

Date: 2026-08-31

Evidence level: `Contract-tested | Integration-tested | Synthetic-only`

## Architecture reset

All earlier Task 3 work was reverted newest-first with `git revert --no-edit`. The tree then matched approved Task 2 commit `af86aac` with no diff.

Revert commits:

- `ebae0a8` reverts `925c366`
- `b718415` reverts `d9b5e2d`
- `425c6e6` reverts `91e8e88`
- `76a484c` reverts `266d6bc`
- `554c169` reverts `542f06d`
- `47a18a2` reverts `1fffb51`
- `b73b708` reverts `279b4b8`
- `647fb10` reverts `200f745`

Fresh implementation commit:

- `04f3f8b` (`feat: emit current Pi run telemetry`)
- `f095187` (`fix: account for Pi telemetry adapter failures`)

## Result

Server creates one optional process-level `TelemetrySocketClient` only when trimmed `UA_TELEMETRY_SOCKET` is nonempty. Missing configuration creates no client or conversation mapper.

No-env systemd `/pi-web-ui:quit` keeps baseline immediate `process.exit(3)` behavior without waiting for session or telemetry disposal. Graceful SIGTERM and normal close paths still dispose conversations before shared telemetry client.

Each conversation owns one stable telemetry conversation ID plus mapper for its currently bound concrete Pi session. `bindSession(conv = this.conv)` preserves original active call sites and extension/subscription order. Successful binding replaces mapper, then one subscription maps and emits before existing UI projection. Telemetry mapping, enqueue, and disposal failures are swallowed. Existing `onEvent()` always runs.

Mapper correlation keeps stable conversation metadata while its ID namespace contains concrete Pi session ID plus nonsecret bind UUID. Edit/fork rebinds cannot reuse trace, turn, step, request, or tool IDs.

Background force reset passes its target conversation to `bindSession(conv)`. Existing edit, new-chat, cwd, and persisted-session ownership semantics remain unchanged.

## TDD evidence

All fixtures use temp directories, fake SDK events, zero-token messages, and a fake LF Unix socket. No provider prompt ran.

1. Mapper namespace RED:
   - expected `conversation-stable:session-a:run:1`
   - received `conversation-stable:run:1`
   - tool correlation expected `conversation-stable:session-b:tool:reused-tool-id`
   - received `reused-tool-id`
2. Server integration RED:
   - `server telemetry lifecycle exports are missing`
3. Rejected extension bind RED:
   - `rejected extension bind retained stale telemetry mapper`
4. Systemd quit RED:
   - `systemd quit waited for cleanup instead of exiting 3: status=null signal=SIGKILL`
5. Client health API RED:
   - expected `recordFailure` type `function`
   - received `undefined`
6. Adapter health RED:
   - `mapper construction failure was not accounted`

Each RED failed on missing Task 3 behavior. Minimal source changes then made focused tests pass.

## Integration points

- `server/index.ts`
  - Builds source metadata from hostname, optional `UA_ROBOT_ID`, optional `UA_AGENT_INSTANCE_ID`, component, and Pi version.
  - Injects source plus shared client emitter into `AgentService`.
  - Disposes all client sessions before shared telemetry client during shutdown.
  - Preserves immediate systemd supervised-quit exit code 3 without cleanup await.
  - Connects adapter failure callback to shared client health counters.
- `server/agent-service.ts`
  - Adds optional `AgentServiceTelemetry` constructor injection.
  - Adds only `telemetryConversationId` and `telemetryMapper` to `Conversation`.
  - Rebinds mapper from actual `conv.runtime.session` after extension binding succeeds.
  - Disposes stale mapper when extension binding rejects.
  - Enriches mapped records with cwd, project name, and UI conversation ID. Prompt text, tool arguments/results, provider headers, and full SDK objects are not exported.
  - Disposes mapper during force reset, conversation removal, and session disposal.
  - Passes only force-reset target into `bindSession(conv)`; other call sites remain active-default.
  - Accounts for construction, mapping, enqueue, and disposal failures. Health callback errors remain swallowed.
- `server/telemetry/client.ts`
  - Adds public `recordFailure(lostRecords)`: every adapter failure increments `errors`; positive explicit loss increments `gaps` by that count.
- `server/telemetry/pi-event-mapper.ts`
  - Adds optional `idNamespace`; existing Task 2 callers keep prior correlation format.
  - Task 3 supplies session-aware namespace for run/turn/step/request/tool identity.
- `tests/pi-telemetry-test.mjs`
  - Covers no-env baseline and immediate systemd exit, ordered mapping, metadata/privacy, unchanged WebSocket snapshot, health/failure isolation, two conversations, background reset, edit/fork namespace, mapper removal, unavailable socket queue saturation, and shutdown disposal.
  - Sends 1,001 telemetry-producing SDK events through blocked adapter, asserts queue `1000`, one new gap, and all 1,001 UI projections.
  - Uses deterministic connector counter plus reconnect-timer state to prove disposed conversation events schedule no record or reconnect.

## Verification

| Command | Result |
| --- | --- |
| `node tests/pi-telemetry-test.mjs` | Exit 0. All zero-token integration cases passed, including systemd baseline, health accounting, queue saturation, and disposal/reconnect isolation. |
| `npm run check:protocol` | Exit 0. Protocol v10 sync checks passed. |
| `npm run typecheck` | Exit 0. Server, web, and test TypeScript checks passed. |
| `npm test -- --run` | Exit 0. 29 files, 313 tests passed. |
| `npm run build` | Exit 0. Vite and server TypeScript build passed. |
| `npm run test:smoke` | Exit 1. Final rerun: 32/33. Only existing `settings-test` assertion `skill re-enabled` failed; `pi-telemetry-test` passed. |
| `node tests/vscode-editor-plugin-test.mjs` | Exit 0 after first smoke run hit transient temp cleanup `ENOTEMPTY`; final full smoke rerun also passed this test. |
| `git diff --check` | Exit 0 before implementation commit. |

Independent read-only review found no remaining Critical or Important issues after health accounting, systemd baseline restoration, queue saturation, and disposal/reconnect assertions.

## Scope audit

No lifecycle/navigation generations, pending-create tracking/timeouts, edit serialization, provisional transactions, or runtime rebind callbacks were added. No existing edit/new-chat/cwd/session ownership flow changed. No frontend protocol or UI file changed. No Task 4 fixture was added.

## Limits

- Synthetic SDK events only. No real model/provider call or token use.
- Fake LF Unix socket only. No live UnifiedAgent ingest daemon acceptance or journal/readback proof.
- Full repository smoke remains 32/33 due existing settings assertion. QA remains open at repository level.
- Pre-existing async runtime/navigation races remain unchanged by explicit architecture-reset scope.

## Changed files versus `af86aac`

- `server/agent-service.ts`
- `server/index.ts`
- `server/telemetry/pi-event-mapper.ts`
- `server/telemetry/client.ts`
- `tests/pi-telemetry-test.mjs`
- `tests/run-smoke.mjs`
- `tests/unit/pi-event-mapper.test.ts`
- `tests/unit/telemetry-client.test.ts`
