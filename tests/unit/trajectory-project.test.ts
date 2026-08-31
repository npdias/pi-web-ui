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
	projectTrajectory,
} from "../../web/src/observe/trajectory/project.js";
import {
	formatDurationMillis,
	trajectoryRecordId,
} from "../../web/src/observe/trajectory/record.js";
import type { TelemetryTrajectoryRecord } from "../../web/src/observe/trajectory/record.js";
import type {
	TelemetryEvent,
	TelemetryReplayGap,
} from "../../web/src/observe/telemetry-types.js";
import { parseTelemetryEvent } from "../../web/src/observe/telemetry-types.js";

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
		attributes: {},
		privacy_class: "operator",
		...overrides,
	});
}

function records(events: readonly TelemetryEvent[]) {
	return flattenTrajectoryRecords(projectTrajectory(events));
}

describe("projectTrajectory", () => {
	it("groups the normal fixture by explicit Turn and Step IDs and pairs its tool", () => {
		const turns = projectTrajectory(fixtureEvents("normal"));
		const turn = turns.find((candidate) => candidate.turnId === "normal:turn:1");
		const all = flattenTrajectoryRecords(turns);
		const tool = all.find((record) => record.toolCallId === "normal:tool:tool-1");
		const request = all.find(
			(record) =>
				record.eventKind === "agent.turn" &&
				record.phase === "start" &&
				record.turnId === "normal:turn:1",
		);

		expect(turn?.steps).toHaveLength(1);
		expect(turn?.steps[0]).toMatchObject({
			stepId: "normal:step:1",
			requestId: "normal:request:1",
		});
		expect(tool).toMatchObject({
			kind: "TOOL",
			state: "completed",
			durationMs: 50,
			isOpen: false,
			sourceEventIds: ["normal:event:3", "normal:event:4"],
			parentRecordId: request?.id,
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
			"agent.turn",
			"agent.run",
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

	it("keeps retry starts open by sequence and folds diagnostic duplicate tool starts", () => {
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
				attributes: { tool_name: "read", matched_start: false },
			}),
		]);
		const runStarts = all.filter(
			(record) => record.eventKind === "agent.run" && record.phase === "start",
		);
		const tools = all.filter((record) => record.eventKind === "tool.execution");

		expect(runStarts.map((record) => record.isOpen)).toEqual([false, true]);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			isOpen: false,
			durationMs: 2,
			sourceEventIds: [
				"synthetic:event:4",
				"synthetic:event:5",
				"synthetic:event:6",
				"synthetic:event:7",
			],
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

	it("keeps tool identity stable when its start enters or leaves the loaded window", () => {
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
		expect(pairedId).toBe(endOnlyId);
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
});
