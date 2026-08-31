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
		startAttributes: { tool_name: "read" },
		endAttributes: { tool_name: "read", matched_start: true },
	},
] as const;

describe("trajectory lifecycle attempts", () => {
	it.each(CASES)("creates two source-scoped $name attempts for two start/end cycles", ({
		kind,
		correlation,
		startAttributes,
		endAttributes,
	}) => {
		const records = telemetryRecords([
			event(1, kind, {
				phase: "start",
				state: "running",
				correlation,
				attributes: startAttributes,
			}),
			event(2, kind, {
				phase: "end",
				state: "completed",
				correlation,
				duration_ms: 10,
				attributes: endAttributes,
			}),
			event(3, kind, {
				phase: "start",
				state: "running",
				correlation,
				attributes: startAttributes,
			}),
			event(4, kind, {
				phase: "end",
				state: "completed",
				correlation,
				duration_ms: 20,
				attributes: endAttributes,
			}),
		]).filter((record) => record.eventKind === kind);

		expect(records).toHaveLength(2);
		expect(records.map((record) => record.attemptOrdinal)).toEqual([1, 2]);
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
				attributes: { tool_name: "read" },
			}),
			event(2, "tool.execution", {
				phase: "start",
				state: "running",
				correlation,
				attributes: { tool_name: "read", duplicate_start: true },
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
			attributes: { tool_name: "read", matched_start: false },
		});
		const failed = event(3, "tool.execution", {
			phase: "end",
			state: "error",
			severity: "error",
			correlation,
			attributes: { tool_name: "read", is_error: true, matched_start: false },
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
			terminalConflict: true,
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
			attributes: { tool_name: "read" },
			privacy_class: "restricted",
		});
		const end = event(2, "tool.execution", {
			phase: "end",
			state: "completed",
			correlation,
			attributes: { tool_name: "read", matched_start: true },
			privacy_class: undefined,
		});
		const [record] = telemetryRecords([start, end]);

		expect(record).toMatchObject({ privacyIncomplete: true });
		expect(record?.privacyClass).toBeUndefined();
	});

	it("keeps durable attempt ID stable when older same-key attempt is prepended", () => {
		const correlation = { trace_id: "prepend-run" };
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
				correlation,
			}),
			event(2, "agent.run", {
				phase: "end",
				state: "completed",
				correlation,
				attributes: { matched_start: true },
			}),
			currentStart,
			currentEnd,
		]).find((record) => record.sourceEventIds.includes(currentStart.event_id));

		expect(after?.id).toBe(before?.id);
		expect(after?.attemptOrdinal).toBe(2);
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
				},
			}),
		);
		const records = telemetryRecords(events);
		const referenceCount = records.reduce(
			(total, record) => total + record.sourceEnvelopes.length,
			0,
		);

		expect(records).toHaveLength(10_000);
		expect(referenceCount).toBe(10_000);
		expect(Math.max(...records.map((record) => record.sourceEnvelopes.length))).toBe(1);
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
		expect(referenceCount).toBe(10_000);
		expect(Math.max(...records.map((record) => record.sourceEnvelopes.length))).toBe(2);
		expect(records[0]?.attemptOrdinal).toBe(1);
		expect(records.at(-1)?.attemptOrdinal).toBe(5_000);
	});
});
