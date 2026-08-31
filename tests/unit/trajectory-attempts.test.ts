import { describe, expect, it } from "vitest";
import {
	flattenTrajectoryRecords,
	projectTrajectory,
} from "../../web/src/observe/trajectory/project.js";
import type {
	TelemetryTrajectoryRecord,
	TrajectoryProjectionInput,
} from "../../web/src/observe/trajectory/record.js";
import {
	parseTelemetryEvent,
	type TelemetryEvent,
	type TelemetryReplayGap,
} from "../../web/src/observe/telemetry-types.js";

function event(
	sequence: number,
	kind: string,
	overrides: Partial<TelemetryEvent> = {},
): TelemetryEvent {
	return parseTelemetryEvent({
		schema_version: 1,
		event_id: `attempt:event:${sequence}`,
		sequence,
		observed_at: new Date(Date.UTC(2026, 7, 31) + sequence).toISOString(),
		monotonic_ns: sequence,
		kind,
		severity: "info",
		source: {
			robot_id: "robot-01",
			host_id: "host-01",
			component: "pi",
			instance_id: "attempt-session",
		},
		attributes: {},
		privacy_class: "operator",
		...overrides,
	});
}

function telemetryRecords(inputs: readonly TrajectoryProjectionInput[]) {
	return flattenTrajectoryRecords(projectTrajectory(inputs)).filter(
		(record): record is TelemetryTrajectoryRecord => record.kind !== "GAP",
	);
}

const CASES = [
	{
		name: "run",
		kind: "agent.run",
		correlation: { trace_id: "shared-run" },
		secondCorrelation: { trace_id: "shared-run-2" },
		startAttributes: {},
		endAttributes: { matched_start: true },
	},
	{
		name: "turn",
		kind: "agent.turn",
		correlation: {
			trace_id: "shared-run",
			turn_id: "shared-turn",
			step_id: "shared-step",
			request_id: "shared-request",
		},
		secondCorrelation: {
			trace_id: "shared-run",
			turn_id: "shared-turn-2",
			step_id: "shared-step-2",
			request_id: "shared-request-2",
		},
		startAttributes: {},
		endAttributes: { matched_start: true },
	},
	{
		name: "tool",
		kind: "tool.execution",
		correlation: {
			trace_id: "shared-run",
			turn_id: "shared-turn",
			step_id: "shared-step",
			request_id: "shared-request",
			tool_call_id: "shared-tool",
		},
		secondCorrelation: {
			trace_id: "shared-run",
			turn_id: "shared-turn",
			step_id: "shared-step",
			request_id: "shared-request",
			tool_call_id: "shared-tool",
		},
		startAttributes: { tool_name: "read" },
		endAttributes: { tool_name: "read", matched_start: true },
	},
] as const;

describe("trajectory lifecycle attempts", () => {
	it("uses source-owned tool attempt ID across open, paired, and hydrated windows", () => {
		const correlation = {
			trace_id: "source-id-run",
			turn_id: "source-id-turn",
			step_id: "source-id-step",
			request_id: "source-id-request",
			tool_call_id: "reused-tool-call",
		};
		const start = event(1, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: {
				tool_name: "read",
				lifecycle_attempt_id: "source-tool-attempt-1",
			},
		});
		const end = event(2, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation,
			attributes: {
				tool_name: "read",
				matched_start: true,
				lifecycle_attempt_id: "source-tool-attempt-1",
			},
		});
		const openId = telemetryRecords([start])[0]?.id;
		const pairedId = telemetryRecords([start, end])[0]?.id;
		const endOnlyId = telemetryRecords([end])[0]?.id;
		const hydrated = telemetryRecords([end, start]);
		const second = event(3, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: {
				tool_name: "read",
				lifecycle_attempt_id: "source-tool-attempt-2",
			},
		});

		expect(openId).toBe(pairedId);
		expect(pairedId).toBe(endOnlyId);
		expect(hydrated).toHaveLength(1);
		expect(hydrated[0]?.sourceEventIds).toEqual([start.event_id, end.event_id]);
		expect(telemetryRecords([start, end, second])).toHaveLength(2);
		expect(telemetryRecords([start, end, second])[1]?.id).not.toBe(pairedId);
	});

	it("keeps legacy tool start/end without source attempt IDs separate", () => {
		const correlation = {
			trace_id: "legacy-run",
			turn_id: "legacy-turn",
			step_id: "legacy-step",
			request_id: "legacy-request",
			tool_call_id: "legacy-call",
		};
		const start = event(1, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: { tool_name: "read" },
		});
		const end = event(2, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation,
			attributes: { tool_name: "read", matched_start: true },
		});
		const records = telemetryRecords([start, end]);

		expect(records).toHaveLength(2);
		expect(records.map((record) => record.sourceEventIds)).toEqual([
			[start.event_id],
			[end.event_id],
		]);
		expect(new Set(records.map((record) => record.id)).size).toBe(2);
		expect(records[0]).toMatchObject({
			state: "unmatched_start",
			closureUnknown: true,
			diagnostic: true,
			unmatchedTerminal: false,
		});
		expect(records[1]).toMatchObject({
			state: "unmatched_terminal",
			diagnostic: true,
			unmatchedTerminal: true,
		});
	});

	it("reconnects exact source-owned tool attempt across gap without losing evidence", () => {
		const correlation = {
			trace_id: "exact-gap-run",
			turn_id: "exact-gap-turn",
			step_id: "exact-gap-step",
			request_id: "exact-gap-request",
			tool_call_id: "exact-gap-call",
		};
		const gap: TelemetryReplayGap = {
			requested: 1,
			earliest_available: 3,
			resume_after: 2,
		};
		const start = event(1, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: {
				tool_name: "read",
				lifecycle_attempt_id: "exact-gap-attempt",
			},
		});
		const end = event(3, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation,
			duration_ms: 2,
			attributes: {
				tool_name: "read",
				matched_start: true,
				lifecycle_attempt_id: "exact-gap-attempt",
			},
		});
		const records = telemetryRecords([
			{ type: "event", event: start },
			{ type: "gap", gap },
			{ type: "event", event: end },
		]);

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			state: "completed",
			durationMs: 2,
			isOpen: false,
			closureUnknown: false,
			gapTainted: true,
			gapEvidence: [gap],
			sourceEventIds: [start.event_id, end.event_id],
		});
	});

	it("reopens exact post-gap duplicate start while retaining gap evidence", () => {
		const correlation = {
			trace_id: "duplicate-gap-source-run",
			turn_id: "duplicate-gap-source-turn",
			step_id: "duplicate-gap-source-step",
			request_id: "duplicate-gap-source-request",
			tool_call_id: "duplicate-gap-source-call",
		};
		const gap: TelemetryReplayGap = {
			requested: 1,
			earliest_available: 3,
			resume_after: 2,
		};
		const attributes = {
			tool_name: "read",
			lifecycle_attempt_id: "duplicate-gap-source-attempt",
		};
		const start = event(1, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes,
		});
		const duplicate = event(3, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: { ...attributes, duplicate_start: true },
		});
		const terminal = event(4, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation,
			attributes: { ...attributes, matched_start: true },
		});
		const reopened = telemetryRecords([
			{ type: "event", event: start },
			{ type: "gap", gap },
			{ type: "event", event: duplicate },
		]);
		const settled = telemetryRecords([
			{ type: "event", event: start },
			{ type: "gap", gap },
			{ type: "event", event: duplicate },
			{ type: "event", event: terminal },
		]);

		expect(reopened).toHaveLength(1);
		expect(reopened[0]).toMatchObject({
			state: "running",
			isOpen: true,
			closureUnknown: false,
			gapTainted: true,
			gapEvidence: [gap],
			attributes: { duplicate_start: true },
			sourceEventIds: [start.event_id, duplicate.event_id],
		});
		expect(settled).toHaveLength(1);
		expect(settled[0]).toMatchObject({
			state: "completed",
			isOpen: false,
			closureUnknown: false,
			gapTainted: true,
			gapEvidence: [gap],
			sourceEventIds: [start.event_id, duplicate.event_id, terminal.event_id],
		});
	});

	it("reconciles terminal-before-start exact source ID into one lossless row", () => {
		const correlation = {
			trace_id: "reverse-run",
			turn_id: "reverse-turn",
			step_id: "reverse-step",
			request_id: "reverse-request",
			tool_call_id: "reverse-call",
		};
		const attemptAttributes = {
			tool_name: "read",
			lifecycle_attempt_id: "reverse-attempt",
		};
		const terminal = event(1, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation,
			duration_ms: 7,
			attributes: { ...attemptAttributes, matched_start: true },
		});
		const start = event(2, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: attemptAttributes,
		});
		const records = telemetryRecords([terminal, start]);

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			state: "completed",
			durationMs: 7,
			isOpen: false,
			identityReuse: false,
			temporalOrderConflict: true,
			sourceEventIds: [terminal.event_id, start.event_id],
		});
		expect(records[0]?.startedAt).toBeUndefined();
		expect(records[0]?.endedAt).toBeUndefined();
	});

	it("disambiguates terminal-start-terminal source ID reuse without cumulative evidence", () => {
		const correlation = {
			trace_id: "reverse-reuse-run",
			turn_id: "reverse-reuse-turn",
			step_id: "reverse-reuse-step",
			request_id: "reverse-reuse-request",
			tool_call_id: "reverse-reuse-call",
		};
		const attemptAttributes = {
			tool_name: "read",
			lifecycle_attempt_id: "reverse-reuse-attempt",
		};
		const firstTerminal = event(1, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation,
			attributes: { ...attemptAttributes, matched_start: true },
		});
		const start = event(2, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: attemptAttributes,
		});
		const secondTerminal = event(3, "tool.execution", {
			phase: "end",
			state: "error",
			severity: "error",
			correlation,
			attributes: { ...attemptAttributes, is_error: true, matched_start: false },
		});
		const records = telemetryRecords([firstTerminal, start, secondTerminal]);

		expect(records).toHaveLength(2);
		expect(new Set(records.map((record) => record.id)).size).toBe(2);
		expect(records[0]?.sourceEventIds).toEqual([firstTerminal.event_id, start.event_id]);
		expect(records[1]).toMatchObject({
			kind: "ERROR",
			identityReuse: true,
			terminalConflict: true,
			sourceEventIds: [secondTerminal.event_id],
		});
	});

	it("disambiguates settled source attempt ID reuse into local rows", () => {
		const correlation = {
			trace_id: "settled-reuse-run",
			turn_id: "settled-reuse-turn",
			step_id: "settled-reuse-step",
			request_id: "settled-reuse-request",
			tool_call_id: "settled-reuse-call",
		};
		const attrs = { tool_name: "read", lifecycle_attempt_id: "settled-reuse-attempt" };
		const inputs = [
			event(1, "tool.execution", {
				phase: "start", state: "running", correlation, attributes: attrs,
			}),
			event(2, "tool.execution", {
				phase: "end", state: "completed", correlation,
				attributes: { ...attrs, matched_start: true },
			}),
			event(3, "tool.execution", {
				phase: "start", state: "running", correlation, attributes: attrs,
			}),
			event(4, "tool.execution", {
				phase: "end", state: "completed", correlation,
				attributes: { ...attrs, matched_start: true },
			}),
		];
		const records = telemetryRecords(inputs);

		expect(records).toHaveLength(2);
		expect(new Set(records.map((record) => record.id)).size).toBe(2);
		expect(records.map((record) => record.sourceEventIds)).toEqual([
			["attempt:event:1", "attempt:event:2"],
			["attempt:event:3", "attempt:event:4"],
		]);
		expect(records[1]).toMatchObject({ identityReuse: true, terminalConflict: true });
	});

	it.each(CASES)("creates two source-scoped $name attempts for two start/end cycles", ({
		kind,
		correlation,
		secondCorrelation,
		startAttributes,
		endAttributes,
	}) => {
		const firstStartAttributes = kind === "tool.execution"
			? { ...startAttributes, lifecycle_attempt_id: "case-tool-attempt-1" }
			: startAttributes;
		const firstEndAttributes = kind === "tool.execution"
			? { ...endAttributes, lifecycle_attempt_id: "case-tool-attempt-1" }
			: endAttributes;
		const secondStartAttributes = kind === "tool.execution"
			? { ...startAttributes, lifecycle_attempt_id: "case-tool-attempt-2" }
			: startAttributes;
		const secondEndAttributes = kind === "tool.execution"
			? { ...endAttributes, lifecycle_attempt_id: "case-tool-attempt-2" }
			: endAttributes;
		const records = telemetryRecords([
			event(1, kind, {
				phase: "start",
				state: "running",
				correlation,
				attributes: firstStartAttributes,
			}),
			event(2, kind, {
				phase: "end",
				state: "completed",
				correlation,
				duration_ms: 10,
				attributes: firstEndAttributes,
			}),
			event(3, kind, {
				phase: "start",
				state: "running",
				correlation: secondCorrelation,
				attributes: secondStartAttributes,
			}),
			event(4, kind, {
				phase: "end",
				state: "completed",
				correlation: secondCorrelation,
				duration_ms: 20,
				attributes: secondEndAttributes,
			}),
		]).filter((record) => record.eventKind === kind);

		expect(records).toHaveLength(2);
		expect(records.map((record) => record.attemptOrdinal)).toEqual(
			kind === "tool.execution" ? [1, 2] : [1, 1],
		);
		expect(records.every((record) => record.attemptOrdinalKnown)).toBe(false);
		expect(records.map((record) => record.durationMs)).toEqual([10, 20]);
		expect(records.map((record) => record.sourceEventIds)).toEqual([
			["attempt:event:1", "attempt:event:2"],
			["attempt:event:3", "attempt:event:4"],
		]);
		expect(new Set(records.map((record) => record.id)).size).toBe(2);
		expect(records.every((record) => record.terminalConflict === false)).toBe(true);
		expect(records.every((record) => record.unmatchedTerminal === false)).toBe(true);
	});

	it("merges duplicate start diagnostics into one open attempt", () => {
		const correlation = {
			trace_id: "duplicate-run",
			turn_id: "duplicate-turn",
			step_id: "duplicate-step",
			request_id: "duplicate-request",
			tool_call_id: "duplicate-tool",
		};
		const records = telemetryRecords([
			event(1, "tool.execution", {
				phase: "start",
				state: "running",
				correlation,
				attributes: {
					tool_name: "read",
					lifecycle_attempt_id: "duplicate-source-attempt",
				},
			}),
			event(2, "tool.execution", {
				phase: "start",
				state: "running",
				correlation,
				attributes: {
					tool_name: "read",
					duplicate_start: true,
					lifecycle_attempt_id: "duplicate-source-attempt",
				},
			}),
		]);

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			attemptOrdinal: 1,
			isOpen: true,
			unmatchedTerminal: false,
			attributes: { tool_name: "read", duplicate_start: true },
			sourceEventIds: ["attempt:event:1", "attempt:event:2"],
		});
	});

	it("keeps no-open terminals local instead of copying prior attempt evidence", () => {
		const correlation = {
			trace_id: "terminal-run",
			turn_id: "terminal-turn",
			step_id: "terminal-step",
			request_id: "terminal-request",
			tool_call_id: "terminal-tool",
		};
		const completed = event(2, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation,
			attributes: {
				tool_name: "read",
				matched_start: false,
				lifecycle_attempt_id: "terminal-source-attempt-1",
			},
		});
		const failed = event(3, "tool.execution", {
			phase: "end",
			state: "error",
			severity: "error",
			correlation,
			attributes: {
				tool_name: "read",
				is_error: true,
				matched_start: false,
				lifecycle_attempt_id: "terminal-source-attempt-2",
			},
		});
		const records = telemetryRecords([completed, failed]);

		expect(records).toHaveLength(2);
		expect(records.map((record) => record.attemptOrdinal)).toEqual([1, 2]);
		expect(records[0]).toMatchObject({
			unmatchedTerminal: true,
			terminalConflict: false,
			sourceEventIds: [completed.event_id],
		});
		expect(records[1]).toMatchObject({
			kind: "ERROR",
			unmatchedTerminal: true,
			terminalConflict: false,
			sourceEventIds: [failed.event_id],
		});
	});

	it("treats replay gap as attempt boundary before terminal-only evidence", () => {
		const correlation = { trace_id: "gap-retry-run" };
		const gap: TelemetryReplayGap = {
			requested: 2,
			earliest_available: 4,
			resume_after: 3,
		};
		const start = event(1, "agent.run", {
			phase: "start",
			state: "running",
			correlation,
		});
		const retrying = event(2, "agent.run", {
			phase: "end",
			state: "retrying",
			severity: "warning",
			correlation,
			attributes: { matched_start: true },
		});
		const completed = event(4, "agent.run", {
			phase: "end",
			state: "completed",
			correlation,
			attributes: { matched_start: false },
		});
		const records = telemetryRecords([
			{ type: "event", event: start },
			{ type: "event", event: retrying },
			{ type: "gap", gap },
			{ type: "event", event: completed },
		]);

		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			attemptOrdinal: 1,
			state: "retrying",
			sourceEventIds: [start.event_id, retrying.event_id],
		});
		expect(records[1]).toMatchObject({
			attemptOrdinal: 2,
			attemptOrdinalKnown: false,
			state: "closure_unknown",
			unmatchedTerminal: true,
			terminalConflict: false,
			closureUnknown: true,
			gapTainted: true,
			gapEvidence: [gap],
			sourceEventIds: [completed.event_id],
		});
	});

	it("marks aggregate privacy incomplete when any attempt envelope omits privacy class", () => {
		const correlation = {
			trace_id: "privacy-run",
			turn_id: "privacy-turn",
			step_id: "privacy-step",
			request_id: "privacy-request",
			tool_call_id: "privacy-tool",
		};
		const start = event(1, "tool.execution", {
			phase: "start",
			state: "running",
			correlation,
			attributes: {
				tool_name: "read",
				lifecycle_attempt_id: "privacy-source-attempt",
			},
			privacy_class: "restricted",
		});
		const end = event(2, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation,
			attributes: {
				tool_name: "read",
				matched_start: true,
				lifecycle_attempt_id: "privacy-source-attempt",
			},
			privacy_class: undefined,
		});
		const [record] = telemetryRecords([start, end]);

		expect(record).toMatchObject({ privacyIncomplete: true });
		expect(record?.privacyClass).toBeUndefined();
	});

	it("keeps durable attempt ID stable when an older source attempt is prepended", () => {
		const correlation = { trace_id: "prepend-run" };
		const olderCorrelation = { trace_id: "prepend-run-older" };
		const currentStart = event(3, "agent.run", {
			phase: "start",
			state: "running",
			correlation,
		});
		const currentEnd = event(4, "agent.run", {
			phase: "end",
			state: "completed",
			correlation,
			attributes: { matched_start: true },
		});
		const before = telemetryRecords([currentStart, currentEnd])[0];
		const after = telemetryRecords([
			event(1, "agent.run", {
				phase: "start",
				state: "running",
				correlation: olderCorrelation,
			}),
			event(2, "agent.run", {
				phase: "end",
				state: "completed",
				correlation: olderCorrelation,
				attributes: { matched_start: true },
			}),
			currentStart,
			currentEnd,
		]).find((record) => record.sourceEventIds.includes(currentStart.event_id));

		expect(after?.id).toBe(before?.id);
		expect(after?.attemptOrdinal).toBe(1);
		expect(before?.attemptOrdinal).toBe(1);
	});

	it("preserves every relevant gap and leaves post-gap ordinal unknown", () => {
		const correlation = { trace_id: "multi-gap-run" };
		const firstGap: TelemetryReplayGap = {
			requested: 1,
			earliest_available: 3,
			resume_after: 2,
		};
		const secondGap: TelemetryReplayGap = {
			requested: 2,
			earliest_available: 5,
			resume_after: 4,
		};
		const start = event(1, "agent.run", {
			phase: "start",
			state: "running",
			correlation,
		});
		const terminal = event(5, "agent.run", {
			phase: "end",
			state: "completed",
			correlation,
			attributes: { matched_start: false },
		});
		const records = telemetryRecords([
			{ type: "event", event: start },
			{ type: "gap", gap: firstGap },
			{ type: "gap", gap: secondGap },
			{ type: "event", event: terminal },
		]);

		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			attemptOrdinal: 1,
			attemptOrdinalKnown: false,
			closureUnknown: true,
			gapEvidence: [firstGap, secondGap],
		});
		expect(records[1]).toMatchObject({
			attemptOrdinal: 2,
			attemptOrdinalKnown: false,
			closureUnknown: true,
			gapEvidence: [firstGap, secondGap],
			sourceEventIds: [terminal.event_id],
		});
	});

	it("keeps 10,000 terminal-only source-envelope references linear", () => {
		const correlation = {
			trace_id: "bounded-run",
			turn_id: "bounded-turn",
			step_id: "bounded-step",
			request_id: "bounded-request",
			tool_call_id: "bounded-tool",
		};
		const events = Array.from({ length: 10_000 }, (_, index) =>
			event(index + 1, "tool.execution", {
				phase: "end",
				state: index % 2 === 0 ? "completed" : "error",
				severity: index % 2 === 0 ? "info" : "error",
				correlation,
				attributes: {
					tool_name: "read",
					is_error: index % 2 === 1,
					matched_start: false,
					lifecycle_attempt_id: `bounded-source-attempt-${index + 1}`,
				},
			}),
		);
		const records = telemetryRecords(events);
		const referenceCount = records.reduce(
			(total, record) => total + record.sourceEnvelopes.length,
			0,
		);

		expect(records).toHaveLength(10_000);
		expect(new Set(records.map((record) => record.id)).size).toBe(10_000);
		expect(referenceCount).toBe(10_000);
		expect(Math.max(...records.map((record) => record.sourceEnvelopes.length))).toBe(1);
	});

	it("bounds lifecycle gap evidence while retaining every global gap row", () => {
		const inputs: TrajectoryProjectionInput[] = [];
		for (let index = 1; index <= 1_000; index += 1) {
			inputs.push(event(index, "agent.run", {
				phase: "start",
				state: "running",
				correlation: { trace_id: `gap-load-run-${index}` },
			}));
		}
		for (let index = 1; index <= 1_000; index += 1) {
			inputs.push({
				type: "gap",
				gap: {
					requested: 1_000 + index - 1,
					earliest_available: 1_000 + index + 1,
					resume_after: 1_000 + index,
				},
			});
		}

		const allRecords = flattenTrajectoryRecords(projectTrajectory(inputs));
		const attempts = allRecords.filter(
			(record): record is TelemetryTrajectoryRecord => record.kind !== "GAP",
		);
		const gapRows = allRecords.filter((record) => record.kind === "GAP");
		const retainedGapRefs = attempts.reduce(
			(total, record) => total + record.gapEvidence.length,
			0,
		);

		expect(attempts).toHaveLength(1_000);
		expect(gapRows).toHaveLength(1_000);
		expect(retainedGapRefs).toBeLessThanOrEqual(16_000);
		expect(attempts.every((record) => record.gapCount === 1_000)).toBe(true);
		expect(attempts.every((record) => record.gapEvidenceTruncated === true)).toBe(true);
	});

	it("keeps 10,000 retry-cycle event references linear", () => {
		const correlation = { trace_id: "bounded-retry-run" };
		const events = Array.from({ length: 5_000 }, (_, index) => {
			const startSequence = index * 2 + 1;
			const endSequence = startSequence + 1;
			return [
				event(startSequence, "agent.run", {
					phase: "start",
					state: "running",
					correlation,
					attributes: index === 0 ? {} : { duplicate_start: true },
				}),
				event(endSequence, "agent.run", {
					phase: "end",
					state: index === 4_999 ? "completed" : "retrying",
					severity: index === 4_999 ? "info" : "warning",
					correlation,
					attributes: { matched_start: true },
				}),
			];
		}).flat();
		const records = telemetryRecords(events);
		const referenceCount = records.reduce(
			(total, record) => total + record.sourceEnvelopes.length,
			0,
		);

		expect(records).toHaveLength(5_000);
		expect(new Set(records.map((record) => record.id)).size).toBe(5_000);
		expect(referenceCount).toBe(10_000);
		expect(Math.max(...records.map((record) => record.sourceEnvelopes.length))).toBe(2);
		expect(records[0]?.attemptOrdinal).toBe(1);
		expect(records.at(-1)?.attemptOrdinal).toBe(5_000);
	});
});
