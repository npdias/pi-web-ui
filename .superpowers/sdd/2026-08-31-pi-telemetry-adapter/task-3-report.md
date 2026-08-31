# Task 3 report: conversation telemetry integration

Date: 2026-08-31

Evidence level: `Contract-tested | Integration-tested | Synthetic-only`

Implementation commits:

- `200f745` (`feat: emit current Pi run telemetry`)
- `1fffb51` (`fix: harden Pi telemetry session lifecycle`)
- `266d6bc` (`fix: make Pi telemetry session changes transactional`)

## Result

Pi web server now creates one optional process-level `TelemetrySocketClient` when `UA_TELEMETRY_SOCKET` contains a nonempty path. Each conversation keeps stable telemetry conversation metadata. Each concrete Pi session identity owns a fresh `PiEventMapper` carrying that Pi session ID. SDK events map before existing UI projection; mapped records enter shared bounded client in mapper order.

Trace, turn, step, request, and tool IDs use a nonsecret namespace containing stable conversation ID, Pi session ID, and bind generation. Reopening or replacing a concrete Pi session cannot reuse span identity.

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
8. Edit/fork rebinding failed when post-edit telemetry retained old Pi session ID.
9. SDK `newSession()` failed with `timeout waiting for new-session replacement telemetry` when runtime callback was absent.
10. Background force reset failed with `timeout waiting for background force-reset telemetry` because binding targeted active conversation.
11. Bounded shutdown failed with `server shutdown exceeded pending-create deadline` on never-resolving creation.
12. Late runtime table failed with `late runtime creation survived bounded shutdown` for `newChat`, `setCwd`, `switchSession`, and `forceReset`.
13. Concurrent navigation failed with `slower navigation runtime overwrote newer workspace`.
14. Edit/navigation race failed with `edit resumed against wrong active conversation: c1`.
15. Fork span identity failed with `fork session reused trace_id=...:run:1`.
16. Removal mid-fork failed when generic runtime callback rebound removed conversation before ownership check.
17. Concurrent force reset exposed stale edit replacing winner runtime/session/mapper.
18. Set-cwd bind race failed with `setCwd bind race did not converge to latest target` when newer invalid request left provisional state installed.
19. Switch-session bind race failed with `switchSession bind race did not converge to latest target`.
20. Provisional bind rejection failed with `rejected provisional bind leaked runtime, terminals, or subscription`.
21. Force-reset extension bind rejection failed with `timeout waiting for force-reset core binding after extension failure`.

Each RED failed on missing Task 3 behavior. Corresponding minimal change then made focused fixture pass.

## Integration points

- `server/index.ts`
  - Trims `UA_TELEMETRY_SOCKET`; constructs no client for empty/missing value.
  - Creates stable source metadata once: local hostname, `UA_ROBOT_ID` override, process instance ID, component, version.
  - Owns shared client disposal after all client sessions stop.
  - Quiesces admission, closes HTTP/WS listeners, memoizes shutdown, disposes existing sessions, and waits at most 250 ms for pending client creation before telemetry disposal.
  - Systemd restart exit code 3 now occurs after cleanup.
- `server/agent-service.ts`
  - Injects telemetry config into each `ClientSession`.
  - Centralizes binding around explicit conversation/runtime/session identity.
  - Preserves telemetry conversation ID while rebuilding mapper with each replacement Pi session ID.
  - Adds Pi session and bind generation to mapper span/tool namespace.
  - Uses SDK runtime rebind callback for fork/new/switch, unsubscribes old session, and subscribes replacement exactly once.
  - Calls mapper inside bound subscription before `onEvent()`.
  - Captures prompt/tool context only at `agent_start` and `turn_start`; streaming deltas do not rehash context.
  - Adds `project_cwd`, `project_name`, and UI conversation ID without copying SDK events, prompt text, tool args/results, or headers.
  - Disposes mapper on conversation removal, force reset, session disposal, and server shutdown.
  - Uses service, client, binding, and navigation generations to reject stale async installs.
  - Binds background force-reset target without changing active conversation.
  - Disposes runtimes that resolve after shutdown or after a newer navigation request.
  - Uses conversation operation ownership before edit binds; removal or force reset invalidates stale edit.
  - Binds provisional new-chat/cwd/session runtimes before committing conversation map, active ID, displaced removal, or public cwd.
  - Cleans provisional mapper, callback, runtime, and terminals when binding fails or request becomes stale.
  - Keeps core mapper/subscription after force-reset extension binding failure.
- `server/telemetry/client.ts`
  - `recordFailure()` accounts for adapter-side error/gap loss that occurs before `emit()`.

## GREEN evidence

Final verification against `266d6bc` source plus generated build output:

| Command | Result |
| --- | --- |
| `node tests/pi-telemetry-test.mjs` | Exit 0. Existing cases plus concrete-session ID uniqueness, removal/force-reset edit ownership, setCwd/switchSession/newChat bind gates, provisional rejection cleanup, and force-reset core fallback passed. |
| `npm run check:protocol` | Exit 0. Protocol v10 sync checks passed. |
| `npm run typecheck` | Exit 0. Server, web, and test TypeScript checks passed. |
| `npm test -- --run` | Exit 0. 29 files, 310 tests passed. |
| `npm run build` | Exit 0. Vite plus server TypeScript build passed. |
| `npm run test:smoke` | Exit 1. New `pi-telemetry-test` passed inside aggregator; overall result 32/33. Existing `settings-test` assertion `skill re-enabled` failed. |
| `git diff --check` | Exit 0 before `200f745`, `1fffb51`, and `266d6bc`. |

Independent read-only round-2 review found no remaining Critical or Important Task 3 issues after unique ID namespace, edit ownership, provisional commit, bind cleanup, and force-reset core fallback fixes.

## Limits

- Synthetic SDK events only. No real model/provider call, token use, microphone, voice path, or live Pi agent turn.
- Fake LF Unix socket only. No live UnifiedAgent ingest daemon acceptance or end-to-end journal/readback proof.
- One full smoke assertion remains red. Task 3 is not evidence that whole repository smoke suite is green.
- No Task 4 diagnostic scenario fixtures. No frontend protocol or UI changes.

## Changed files

- `server/agent-service.ts`
- `server/index.ts`
- `server/telemetry/client.ts`
- `tests/pi-telemetry-test.mjs`
- `tests/run-smoke.mjs`

P1 lifecycle fix changed:

- `server/agent-service.ts`
- `tests/pi-telemetry-test.mjs`

Round-2 lifecycle fix changed:

- `server/agent-service.ts`
- `server/telemetry/pi-event-mapper.ts`
- `tests/pi-telemetry-test.mjs`

Report file: `.superpowers/sdd/2026-08-31-pi-telemetry-adapter/task-3-report.md`
