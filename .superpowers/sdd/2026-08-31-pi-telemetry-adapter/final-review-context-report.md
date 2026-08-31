# Final review context hash wiring

Date: 2026-08-31

Evidence level: `Contract-tested | Integration-tested | Synthetic-only`

## Authorization and scope

Nicholas approved local context hashes in `OPS-034`. This change closes whole-adapter finding 1 only. It does not add UI, navigation, lifecycle, provider, or off-device behavior.

Raw system prompts, tool-catalog names, and tool schemas used for context hashing exist only in the synchronous call from `ClientSession` to `PiEventMapper`. The mapper emits fixed-length SHA-256 hashes and a changed state. Those raw context values do not enter a `context.changed` record, the socket queue, error text, or this report. Existing `tool.execution` records still carry the name of the tool that executed; this change does not alter that approved mapping.

## Result

On validated `agent_start` and `turn_start` events, `ClientSession` reads the current `AgentSession.systemPrompt` plus active `AgentSession.state.tools`. It narrows every tool to `{ name, schema: parameters }`, sorts by name, and supplies this in-process context to `PiEventMapper`.

`PiEventMapper` retains ownership of validation, canonicalization, hashing, suppression, and correlation. Initial context appears before its run start. A prompt, tool-name, or schema change appears before its turn start with current trace, turn, step, and request IDs. Reordering identical tools emits no change. Mapper and concrete-session replacement re-emit current hashes under fresh run correlation.

If runtime context access throws, the adapter records one mapping health error, supplies no context, and still maps the lifecycle event. No exception text enters telemetry. Missing `UA_TELEMETRY_SOCKET` still creates neither socket client nor mapper.

## TDD evidence

RED command:

```text
node tests/pi-telemetry-test.mjs
```

Observed failure before production wiring:

```text
FAIL Error: timeout waiting for effective context telemetry
```

GREEN command:

```text
node tests/pi-telemetry-test.mjs
```

Observed exit 0 with these added cases:

- effective prompt plus sorted active tools emit hashes only when context changes;
- context capture failure preserves content-free lifecycle telemetry;
- mapper replacement re-emits unchanged hashes under fresh run correlation;
- edit/fork concrete-session replacement re-emits unchanged hashes under fresh session/run correlation;
- raw synthetic prompt, name, schema, and exception markers are absent from exact serialized socket lines.

## Scoped verification

| Command | Result |
| --- | --- |
| `node tests/pi-telemetry-test.mjs` | Exit 0 |
| `npx vitest run tests/unit/pi-event-mapper.test.ts tests/unit/telemetry-client.test.ts` | Exit 0; 96/96 |
| `node tests/pi-telemetry-scenarios-test.mjs` | Exit 0; 21/21 accepted |
| `npx tsc -p tsconfig.server.json --noEmit` | Exit 0 |
| `git diff --check -- server/agent-service.ts tests/pi-telemetry-test.mjs` | Exit 0 |

Implementation commit: `e3bd10c` (`fix: emit Pi context hash changes`).

## Clean combined-branch gates

After concurrent Observe Task 2 committed and the worktree became clean, final checks ran against combined HEAD `f701720`:

| Command | Result |
| --- | --- |
| `npx vitest run tests/unit/pi-event-mapper.test.ts tests/unit/telemetry-client.test.ts` | Exit 0; 96/96 |
| `node tests/pi-telemetry-test.mjs` | Exit 0 |
| `node tests/pi-telemetry-scenarios-test.mjs` | Exit 0; 21/21 accepted |
| `npm run typecheck` | Exit 0 |
| `npm run check:protocol` | Exit 0; protocol v10 |
| `npm test -- --run` | Exit 0; 31 files, 340/340 |
| `npm run build` | Exit 0 |
| `npm run test:smoke` | Exit 1; 32/33. Only known `settings-test` assertion `skill re-enabled` failed. |

The earlier full typecheck attempt failed only while Observe Task 2 held uncommitted RED tests. No Pi context file caused those errors.

## Limits

- Synthetic SDK events and an isolated local Unix socket only. No model/provider call or token use.
- No live UnifiedAgent daemon ingest/readback in this change.
- Hash equality reveals whether context stayed equal; it does not reveal raw context.
- Whole-adapter review remains open until an independent reviewer checks all four findings against the committed branch.
