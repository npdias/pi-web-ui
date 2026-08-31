/**
 * Search tests adapted from DeepSeek Harness trajectory search-index contracts.
 * Donor: packages/client/ui-trajectory/src/client/trajectory-search-index.ts
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { describe, expect, it } from "vitest";
import { projectTrajectory } from "../../web/src/observe/trajectory/project.js";
import { TrajectorySearchIndex } from "../../web/src/observe/trajectory/search-index.js";
import type {
	TelemetryEvent,
	TelemetryReplayGap,
} from "../../web/src/observe/telemetry-types.js";
import { parseTelemetryEvent } from "../../web/src/observe/telemetry-types.js";

function event(
	sequence: number,
	kind: string,
	overrides: Partial<TelemetryEvent> = {},
): TelemetryEvent {
	return parseTelemetryEvent({
		schema_version: 1,
		event_id: `search:event:${sequence}`,
		sequence,
		observed_at: new Date(Date.UTC(2026, 7, 31) + sequence).toISOString(),
		monotonic_ns: sequence,
		kind,
		severity: "info",
		source: {
			robot_id: "robot-01",
			host_id: "host-01",
			component: "pi",
			instance_id: "search-session",
			version: "0.84.4",
		},
		attributes: {},
		privacy_class: "operator",
		...overrides,
	});
}

function fixture(summary = "Deploy Widget") {
	const scope = {
		trace_id: "trace-search",
		turn_id: "turn-search",
		step_id: "step-search",
		request_id: "request-search",
	};
	return [
		event(1, "agent.turn", {
			phase: "start",
			state: "running",
			summary,
			correlation: scope,
		}),
		event(2, "tool.execution", {
			phase: "start",
			state: "running",
			summary: "Read project config",
			correlation: { ...scope, tool_call_id: "call-search" },
			attributes: {
				tool_name: "read",
				secret_note: "do-not-index-private-detail",
			},
			payload_ref: "payloads/do-not-index-ref",
		}),
		event(3, "provider.thinking", {
			phase: "end",
			state: "emitted",
			correlation: scope,
			attributes: { content: "provider visible rationale", content_index: 0 },
		}),
		event(4, "context.changed", {
			phase: "snapshot",
			state: "changed",
			correlation: scope,
			attributes: {
				system_prompt_hash: "sha256:do-not-index-system-hash",
				tool_schema_hash: "sha256:do-not-index-schema-hash",
			},
		}),
	];
}

describe("TrajectorySearchIndex", () => {
	it("matches all terms across permitted redacted display fields", () => {
		const index = new TrajectorySearchIndex();
		const turns = projectTrajectory(fixture());

		expect(index.update(turns)).toBe(true);
		expect(index.search("deploy widget")?.size).toBe(1);
		expect(index.search("READ config")?.size).toBe(1);
		expect(index.search("provider rationale")?.size).toBe(1);
		expect(index.search("pi 0.84.4")?.size).toBeGreaterThan(0);
		expect(index.search("trace-search")?.size).toBeGreaterThan(0);
		expect(index.search("missing")).toEqual(new Set());
		expect(index.search("   ")).toBeNull();
	});

	it("does not index arbitrary attributes, payload refs, or context hashes", () => {
		const index = new TrajectorySearchIndex();
		index.update(projectTrajectory(fixture()));

		expect(index.search("do-not-index-private-detail")).toEqual(new Set());
		expect(index.search("do-not-index-ref")).toEqual(new Set());
		expect(index.search("do-not-index-system-hash")).toEqual(new Set());
		expect(index.search("do-not-index-schema-hash")).toEqual(new Set());
	});

	it("reuses its map and cached result identity when record sources are unchanged", () => {
		const index = new TrajectorySearchIndex();
		const events = fixture();
		const firstProjection = projectTrajectory(events);
		index.update(firstProjection);
		const firstResult = index.search("deploy");

		expect(index.update(firstProjection)).toBe(false);
		expect(index.search("deploy")).toBe(firstResult);
		expect(index.update(projectTrajectory(events))).toBe(false);
		expect(index.search("deploy")).toBe(firstResult);

		expect(index.update(projectTrajectory(fixture("Repair Widget")))).toBe(true);
		expect(index.search("deploy")).toEqual(new Set());
		expect(index.search("repair")?.size).toBe(1);
	});

	it("bounds normalized source and query text", () => {
		const hiddenTail = "not-searchable-beyond-bound";
		const longSummary = `${"boundedprefix ".repeat(2_000)}${hiddenTail}`;
		const index = new TrajectorySearchIndex();
		index.update(projectTrajectory(fixture(longSummary)));

		expect(index.search("boundedprefix")?.size).toBe(1);
		expect(index.search(hiddenTail)).toEqual(new Set());
		expect(() => index.search("x".repeat(20_000))).not.toThrow();
	});

	it("bounds cached result sets and evicts least-recently-used queries", () => {
		const index = new TrajectorySearchIndex();
		index.update(projectTrajectory(fixture()));
		const first = index.search("deploy");

		for (let query = 0; query < 40; query++) index.search(`missing-${query}`);

		expect(index.search("deploy")).not.toBe(first);
		expect(index.cachedQueryCount).toBeLessThanOrEqual(32);
	});

	it("indexes top-level attempt diagnostics without indexing payload refs", () => {
		const scope = {
			trace_id: "diagnostic-run",
			turn_id: "diagnostic-turn",
			step_id: "diagnostic-step",
			request_id: "diagnostic-request",
		};
		const gap: TelemetryReplayGap = {
			requested: 2,
			earliest_available: 4,
			resume_after: 3,
		};
		const index = new TrajectorySearchIndex();
		index.update(projectTrajectory([
			event(1, "tool.execution", {
				phase: "start",
				state: "running",
				correlation: { ...scope, tool_call_id: "gap-call" },
				attributes: { tool_name: "read" },
				payload_ref: "payloads/never-search-gap",
			}),
			event(2, "tool.execution", {
				phase: "start",
				state: "running",
				correlation: { ...scope, tool_call_id: "gap-call" },
				attributes: { tool_name: "read", duplicate_start: true },
			}),
			{ type: "gap", gap },
			event(4, "tool.execution", {
				phase: "end",
				state: "completed",
				correlation: { ...scope, tool_call_id: "gap-call" },
				attributes: { tool_name: "read", matched_start: false },
			}),
			event(5, "tool.execution", {
				phase: "start",
				state: "running",
				correlation: { ...scope, tool_call_id: "privacy-call" },
				attributes: { tool_name: "write" },
				privacy_class: undefined,
			}),
			event(6, "tool.execution", {
				phase: "end",
				state: "completed",
				correlation: { ...scope, tool_call_id: "privacy-call" },
				attributes: { tool_name: "write", matched_start: true },
			}),
			event(7, "tool.execution", {
				phase: "end",
				state: "error",
				severity: "error",
				correlation: { ...scope, tool_call_id: "privacy-call" },
				attributes: { tool_name: "write", is_error: true, matched_start: false },
				payload_ref: "payloads/never-search-conflict",
			}),
		]));

		expect(index.search("diagnostic")?.size).toBeGreaterThan(0);
		expect(index.search("duplicate start")?.size).toBe(1);
		expect(index.search("gap tainted")?.size).toBeGreaterThan(0);
		expect(index.search("closure unknown")?.size).toBeGreaterThan(0);
		expect(index.search("unmatched terminal")?.size).toBeGreaterThan(0);
		expect(index.search("terminal conflict")?.size).toBe(1);
		expect(index.search("privacy incomplete")?.size).toBe(1);
		expect(index.search("never-search-gap")).toEqual(new Set());
		expect(index.search("never-search-conflict")).toEqual(new Set());
	});
});
