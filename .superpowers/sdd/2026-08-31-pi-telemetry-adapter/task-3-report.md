# Task 3 report: conversation telemetry integration

Date: 2026-08-31

Evidence level: `Contract-tested | Integration-tested | Synthetic-only`

Implementation commit: `200f745` (`feat: emit current Pi run telemetry`)

## Result

Pi web server now creates one optional process-level `TelemetrySocketClient` when `UA_TELEMETRY_SOCKET` contains a nonempty path. Each conversation/runtime owns a separate `PiEventMapper`. SDK events map before existing UI projection; mapped records enter shared bounded client in mapper order.

No telemetry env means no client, no mapper, no socket attempt. Telemetry errors, malformed ACKs, disconnects, queue overflow, mapper failures, enqueue failures, disposal failures, and shutdown cannot throw into Pi event projection. Adapter-side loss increments telemetry error/gap health.

## RED evidence

All RED runs used fixture SDK events, temp Pi agent dirs, temp project dirs, and fake LF Unix sockets. No provider prompt ran.

1. Initial `node tests/pi-telemetry-test.mjs` failed with `server telemetry integration/test lifecycle exports are missing`.
2. Shutdown regression failed with `server shutdown hung with an attached WebSocket`.
3. Runtime replacement failed with `replacement runtime reused prior mapper correlation state`.
4. Streaming latency guard failed with `streaming delta rebuilt telemetry context 1 time(s)`.
5. Health accounting failed with `mapping failure did not increment telemetry error/gap health`.
6. Shutdown concurrency failed with `server shutdown did not memoize cleanup and close admission`.
7. Pending runtime ownership failed with `shutdown did not await and dispose pending client creation`.

Each RED failed on missing Task 3 behavior. Corresponding minimal change then made focused fixture pass.

## Integration points

- `server/index.ts`
  - Trims `UA_TELEMETRY_SOCKET`; constructs no client for empty/missing value.
  - Creates stable source metadata once: local hostname, `UA_ROBOT_ID` override, process instance ID, component, version.
  - Owns shared client disposal after all client sessions stop.
  - Quiesces admission, closes HTTP/WS listeners, memoizes shutdown, waits pending session creation, then disposes conversations plus telemetry.
  - Systemd restart exit code 3 now occurs after cleanup.
- `server/agent-service.ts`
  - Injects telemetry config into each `ClientSession`.
  - Creates fresh mapper for each conversation/runtime using SDK session ID plus random correlation conversation ID.
  - Calls mapper inside existing `bindSession()` subscription before `onEvent()`.
  - Captures prompt/tool context only at `agent_start` and `turn_start`; streaming deltas do not rehash context.
  - Adds `project_cwd`, `project_name`, and UI conversation ID without copying SDK events, prompt text, tool args/results, or headers.
  - Disposes mapper on conversation removal, force reset, session disposal, and server shutdown.
- `server/telemetry/client.ts`
  - `recordFailure()` accounts for adapter-side error/gap loss that occurs before `emit()`.

## GREEN evidence

Final verification against `200f745` source plus generated build output:

| Command | Result |
| --- | --- |
| `node tests/pi-telemetry-test.mjs` | Exit 0. No-env, ordered run/turn/thinking/tool lifecycle, project switch, background ownership, disposal, force reset, streaming latency guard, mapper/enqueue failures, malformed ACK, unavailable socket, overflow, pending creation, and shutdown passed. |
| `npm run check:protocol` | Exit 0. Protocol v10 sync checks passed. |
| `npm run typecheck` | Exit 0. Server, web, and test TypeScript checks passed. |
| `npm test -- --run` | Exit 0. 29 files, 310 tests passed. |
| `npm run build` | Exit 0. Vite plus server TypeScript build passed. |
| `npm run test:smoke` | Exit 1. New `pi-telemetry-test` passed inside aggregator; overall result 32/33. Existing `settings-test` assertion `skill re-enabled` failed. |
| `git diff --check` | Exit 0 before implementation commit. |

Independent read-only review found no remaining Critical or Important Task 3 issues after health, shutdown, CI registration, streaming-context, and pending-creation fixes.

## Limits

- Synthetic SDK events only. No real model/provider call, token use, microphone, voice path, or live Pi agent turn.
- Fake LF Unix socket only. No live UnifiedAgent ingest daemon acceptance or end-to-end journal/readback proof.
- One full smoke assertion remains red. Task 3 is not evidence that whole repository smoke suite is green.
- No Task 4 diagnostic scenario fixtures. No frontend protocol or UI changes.

## Changed files in implementation commit

- `server/agent-service.ts`
- `server/index.ts`
- `server/telemetry/client.ts`
- `tests/pi-telemetry-test.mjs`
- `tests/run-smoke.mjs`

Report file: `.superpowers/sdd/2026-08-31-pi-telemetry-adapter/task-3-report.md`
