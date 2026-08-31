# Final review fixes 2-4

Date: 2026-08-31

Evidence level: `Contract-tested | Integration-tested | Synthetic-only`

## Scope

This change closes review findings 2-4 only:

- forced reset terminal telemetry;
- one-second acknowledgement deadline;
- 16 MiB queue byte cap from `OPS-032`.

No UI, navigation, session ownership, runtime lifecycle, or provider behavior changed.
Production `context.changed` remains deferred pending explicit user approval for prompt/tool-derived hashes over the configured telemetry socket. Whole-adapter review stays open.

## Result

`PiEventMapper.forceReset()` emits terminal records in deterministic order: every open tool in insertion order, open turn, then open run. Tool and turn records use `cancelled`; run uses `aborted`. Every terminal has `cause_class=forced_reset`, a matched-start marker, stable correlation, and monotonic duration. No reset reason enters a record. A reset with no open spans emits one `agent.reset` observation. `ClientSession.forceResetConversation()` sends these records through the existing nonblocking telemetry path before mapper and runtime disposal.

`TelemetrySocketClient` starts one absolute one-second deadline for the oldest sent, unacknowledged record. Every sent record stores an injected monotonic timestamp; production defaults to `performance.now()`. Partial ACK bytes do not extend the deadline. A valid ACK clears the timer and rearms it from the next record's original send time. Expiry records one error, disconnects, requeues every sent record in FIFO order, then uses the existing capped reconnect backoff. Valid ACK, disconnect, and disposal clear the timer.

Queue admission still caps count at 1,000 records and now also caps serialized queued plus sent bytes at 16 MiB, including each LF delimiter. UTF-8 byte length uses `Buffer.byteLength`. Reconnect does not duplicate byte accounting. Accepted or explicitly rejected ACKs release bytes; protocol failures do not. Disposal releases all retained bytes. `health()` reports `queuedBytes`.

## TDD evidence

Initial focused RED:

```text
npx vitest run tests/unit/pi-event-mapper.test.ts tests/unit/telemetry-client.test.ts
Test Files  2 failed (2)
Tests  9 failed | 85 passed (94)
```

Failures matched missing behavior:

- `subject.forceReset is not a function` for open-span and empty-reset cases;
- 1,000 one-MiB records remained queued instead of 16;
- `queuedBytes` was absent;
- blackhole and trickle peers stayed `connected` after one second;
- next already-sent record received no absolute deadline;
- no ACK timer existed to clear.

Monotonic-clock RED after review:

```text
npx vitest run tests/unit/telemetry-client.test.ts -t "wall clock jumps"
Test Files  1 failed (1)
Tests  2 failed | 31 skipped (33)
```

A 24-hour forward wall-clock jump expired the next record early. A 24-hour backward jump delayed it. Both now expire at exactly 1,000 ms of injected monotonic time.

Final focused GREEN:

```text
npx vitest run tests/unit/pi-event-mapper.test.ts tests/unit/telemetry-client.test.ts
Test Files  2 passed (2)
Tests  96 passed (96)
```

## Integration evidence

`node tests/pi-telemetry-test.mjs` exited 0. Its forced-reset case opened two tools, one turn, and one run, then verified ordered content-free terminals before background runtime replacement. Correlation normalization found no remaining open span. Existing no-env, stall, failure isolation, multi-conversation, edit/fork, unavailable-socket, and shutdown cases also passed.

`node tests/pi-telemetry-scenarios-test.mjs` exited 0. Five diagnostic scenarios normalized successfully; the real socket queue accepted `21/21` records and ended at `queuedBytes=0`.

## Final gates

| Command | Result |
| --- | --- |
| `npx vitest run tests/unit/pi-event-mapper.test.ts tests/unit/telemetry-client.test.ts` | Exit 0; 96/96 |
| `node tests/pi-telemetry-test.mjs` | Exit 0 |
| `node tests/pi-telemetry-scenarios-test.mjs` | Exit 0; 21/21 accepted |
| `npm test -- --run` | Exit 0; 29 files, 324/324 |
| `npm run typecheck` | Exit 0 |
| `npm run check:protocol` | Exit 0; protocol v10 |
| `npm run build` | Exit 0 |
| `npm run test:smoke` | Exit 1; 32/33. Only known `settings-test` assertion `skill re-enabled` failed. |
| `git diff --check` | Exit 0 before commit |

Independent read-only validation returned `verified` for this limited findings 2-4 claim after the monotonic-clock regression passed. It found no remaining timer, byte-accounting, forced-reset ordering, or reset-privacy defect in this scope.

## Limits

- Tests use synthetic SDK events and local fake Unix sockets. No model/provider call or token use.
- No live UnifiedAgent daemon ingest/readback ran for this change.
- Finding 1 remains open: production does not yet supply effective prompt/tool context to `PiEventMapper`, so production emits no `context.changed` records.
- Repo smoke remains 32/33 due the existing settings assertion. This change does not claim repo-level QA closure.
