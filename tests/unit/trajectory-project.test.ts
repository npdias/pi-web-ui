/**
 * Test structure adapted from DeepSeek Harness trajectory layout tests.
 * Donor: packages/client/ui-trajectory/tests/layout.client.spec.tsx
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	flattenTrajectoryRecords,
	hydrateTrajectoryRecordDetail,
	projectTrajectory,
} from "../../web/src/observe/trajectory/project.js";
import {
	formatDurationMillis,
	trajectoryRecordId,
} from "../../web/src/observe/trajectory/record.js";
import type { TelemetryTrajectoryRecord } from "../../web/src/observe/trajectory/record.js";
import type { TrajectoryProjectionInput } from "../../web/src/observe/trajectory/record.js";
import type {
	TelemetryEvent,
	TelemetryReplayGap,
} from "../../web/src/observe/telemetry-types.js";
import {
	parseTelemetryEvent,
	parseTelemetryEventDetail,
} from "../../web/src/observe/telemetry-types.js";

const FIXTURE_NAMES = [
	"normal",
	"long-tool",
	"tool-error",
	"cancelled",
	"model-stall",
] as const;

interface FixtureExpectation {
	readonly kind: string;
	readonly phase?: string;
	readonly severity: TelemetryEvent["severity"];
	readonly state?: string;
	readonly parent_id?: string;
	readonly trace_id?: string;
	readonly turn_id?: string;
	readonly step_id?: string;
	readonly request_id?: string;
	readonly tool_call_id?: string;
	readonly duration_ms?: number;
	readonly attributes?: TelemetryEvent["attributes"];
}

interface FixtureLine {
	readonly fixture: string;
	readonly at_ms: number;
	readonly expect: readonly FixtureExpectation[];
}

function fixtureEvents(name: (typeof FIXTURE_NAMES)[number]): readonly TelemetryEvent[] {
	const path = new URL(`../fixtures/telemetry/${name}.jsonl`, import.meta.url);
	const lines = readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as FixtureLine);
	let sequence = 0;
	return lines.flatMap((line) =>
		line.expect.map((expected) => {
			sequence += 1;
			const correlation = Object.fromEntries(
				[
					"parent_id",
					"trace_id",
					"turn_id",
					"step_id",
					"request_id",
					"tool_call_id",
				]
					.map((key) => [key, expected[key as keyof FixtureExpectation]])
					.filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			);
			return parseTelemetryEvent({
				schema_version: 1,
				event_id: `${name}:event:${sequence}`,
				sequence,
				observed_at: new Date(Date.UTC(2026, 7, 31) + line.at_ms).toISOString(),
				monotonic_ns: line.at_ms * 1_000_000,
				kind: expected.kind,
				severity: expected.severity,
				source: {
					robot_id: "fixture-robot",
					host_id: "fixture-host",
					component: "pi",
					instance_id: `fixture-${name}`,
				},
				attributes: expected.attributes ?? {},
				...(expected.phase === undefined ? {} : { phase: expected.phase }),
				...(expected.state === undefined ? {} : { state: expected.state }),
				...(Object.keys(correlation).length === 0 ? {} : { correlation }),
				...(expected.duration_ms === undefined
					? {}
					: { duration_ms: expected.duration_ms }),
				privacy_class: "operator",
			});
		}),
	);
}

function envelope(
	sequence: number,
	kind: string,
	overrides: Partial<TelemetryEvent> = {},
): TelemetryEvent {
	const correlation = overrides.correlation;
	const attributes = { ...(overrides.attributes ?? {}) };
	if (
		kind === "tool.execution" &&
		correlation?.tool_call_id !== undefined &&
		attributes.lifecycle_attempt_id === undefined
	) {
		attributes.lifecycle_attempt_id = `synthetic-attempt:${correlation.tool_call_id}`;
	}
	return parseTelemetryEvent({
		schema_version: 1,
		event_id: `synthetic:event:${sequence}`,
		sequence,
		observed_at: new Date(Date.UTC(2026, 7, 31, 12) + sequence * 100).toISOString(),
		monotonic_ns: sequence * 100_000_000,
		kind,
		severity: "info",
		source: {
			robot_id: "robot-01",
			host_id: "host-01",
			component: "pi",
			instance_id: "pi-session-01",
		},
		privacy_class: "operator",
		...overrides,
		attributes,
	});
}

function records(events: readonly TrajectoryProjectionInput[]) {
	return flattenTrajectoryRecords(projectTrajectory(events));
}

describe("projectTrajectory", () => {
	it("reprojects a paired row from exact selected start and end envelopes", () => {
		const scope = {
			trace_id: "exact-run",
			turn_id: "exact-turn",
			step_id: "exact-step",
			request_id: "exact-request",
			tool_call_id: "exact-call",
		};
		const fullArguments = `args-${"x".repeat(70 * 1024)}-arguments-tail`;
		const fullResult = `result-${"y".repeat(70 * 1024)}-result-tail`;
		const rawStart = {
			...envelope(1, "tool.execution", {
				phase: "start",
				state: "running",
				correlation: scope,
				attributes: {
					lifecycle_attempt_id: "exact-attempt",
					tool_name: "bash",
					input: { command: fullArguments, authorization: "private-secret" },
				},
			}),
			attributes: {
				lifecycle_attempt_id: "exact-attempt",
				tool_name: "bash",
				input: { command: fullArguments, authorization: "private-secret" },
			},
		};
		const rawEnd = {
			...envelope(2, "tool.execution", {
				phase: "end",
				state: "completed",
				correlation: scope,
				attributes: {
					lifecycle_attempt_id: "exact-attempt",
					tool_name: "bash",
					matched_start: true,
					output: { content: fullResult, token: "private-token" },
				},
			}),
			attributes: {
				lifecycle_attempt_id: "exact-attempt",
				tool_name: "bash",
				matched_start: true,
				output: { content: fullResult, token: "private-token" },
			},
		};
		const boundedEvents = [parseTelemetryEvent(rawStart), parseTelemetryEvent(rawEnd)];
		const exactEvents = [
			parseTelemetryEventDetail(rawStart),
			parseTelemetryEventDetail(rawEnd),
		];
		const [boundedRecord] = records(boundedEvents) as readonly TelemetryTrajectoryRecord[];

		const hydrated = hydrateTrajectoryRecordDetail(boundedRecord, exactEvents);

		expect(hydrated.id).toBe(boundedRecord.id);
		expect(hydrated.index).toBe(boundedRecord.index);
		expect(hydrated.sourceEventIds).toEqual(boundedRecord.sourceEventIds);
		expect(hydrated.inputDetail).toContain("arguments-tail");
		expect(hydrated.result).toContain("result-tail");
		expect(hydrated.inputDetail).toContain('"authorization": "[REDACTED]"');
		expect(hydrated.result).toContain('"token": "[REDACTED]"');
		expect(hydrated.sourceEnvelopes[0].attributes.input).toMatchObject({
			command: fullArguments,
			authorization: "[REDACTED]",
		});
	});

	it("keeps bounded envelope fallback when only part of a paired row hydrates", () => {
		const scope = { tool_call_id: "partial-call" };
		const start = envelope(1, "tool.execution", {
			phase: "start",
			state: "running",
			correlation: scope,
			attributes: {
				lifecycle_attempt_id: "partial-attempt",
				tool_name: "read",
				input: "bounded-start",
			},
		});
		const end = envelope(2, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation: scope,
			attributes: {
				lifecycle_attempt_id: "partial-attempt",
				tool_name: "read",
				matched_start: true,
				output: "bounded-end-fallback",
			},
		});
		const [boundedRecord] = records([start, end]) as readonly TelemetryTrajectoryRecord[];
		const exactStart = parseTelemetryEventDetail({
			...start,
			attributes: { ...start.attributes, input: "exact-start-detail" },
		});

		const hydrated = hydrateTrajectoryRecordDetail(boundedRecord, [exactStart]);

		expect(hydrated.inputDetail).toBe("exact-start-detail");
		expect(hydrated.result).toBe("bounded-end-fallback");
		expect(hydrated.sourceEnvelopes[1]).toEqual(end);
	});

	it("projects redacted user, model, tool, and result details plus model token evidence", () => {
		const scope = {
			trace_id: "content-run",
			turn_id: "content-turn",
			step_id: "content-step",
			request_id: "content-request",
		};
		const projected = records([
			envelope(1, "user.message", {
				phase: "observation",
				state: "emitted",
				correlation: scope,
				attributes: { input_detail: "Inspect fixture", image_count: 1 },
			}),
			envelope(2, "model.response", {
				phase: "start",
				state: "running",
				correlation: scope,
				attributes: {
					lifecycle_attempt_id: "model-attempt-1",
					api: "openai-responses",
					provider: "openai",
					model: "fixture-model",
				},
			}),
			envelope(3, "model.response", {
				phase: "end",
				state: "completed",
				duration_ms: 25,
				correlation: scope,
				attributes: {
					lifecycle_attempt_id: "model-attempt-1",
					matched_start: true,
					output_detail: "Fixture final response",
					input_tokens: 11,
					output_tokens: 7,
					cache_read_tokens: 3,
					cache_write_tokens: 2,
					total_tokens: 23,
				},
			}),
			envelope(4, "tool.execution", {
				phase: "start",
				state: "running",
				correlation: { ...scope, tool_call_id: "content-call" },
				attributes: {
					lifecycle_attempt_id: "tool-attempt-1",
					tool_name: "read",
					input: { path: "README.md", authorization: "[REDACTED]" },
				},
			}),
			envelope(5, "tool.execution", {
				phase: "end",
				state: "completed",
				duration_ms: 5,
				correlation: { ...scope, tool_call_id: "content-call" },
				attributes: {
					lifecycle_attempt_id: "tool-attempt-1",
					tool_name: "read",
					matched_start: true,
					output: { details: { password: "[REDACTED]", lines: 4 } },
				},
			}),
			envelope(6, "tool.result", {
				phase: "observation",
				state: "completed",
				correlation: { ...scope, tool_call_id: "content-call" },
				attributes: {
					tool_name: "read",
					is_error: false,
					output: { content: [{ type: "text", text: "Fixture tool result" }] },
				},
			}),
		]);

		expect(projected.map((record) => record.kind)).toEqual([
			"USER",
			"ASSISTANT",
			"TOOL",
			"RESULT",
		]);
		expect(projected[0]).toMatchObject({ inputDetail: "Inspect fixture" });
		expect(projected[1]).toMatchObject({
			outputDetail: "Fixture final response",
			durationMs: 25,
			attributes: {
				input_tokens: 11,
				output_tokens: 7,
				cache_read_tokens: 3,
				cache_write_tokens: 2,
				total_tokens: 23,
			},
		});
		expect(projected[2].inputDetail).toContain('"authorization": "[REDACTED]"');
		expect(projected[2].result).toContain('"password": "[REDACTED]"');
		expect(projected[3]).toMatchObject({ kind: "RESULT", toolName: "read" });
		expect(projected[3].result).toContain("Fixture tool result");
	});

	it("projects a bounded thinking truncation marker into labeled thinking detail", () => {
		const [record] = records([
			envelope(1, "provider.thinking", {
				phase: "end",
				state: "emitted",
				attributes: {
					content: {
						truncated: true,
						sha256: "sha256:thinking-marker",
						original_bytes: 900_000,
					},
					content_index: 0,
				},
			}),
		]);

		expect(record).toMatchObject({ kind: "ASSISTANT" });
		expect(record.thinkingDetail).toContain('"truncated": true');
		expect(record.thinkingDetail).toContain("sha256:thinking-marker");
	});

	it("groups the normal fixture by explicit Turn and Step IDs and pairs its tool", () => {
		const turns = projectTrajectory(fixtureEvents("normal"));
		const turn = turns.find((candidate) => candidate.turnId === "normal:turn:1");
		const all = flattenTrajectoryRecords(turns);
		const tool = all.find((record) => record.toolCallId === "normal:tool:tool-1");
		const request = all.find(
			(record) =>
				record.eventKind === "agent.turn" &&
				record.turnId === "normal:turn:1",
		);
		const contentRecords = all.filter((record) =>
			["user.message", "model.response", "tool.result"].includes(record.eventKind ?? ""),
		);

		expect(turn?.steps).toHaveLength(1);
		expect(turn?.steps[0]).toMatchObject({
			stepId: "normal:step:1",
			requestId: "normal:request:1",
		});
		expect(tool).toMatchObject({
			kind: "TOOL",
			state: "completed",
			durationMs: 30,
			isOpen: false,
			sourceEventIds: ["normal:event:6", "normal:event:7"],
			parentRecordId: request?.id,
			inputDetail: expect.stringContaining("README.md"),
			result: expect.stringContaining("Fixture tool output"),
		});
		expect(contentRecords.map((record) => record.kind)).toEqual([
			"USER",
			"ASSISTANT",
			"RESULT",
			"ASSISTANT",
		]);
		expect(contentRecords[0].inputDetail).toBe("Inspect fixture status");
		expect(contentRecords[1].outputDetail).toBe("Checking fixture.");
		expect(contentRecords[2].result).toContain("Fixture tool output");
		expect(contentRecords[3]).toMatchObject({
			outputDetail: "Fixture final response",
			attributes: { input_tokens: 11, output_tokens: 7, total_tokens: 23 },
		});
	});

	it("keeps a fixture tool open without inventing a duration", () => {
		const prefix = fixtureEvents("long-tool").filter((event) => event.phase !== "end");
		const tool = records(prefix).find((record) => record.eventKind === "tool.execution");

		expect(tool).toMatchObject({ kind: "TOOL", isOpen: true, durationMs: null });
		expect(formatDurationMillis(tool?.durationMs ?? null)).toBe("—");
	});

	it("uses recorded long-tool duration and never derives one from wall timestamps", () => {
		const fixtureTool = records(fixtureEvents("long-tool")).find(
			(record) => record.eventKind === "tool.execution",
		);
		const unmatched = records([
			envelope(1, "tool.execution", {
				phase: "end",
				state: "completed",
				correlation: { tool_call_id: "unmatched" },
				duration_ms: -5,
				attributes: { tool_name: "bash", matched_start: false },
			}),
		])[0];

		expect(fixtureTool?.durationMs).toBe(240_000);
		expect(unmatched).toMatchObject({ isOpen: false, durationMs: null });
		expect(formatDurationMillis(-5)).toBe("—");
	});

	it("projects tool failure and operator cancellation as terminal records", () => {
		const failedTool = records(fixtureEvents("tool-error")).find(
			(record) => record.eventKind === "tool.execution",
		);
		const cancelled = records(fixtureEvents("cancelled")).filter(
			(record) => record.kind === "CANCELLED",
		);

		expect(failedTool).toMatchObject({
			kind: "ERROR",
			state: "error",
			isError: true,
			durationMs: 100,
			isOpen: false,
		});
		expect(cancelled.map((record) => record.eventKind)).toEqual([
			"agent.run",
			"agent.turn",
		]);
		expect(cancelled.every((record) => record.isOpen === false)).toBe(true);
	});

	it("keeps stall observational while its run and turn remain open", () => {
		const all = records(fixtureEvents("model-stall"));
		const stall = all.find((record) => record.kind === "STALL");
		const starts = all.filter((record) => record.phase === "start");

		expect(stall).toMatchObject({
			state: "possibly_stalled",
			durationMs: 180_000,
			isOpen: false,
		});
		expect(starts).toHaveLength(2);
		expect(starts.every((record) => record.isOpen)).toBe(true);
	});

	it("sorts and deduplicates replay, preserves context/thinking/reset, and uses IDs not adjacency", () => {
		const turnA = {
			trace_id: "trace-1",
			turn_id: "turn-a",
			step_id: "step-a",
			request_id: "request-a",
		};
		const turnB = {
			trace_id: "trace-1",
			turn_id: "turn-b",
			step_id: "step-b",
			request_id: "request-b",
		};
		const toolEnd = envelope(8, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation: { ...turnB, parent_id: "request-b", tool_call_id: "call-a" },
			duration_ms: 20,
			attributes: { tool_name: "read", matched_start: true },
		});
		const replay = [
			toolEnd,
			envelope(2, "agent.turn", {
				phase: "start",
				state: "running",
				correlation: { ...turnA, parent_id: "trace-1" },
			}),
			envelope(1, "agent.run", {
				phase: "start",
				state: "running",
				correlation: { trace_id: "trace-1", parent_id: "session-1" },
			}),
			envelope(3, "agent.turn", {
				phase: "start",
				state: "running",
				correlation: { ...turnB, parent_id: "trace-1" },
			}),
			envelope(4, "context.changed", {
				phase: "snapshot",
				state: "changed",
				correlation: { ...turnA, parent_id: "request-a" },
				attributes: {
					system_prompt_hash: "sha256:opaque-system",
					tool_schema_hash: "sha256:opaque-tools",
				},
			}),
			envelope(5, "provider.thinking", {
				phase: "end",
				state: "emitted",
				correlation: { ...turnA, parent_id: "request-a" },
				attributes: { content: "provider-visible thought", content_index: 0 },
			}),
			envelope(6, "tool.execution", {
				phase: "start",
				state: "running",
				correlation: { ...turnA, parent_id: "request-a", tool_call_id: "call-a" },
				attributes: { tool_name: "read" },
			}),
			envelope(9, "agent.reset", {
				phase: "observation",
				state: "forced_reset",
				severity: "warning",
				correlation: { trace_id: "trace-1", parent_id: "session-1" },
				attributes: { cause_class: "forced_reset" },
			}),
			toolEnd,
		];
		const all = records(replay);
		const requestA = all.find(
			(record) => record.eventKind === "agent.turn" && record.turnId === "turn-a",
		);
		const tool = all.find((record) => record.toolCallId === "call-a");

		expect(all.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6, 9]);
		expect(all.filter((record) => record.sourceEventIds.includes(toolEnd.event_id))).toHaveLength(1);
		expect(all.find((record) => record.eventKind === "context.changed")?.kind).toBe("CONTEXT");
		expect(all.find((record) => record.eventKind === "provider.thinking")).toMatchObject({
			kind: "ASSISTANT",
			thinkingDetail: "provider-visible thought",
		});
		expect(all.find((record) => record.eventKind === "agent.reset")).toMatchObject({
			kind: "CANCELLED",
			durationMs: null,
		});
		expect(tool).toMatchObject({
			turnId: "turn-a",
			stepId: "step-a",
			requestId: "request-a",
			parentRecordId: requestA?.id,
			durationMs: 20,
		});
	});

	it("preserves explicit replay gaps and stable event identities across prepends", () => {
		const gap: TelemetryReplayGap = {
			requested: 2,
			earliest_available: 7,
			resume_after: 6,
		};
		const existing = envelope(7, "agent.run", {
			phase: "start",
			state: "running",
			correlation: { trace_id: "trace-7" },
		});
		const before = records([existing])[0];
		const after = flattenTrajectoryRecords(
			projectTrajectory([
				{ type: "gap", gap },
				{ type: "event", event: existing },
			]),
		);
		const same = after.find((record) => record.eventKind === "agent.run");
		const gapRecord = after.find((record) => record.kind === "GAP");

		expect(trajectoryRecordId(same!)).toBe(trajectoryRecordId(before));
		expect(gapRecord).toMatchObject({
			id: "gap:2:7:6",
			kind: "GAP",
			gap,
			durationMs: null,
			isOpen: false,
		});
	});

	it("keeps retry starts open and surfaces duplicate tool terminal conflict", () => {
		const run = { trace_id: "retry-run", session_id: "session-retry" };
		const tool = {
			...run,
			turn_id: "retry-turn",
			step_id: "retry-step",
			request_id: "retry-request",
			tool_call_id: "retry-call",
		};
		const all = records([
			envelope(1, "agent.run", {
				phase: "start",
				state: "running",
				correlation: run,
			}),
			envelope(2, "agent.run", {
				phase: "end",
				state: "retrying",
				severity: "warning",
				correlation: run,
			}),
			envelope(3, "agent.run", {
				phase: "start",
				state: "running",
				correlation: run,
				attributes: { duplicate_start: true },
			}),
			envelope(4, "tool.execution", {
				phase: "start",
				state: "running",
				correlation: tool,
				attributes: { tool_name: "read" },
			}),
			envelope(5, "tool.execution", {
				phase: "start",
				state: "running",
				correlation: tool,
				attributes: { tool_name: "read", duplicate_start: true },
			}),
			envelope(6, "tool.execution", {
				phase: "end",
				state: "completed",
				correlation: tool,
				duration_ms: 2,
				attributes: { tool_name: "read", matched_start: true },
			}),
			envelope(7, "tool.execution", {
				phase: "end",
				state: "completed",
				correlation: tool,
				attributes: {
					tool_name: "read",
					matched_start: false,
					lifecycle_attempt_id: "retry-call-unmatched-attempt",
				},
			}),
		]);
		const runs = all.filter(
			(record) => record.eventKind === "agent.run",
		);
		const tools = all.filter((record) => record.eventKind === "tool.execution");

		expect(runs.map((record) => [record.attemptOrdinal, record.state, record.isOpen])).toEqual([
			[1, "retrying", false],
			[2, "running", true],
		]);
		expect(tools).toHaveLength(2);
		expect(tools[0]).toMatchObject({
			isOpen: false,
			durationMs: 2,
			state: "completed",
			terminalConflict: false,
			sourceEventIds: [
				"synthetic:event:4",
				"synthetic:event:5",
				"synthetic:event:6",
			],
		});
		expect(tools[1]).toMatchObject({
			attemptOrdinal: 2,
			state: "unmatched_terminal",
			terminalConflict: false,
			unmatchedTerminal: true,
			sourceEventIds: ["synthetic:event:7"],
		});
	});

	it("treats a terminal after a retry start as a new attempt, not conflicting evidence", () => {
		const correlation = { trace_id: "retry-complete-run", session_id: "retry-session" };
		const all = records([
			envelope(1, "agent.run", {
				phase: "start",
				state: "running",
				correlation,
				attributes: { lifecycle_attempt_id: "retry-attempt-1" },
			}),
			envelope(2, "agent.run", {
				phase: "end",
				state: "retrying",
				severity: "warning",
				correlation,
				attributes: {
					lifecycle_attempt_id: "retry-attempt-1",
					matched_start: true,
				},
			}),
			envelope(3, "agent.run", {
				phase: "start",
				state: "running",
				correlation,
				attributes: { lifecycle_attempt_id: "retry-attempt-2" },
			}),
			envelope(4, "agent.run", {
				phase: "end",
				state: "completed",
				correlation,
				duration_ms: 1,
				attributes: {
					lifecycle_attempt_id: "retry-attempt-2",
					matched_start: true,
				},
			}),
		]);
		const terminals = all.filter(
			(record) => record.eventKind === "agent.run" && record.phase === "end",
		);

		expect(terminals).toHaveLength(2);
		expect(terminals.map((record) => record.state)).toEqual(["retrying", "completed"]);
		expect(
			terminals.every(
				(record) => (record as { terminalConflict?: boolean }).terminalConflict === false,
			),
		).toBe(true);
	});

	it("surfaces completed-then-error tool terminals in one stable conflict record", () => {
		const correlation = {
			trace_id: "conflict-run",
			turn_id: "conflict-turn",
			step_id: "conflict-step",
			request_id: "conflict-request",
			tool_call_id: "conflict-tool",
		};
		const start = envelope(1, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: { tool_name: "read" },
		});
		const completed = envelope(2, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation,
			duration_ms: 10,
			attributes: { tool_name: "read", matched_start: true },
		});
		const failed = envelope(3, "tool.execution", {
			phase: "end",
			state: "error",
			severity: "error",
			correlation,
			duration_ms: 11,
			attributes: {
				tool_name: "read",
				is_error: true,
				matched_start: false,
				lifecycle_attempt_id: "conflict-tool-unmatched-attempt",
			},
		});
		const settledId = records([start, completed])[0]?.id;
		const conflicted = records([start, completed, failed, failed]).filter(
			(record) => record.eventKind === "tool.execution",
		);

		expect(conflicted).toHaveLength(2);
		expect(conflicted[0]).toMatchObject({
			id: settledId,
			attemptOrdinal: 1,
			kind: "TOOL",
			state: "completed",
			sourceEventIds: ["synthetic:event:1", "synthetic:event:2"],
		});
		expect(conflicted[1]).toMatchObject({
			attemptOrdinal: 2,
			kind: "ERROR",
			severity: "error",
			state: "unmatched_terminal",
			isError: true,
			isOpen: false,
			durationMs: 11,
			terminalConflict: false,
			unmatchedTerminal: true,
			sourceEventIds: ["synthetic:event:3"],
		});
	});

	it.each([
		{
			name: "run",
			kind: "agent.run",
			correlation: { trace_id: "terminal-conflict-run" },
		},
		{
			name: "turn",
			kind: "agent.turn",
			correlation: {
				trace_id: "terminal-conflict-run",
				turn_id: "terminal-conflict-turn",
				step_id: "terminal-conflict-step",
				request_id: "terminal-conflict-request",
			},
		},
	])("keeps first $name terminal plus explicit highest-severity conflict evidence", ({
		kind,
		correlation,
	}) => {
		const start = envelope(1, kind, {
			phase: "start",
			state: "running",
			correlation,
		});
		const completed = envelope(2, kind, {
			phase: "end",
			state: "completed",
			correlation,
			duration_ms: 10,
			attributes: { matched_start: true },
		});
		const failed = envelope(3, kind, {
			phase: "end",
			state: "error",
			severity: "error",
			correlation,
			duration_ms: 11,
			attributes: { is_error: true, matched_start: false },
		});
		const all = records([start, completed, failed, failed]);
		const conflict = all.find(
			(record) =>
				record.eventKind === kind &&
				(record as { terminalConflict?: boolean }).terminalConflict === true,
		);

		expect(all.filter((record) => record.eventKind === kind)).toHaveLength(2);
		expect(conflict).toMatchObject({
			attemptOrdinal: 2,
			sequence: 3,
			kind: "ERROR",
			severity: "error",
			state: "conflict",
			isError: true,
			isOpen: false,
			durationMs: 11,
			terminalConflict: true,
			unmatchedTerminal: true,
			sourceEventIds: ["synthetic:event:3"],
		});
	});

	it("scopes pairing and Turn grouping to normalized source identity", () => {
		const sharedCorrelation = {
			trace_id: "shared-trace",
			turn_id: "shared-turn",
			step_id: "shared-step",
			request_id: "shared-request",
			tool_call_id: "shared-call",
		};
		const sourceA = {
			robot_id: "robot-01",
			host_id: "host-01",
			component: "pi",
			instance_id: "instance-a",
		};
		const sourceB = { ...sourceA, instance_id: "instance-b" };
		const allTurns = projectTrajectory([
			envelope(1, "agent.turn", {
				phase: "start",
				state: "running",
				correlation: sharedCorrelation,
				source: sourceA,
			}),
			envelope(2, "agent.turn", {
				phase: "start",
				state: "running",
				correlation: sharedCorrelation,
				source: sourceB,
			}),
			envelope(3, "tool.execution", {
				phase: "start",
				state: "running",
				correlation: sharedCorrelation,
				attributes: { tool_name: "source-a" },
				source: sourceA,
			}),
			envelope(4, "tool.execution", {
				phase: "start",
				state: "running",
				correlation: sharedCorrelation,
				attributes: { tool_name: "source-b" },
				source: sourceB,
			}),
			envelope(5, "tool.execution", {
				phase: "end",
				state: "completed",
				correlation: sharedCorrelation,
				duration_ms: 11,
				attributes: { tool_name: "source-b", matched_start: true },
				source: sourceB,
			}),
			envelope(6, "tool.execution", {
				phase: "end",
				state: "completed",
				correlation: sharedCorrelation,
				duration_ms: 22,
				attributes: { tool_name: "source-a", matched_start: true },
				source: sourceA,
			}),
		]);
		const tools = flattenTrajectoryRecords(allTurns).filter(
			(record): record is TelemetryTrajectoryRecord =>
				record.kind !== "GAP" && record.eventKind === "tool.execution",
		);

		expect(allTurns.filter((turn) => turn.turnId === "shared-turn")).toHaveLength(2);
		expect(tools).toHaveLength(2);
		expect(tools.map((record) => [record.source.instance_id, record.durationMs])).toEqual([
			["instance-a", 22],
			["instance-b", 11],
		]);
	});

	it("uses source-owned tool identity across open, paired, and end-only windows", () => {
		const correlation = {
			trace_id: "window-trace",
			turn_id: "window-turn",
			step_id: "window-step",
			request_id: "window-request",
			tool_call_id: "window-call",
		};
		const start = envelope(1, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: { tool_name: "read" },
		});
		const end = envelope(2, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation,
			duration_ms: 10,
			attributes: { tool_name: "read", matched_start: true },
		});

		const openId = records([start])[0]?.id;
		const pairedId = records([start, end])[0]?.id;
		const endOnlyId = records([end])[0]?.id;

		expect(openId).toBe(pairedId);
		expect(endOnlyId).toBe(pairedId);
	});

	it("caps ledger summaries without changing normalized source envelopes", () => {
		const rawSummary = `${"s".repeat(4_096)}-tail`;
		const source = envelope(1, "agent.run", {
			phase: "start",
			state: "running",
			summary: rawSummary,
		});
		const projected = records([source])[0];

		expect(source.summary).toBe(rawSummary);
		expect(projected?.summary.length).toBeLessThanOrEqual(512);
		expect(projected).toMatchObject({ summaryTruncated: true });
		expect(projected?.summary.endsWith("…")).toBe(true);
	});

	it.each([
		{
			name: "run",
			kind: "agent.run",
			correlation: { trace_id: "gap-run" },
		},
		{
			name: "turn",
			kind: "agent.turn",
			correlation: {
				trace_id: "gap-run",
				turn_id: "gap-turn",
				step_id: "gap-step",
				request_id: "gap-request",
			},
		},
		{
			name: "tool",
			kind: "tool.execution",
			correlation: {
				trace_id: "gap-run",
				turn_id: "gap-turn",
				step_id: "gap-step",
				request_id: "gap-request",
				tool_call_id: "gap-tool",
			},
		},
	])("marks $name closure unknown when its open span crosses a replay gap", ({
		kind,
		correlation,
	}) => {
		const gap: TelemetryReplayGap = {
			requested: 4,
			earliest_available: 6,
			resume_after: 5,
		};
		const start = envelope(4, kind, {
			phase: "start",
			state: "running",
			correlation,
			attributes: kind === "tool.execution" ? { tool_name: "read" } : {},
		});
		const resumed = envelope(6, "context.changed", {
			phase: "snapshot",
			state: "changed",
			correlation,
		});
		const span = records([
			{ type: "event", event: start },
			{ type: "gap", gap },
			{ type: "event", event: resumed },
		]).find((record) => record.sourceEventIds.includes(start.event_id));

		expect(span).toMatchObject({
			isOpen: false,
			closureUnknown: true,
			gapTainted: true,
			gapEvidence: [gap],
		});
	});

	it("treats post-gap duplicate start as a new untainted attempt", () => {
		const correlation = {
			trace_id: "duplicate-gap-run",
			turn_id: "duplicate-gap-turn",
			step_id: "duplicate-gap-step",
			request_id: "duplicate-gap-request",
		};
		const gap: TelemetryReplayGap = {
			requested: 4,
			earliest_available: 6,
			resume_after: 5,
		};
		const start = envelope(4, "agent.turn", {
			phase: "start",
			state: "running",
			correlation,
		});
		const duplicate = envelope(6, "agent.turn", {
			phase: "start",
			state: "running",
			correlation,
			attributes: { duplicate_start: true },
		});
		const end = envelope(7, "agent.turn", {
			phase: "end",
			state: "completed",
			correlation,
			attributes: { matched_start: true },
		});
		const attempts = records([
			{ type: "event", event: start },
			{ type: "gap", gap },
			{ type: "event", event: duplicate },
			{ type: "event", event: end },
		]).filter((record) => record.eventKind === "agent.turn");

		expect(attempts).toHaveLength(2);
		expect(attempts[0]).toMatchObject({
			attemptOrdinal: 1,
			closureUnknown: true,
			gapEvidence: [gap],
		});
		expect(attempts[1]).toMatchObject({
			attemptOrdinal: 2,
			attemptOrdinalKnown: false,
			state: "completed",
			gapTainted: false,
			gapEvidence: [],
			sourceEventIds: [duplicate.event_id, end.event_id],
		});
	});

	it.each([
		{
			name: "run",
			kind: "agent.run",
			correlation: { trace_id: "gap-run" },
		},
		{
			name: "turn",
			kind: "agent.turn",
			correlation: {
				trace_id: "gap-run",
				turn_id: "gap-turn",
				step_id: "gap-step",
				request_id: "gap-request",
			},
		},
		{
			name: "tool",
			kind: "tool.execution",
			correlation: {
				trace_id: "gap-run",
				turn_id: "gap-turn",
				step_id: "gap-step",
				request_id: "gap-request",
				tool_call_id: "gap-tool",
			},
		},
	])("closes $name normally after an exact terminal while retaining gap evidence", ({
		kind,
		correlation,
	}) => {
		const gap: TelemetryReplayGap = {
			requested: 4,
			earliest_available: 6,
			resume_after: 5,
		};
		const start = envelope(4, kind, {
			phase: "start",
			state: "running",
			correlation,
			attributes: kind === "tool.execution" ? { tool_name: "read" } : {},
		});
		const resumed = envelope(6, "context.changed", {
			phase: "snapshot",
			state: "changed",
			correlation,
		});
		const end = envelope(7, kind, {
			phase: "end",
			state: "completed",
			correlation,
			duration_ms: 3,
			attributes:
				kind === "tool.execution"
					? {
						tool_name: "read",
						matched_start: true,
						lifecycle_attempt_id: "gap-tool-terminal-attempt",
					}
					: { matched_start: true },
		});
		const all = records([
			{ type: "event", event: start },
			{ type: "gap", gap },
			{ type: "event", event: resumed },
			{ type: "event", event: end },
		]);
		const span = all.find((record) => record.sourceEventIds.includes(start.event_id));
		const terminal = all.find((record) => record.sourceEventIds.includes(end.event_id));

		expect(span).toMatchObject({
			isOpen: false,
			closureUnknown: true,
			gapTainted: true,
			gapEvidence: [gap],
		});
		expect(terminal).toMatchObject({
			attemptOrdinal: 2,
			attemptOrdinalKnown: false,
			closureUnknown: true,
			gapTainted: true,
			gapEvidence: [gap],
			unmatchedTerminal: true,
			sourceEventIds: [end.event_id],
		});
	});

	it("preserves paired source envelopes and aggregates privacy metadata losslessly", () => {
		const correlation = {
			trace_id: "metadata-run",
			turn_id: "metadata-turn",
			step_id: "metadata-step",
			request_id: "metadata-request",
			tool_call_id: "metadata-tool",
		};
		const start = envelope(1, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: { tool_name: "read" },
			privacy_class: "operator",
			payload_ref: "payloads/start",
			redaction: {
				applied: false,
				fields: ["headers.authorization"],
				policy: "start-policy",
			},
		});
		const end = envelope(2, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation,
			duration_ms: 10,
			attributes: { tool_name: "read", matched_start: true },
			privacy_class: "restricted",
			payload_ref: "payloads/end",
			redaction: {
				applied: true,
				fields: ["body.secret", "headers.authorization"],
				policy: "end-policy",
			},
		});
		const tool = records([start, end]).find(
			(record) => record.eventKind === "tool.execution",
		);

		expect(tool).toMatchObject({
			privacyClass: "restricted",
			payloadRefs: ["payloads/start", "payloads/end"],
			redaction: {
				applied: true,
				fields: ["body.secret", "headers.authorization"],
			},
		});
		expect(
			(tool as unknown as { sourceEnvelopes: readonly TelemetryEvent[] }).sourceEnvelopes,
		).toEqual([start, end]);
		expect(tool).not.toHaveProperty("payloadContent");
	});

	it("retains duplicate start envelopes while tool remains open", () => {
		const correlation = {
			trace_id: "open-metadata-run",
			turn_id: "open-metadata-turn",
			step_id: "open-metadata-step",
			request_id: "open-metadata-request",
			tool_call_id: "open-metadata-tool",
		};
		const start = envelope(1, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: { tool_name: "read" },
			privacy_class: "operator",
			payload_ref: "payloads/first-start",
			redaction: { applied: false, fields: ["a"] },
		});
		const duplicate = envelope(2, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: { tool_name: "read", duplicate_start: true },
			privacy_class: "restricted",
			payload_ref: "payloads/duplicate-start",
			redaction: { applied: true, fields: ["b"] },
		});
		const tool = records([start, duplicate]).find(
			(record) => record.eventKind === "tool.execution",
		);

		expect(tool).toMatchObject({
			isOpen: true,
			privacyClass: "restricted",
			payloadRefs: ["payloads/first-start", "payloads/duplicate-start"],
			redaction: { applied: true, fields: ["a", "b"] },
		});
		expect(
			(tool as unknown as { sourceEnvelopes: readonly TelemetryEvent[] }).sourceEnvelopes,
		).toEqual([start, duplicate]);
	});

	it("keeps conflicting terminal metadata local to terminal-only attempt", () => {
		const correlation = {
			trace_id: "metadata-conflict-run",
			turn_id: "metadata-conflict-turn",
			step_id: "metadata-conflict-step",
			request_id: "metadata-conflict-request",
			tool_call_id: "metadata-conflict-tool",
		};
		const start = envelope(1, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: { tool_name: "read" },
			privacy_class: "public",
			payload_ref: "payloads/start",
			redaction: { applied: false, fields: ["a"] },
		});
		const completed = envelope(2, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation,
			attributes: { tool_name: "read", matched_start: true },
			privacy_class: "operator",
			payload_ref: "payloads/completed",
			redaction: { applied: false, fields: ["b"] },
		});
		const failed = envelope(3, "tool.execution", {
			phase: "end",
			state: "error",
			severity: "error",
			correlation,
			attributes: {
				tool_name: "read",
				is_error: true,
				matched_start: false,
				lifecycle_attempt_id: "metadata-conflict-terminal-attempt",
			},
			privacy_class: "secret",
			payload_ref: "payloads/failed",
			redaction: { applied: true, fields: ["c", "a"] },
		});
		const conflict = records([start, completed, failed]).find(
			(record) =>
				record.eventKind === "tool.execution" &&
				record.sourceEventIds.includes(failed.event_id),
		);

		expect(conflict).toMatchObject({
			privacyClass: "secret",
			payloadRefs: ["payloads/failed"],
			redaction: { applied: true, fields: ["a", "c"] },
			sourceEventIds: [failed.event_id],
			unmatchedTerminal: true,
			terminalConflict: false,
		});
		expect(
			(conflict as unknown as { sourceEnvelopes: readonly TelemetryEvent[] }).sourceEnvelopes,
		).toEqual([failed]);
	});
});
