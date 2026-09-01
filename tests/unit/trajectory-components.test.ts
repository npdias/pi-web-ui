/**
 * Component contracts adapted from DeepSeek Harness trajectory view tests.
 * Donor: packages/client/ui-trajectory/tests/views.client.spec.tsx,
 * tests/table.client.spec.tsx, and tests/cell.client.spec.tsx
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrajectoryInspector } from "../../web/src/observe/trajectory/TrajectoryInspector.js";
import {
	trajectoryDetailEventSelection,
	trajectoryDetailSelectionKey,
} from "../../web/src/observe/ObserveView.js";
import {
	nextTrajectoryLedgerRecordId,
	trajectoryLedgerTailKey,
	TrajectoryLedger,
} from "../../web/src/observe/trajectory/TrajectoryLedger.js";
import { TrajectoryTimeline } from "../../web/src/observe/trajectory/TrajectoryTimeline.js";
import { TrajectoryToolbar } from "../../web/src/observe/trajectory/TrajectoryToolbar.js";
import type {
	GapTrajectoryRecord,
	TelemetryTrajectoryRecord,
	TrajectoryRecord,
	TrajectoryTurn,
} from "../../web/src/observe/trajectory/record.js";
import type { TelemetryEvent } from "../../web/src/observe/telemetry-types.js";

const SOURCE = {
	robot_id: "robot-01",
	host_id: "host-01",
	component: "pi",
} as const;

function record(
	id: string,
	sequence: number,
	overrides: Partial<TelemetryTrajectoryRecord> = {},
): TelemetryTrajectoryRecord {
	return {
		id,
		index: sequence,
		kind: "ASSISTANT",
		sequence,
		summary: id,
		durationMs: null,
		isOpen: false,
		isError: false,
		sourceEventIds: [`event:${id}`],
		sourceSequences: [sequence],
		eventKind: "provider.response",
		severity: "info",
		source: SOURCE,
		attributes: {},
		attemptOrdinalKnown: false,
		closureUnknown: false,
		gapTainted: false,
		gapEvidence: [],
		identityReuse: false,
		terminalConflict: false,
		unmatchedTerminal: false,
		diagnostic: false,
		sourceEnvelopes: [],
		privacyIncomplete: false,
		payloadRefs: [],
		...overrides,
	};
}

function gap(): GapTrajectoryRecord {
	return {
		id: "gap:2:3:2",
		index: 2,
		kind: "GAP",
		sequence: 2,
		summary: "Telemetry gap before sequence 3",
		durationMs: null,
		isOpen: false,
		isError: false,
		sourceEventIds: [],
		sourceSequences: [],
		gap: { requested: 2, earliest_available: 3, resume_after: 2 },
	};
}

function sourceEnvelope(
	eventId: string,
	sequence: number,
	phase: TelemetryEvent["phase"],
): TelemetryEvent {
	return {
		schema_version: 1,
		event_id: eventId,
		sequence,
		observed_at: new Date(sequence * 1_000).toISOString(),
		monotonic_ns: sequence,
		kind: "tool.execution",
		severity: "info",
		source: SOURCE,
		attributes: {},
		phase,
	};
}

function turn(records: readonly TrajectoryRecord[]): TrajectoryTurn {
	return {
		id: "turn:stable",
		turnId: "turn-stable",
		firstSequence: 1,
		steps: [{ id: "step:stable", stepId: "step:stable", firstSequence: 1, records }],
		records,
	};
}

describe("TrajectoryTimeline", () => {
	it("server-renders an accessible four-lane wall timeline from stable record IDs", () => {
		const records: readonly TrajectoryRecord[] = [
			record("model-closed", 1, {
				startedAt: new Date(1_000).toISOString(),
				durationMs: 1_000,
			}),
			gap(),
			record("tool-selected", 3, {
				kind: "TOOL",
				eventKind: "tool.execution",
				startedAt: new Date(4_000).toISOString(),
				durationMs: 500,
			}),
			record("service-unknown", 4, {
				kind: "SYSTEM",
				eventKind: "service.health",
				source: { ...SOURCE, component: "ua-runtime" },
				startedAt: new Date(5_000).toISOString(),
				closureUnknown: true,
			}),
			record("host-point", 5, {
				kind: "SYSTEM",
				eventKind: "host.sample",
				source: { ...SOURCE, component: "host-sampler" },
				startedAt: new Date(6_000).toISOString(),
			}),
			record("model-open", 6, {
				startedAt: new Date(6_500).toISOString(),
				isOpen: true,
			}),
		];
		const html = renderToStaticMarkup(createElement(TrajectoryTimeline, {
			turns: [turn(records)],
			selectedRecordId: "tool-selected",
			nowMs: 7_000,
		}));

		expect(html).toContain('aria-label="Trajectory timeline"');
		expect(html).toContain('data-mode="wall"');
		expect(html).toContain("Model / Agent");
		expect(html).toContain("Tools");
		expect(html).toContain("Services");
		expect(html).toContain("Host");
		expect(html).toContain('data-record-id="tool-selected"');
		expect(html).toContain('data-current="true"');
		expect(html).toContain('data-open="true"');
		expect(html).toContain("Live elapsed 500 ms");
		expect(html).toContain('data-closure-unknown="true"');
		expect(html).toContain('data-gap-id="gap:2:3:2"');
		expect(html).toMatch(/<button[^>]+data-gap-id="gap:2:3:2"/);
		expect(html).toContain("—");
	});

	it("bounds dense interactive spans and exposes one roving tab stop", () => {
		const records = Array.from({ length: 2_000 }, (_, index) =>
			record(`dense-component-${index}`, index + 1, {
				kind: index === 500 ? "ERROR" : index % 2 === 0 ? "ASSISTANT" : "TOOL",
				eventKind: index % 2 === 0 ? "provider.response" : "tool.execution",
				isError: index === 500,
			}));
		const html = renderToStaticMarkup(createElement(TrajectoryTimeline, {
			turns: [turn(records)],
			mode: "sequence",
			selectedRecordId: "dense-component-1999",
		}));

		const renderNodes = (html.match(/data-timeline-item-id=/g) ?? []).length +
			(html.match(/class="observe-trajectory-timeline__turn-boundary"/g) ?? []).length;
		expect(renderNodes).toBeLessThanOrEqual(512);
		expect((html.match(/tabindex="0"/g) ?? [])).toHaveLength(2);
		expect(html).toContain('data-record-id="dense-component-1999"');
		expect(html).toContain("data-aggregate-count");
		expect(html).toContain("Contains error");
	});
});

describe("TrajectoryInspector", () => {
	it("changes detail selection generation only when stable row source event ids change", () => {
		const open = record("stable-attempt", 6, {
			sourceEventIds: ["start-event"],
		});
		const unrelatedProjection = { ...open, summary: "unrelated live projection rebuild" };
		const closed = {
			...open,
			sourceEventIds: ["start-event", "end-event"],
		};

		expect(trajectoryDetailSelectionKey(unrelatedProjection)).toBe(
			trajectoryDetailSelectionKey(open),
		);
		expect(trajectoryDetailSelectionKey(closed)).not.toBe(
			trajectoryDetailSelectionKey(open),
		);
		expect(trajectoryDetailSelectionKey(open, 1)).not.toBe(
			trajectoryDetailSelectionKey(open, 0),
		);
	});

	it("bounds exact selection while retaining start and terminal envelopes", () => {
		const envelopes = [
			sourceEnvelope("observation-1", 1, "observation"),
			sourceEnvelope("start-1", 2, "start"),
			sourceEnvelope("middle-1", 3, "observation"),
			sourceEnvelope("middle-2", 4, "observation"),
			sourceEnvelope("end-1", 5, "end"),
			sourceEnvelope("observation-2", 6, "observation"),
		];
		const selected = record("dense-attempt", 6, {
			sourceEventIds: envelopes.map((event) => event.event_id),
			sourceEnvelopes: envelopes,
		});

		const selection = trajectoryDetailEventSelection(selected);

		expect(selection.eventIds).toHaveLength(4);
		expect(selection.eventIds).toContain("start-1");
		expect(selection.eventIds).toContain("end-1");
		expect(selection.omittedCount).toBe(2);
	});

	it("renders full exact tool evidence and tokens while keeping raw detail collapsed", () => {
		const fullArguments = `--fixture=${"x".repeat(70 * 1024)}-arguments-tail`;
		const fullResult = `result-${"y".repeat(70 * 1024)}-result-tail`;
		const selected = record("exact-tool-detail", 7, {
			kind: "TOOL",
			eventKind: "tool.execution",
			inputDetail: fullArguments,
			outputDetail: fullResult,
			attributes: {
				input_tokens: 1_001,
				output_tokens: 2_002,
				cache_write_1h_tokens: 3_003,
				reasoning_tokens: 4_004,
				authorization: "[REDACTED]",
			},
			payloadRefs: ["payloads/sha256/inert-exact-detail"],
			redaction: { applied: true, fields: ["attributes.authorization"] },
		});
		const html = renderToStaticMarkup(createElement(TrajectoryInspector, {
			record: selected,
			detailStatus: "exact",
		}));

		expect(html).toContain("Exact event detail loaded");
		expect(html).toContain("arguments-tail");
		expect(html).toContain("result-tail");
		expect(html).toContain("1,001");
		expect(html).toContain("2,002");
		expect(html).toContain("Cache write 1h");
		expect(html).toContain("3,003");
		expect(html).toContain("Reasoning");
		expect(html).toContain("4,004");
		expect(html).toContain("[REDACTED]");
		expect(html).not.toContain("Bearer ");
		expect(html).toContain("payloads/sha256/inert-exact-detail");
		expect(html).not.toContain("href=");
		expect(html).toContain("<details");
		expect(html).not.toContain("<details open");
	});

	it("states when exact detail is loading while retaining bounded projection evidence", () => {
		const html = renderToStaticMarkup(createElement(TrajectoryInspector, {
			record: record("loading-detail", 8, { inputDetail: "bounded input fallback" }),
			detailStatus: "loading",
		}));

		expect(html).toContain("Loading exact event detail");
		expect(html).toContain("bounded input fallback");
	});

	it("states partial exact detail and names fallback envelope count", () => {
		const html = renderToStaticMarkup(createElement(TrajectoryInspector, {
			record: record("partial-detail", 9, { outputDetail: "exact available output" }),
			detailStatus: "partial",
			detailMissingCount: 1,
		}));

		expect(html).toContain("1 event unavailable");
		expect(html).toContain("bounded projection for missing evidence");
		expect(html).toContain("exact available output");
	});

	it("states exact detail failure while retaining bounded projection evidence", () => {
		const html = renderToStaticMarkup(createElement(TrajectoryInspector, {
			record: record("failed-detail", 10, { result: "bounded result fallback" }),
			detailStatus: "error",
		}));

		expect(html).toContain("Exact event detail unavailable");
		expect(html).toContain("Showing bounded projection");
		expect(html).toContain("bounded result fallback");
	});

	it("shows only available evidence in named sections and leaves raw details collapsed", () => {
		const selected = record("selected-detail", 8, {
			summary: "bash completed",
			kind: "TOOL",
			eventKind: "tool.execution",
			toolName: "bash",
			inputDetail: "npm test",
			outputDetail: "8 passed",
			thinkingDetail: "provider-visible rationale",
			schemaDetail: "{ command: string }",
			startedAt: new Date(1_000).toISOString(),
			endedAt: new Date(1_250).toISOString(),
			durationMs: 250,
			correlation: {
				trace_id: "trace-8",
				turn_id: "turn-8",
				tool_call_id: "call-8",
			},
			attributes: {
				input_tokens: 12,
				output_tokens: 8,
				cache_read_tokens: 4,
			},
			privacyClass: "operator",
			payloadRefs: ["payloads/sha256/detail"],
			redaction: { applied: true, fields: ["headers.authorization"] },
		});
		const html = renderToStaticMarkup(createElement(TrajectoryInspector, {
			record: selected,
			drawerOpen: true,
		}));

		for (const heading of [
			"Summary",
			"Input",
			"Output",
			"Thinking",
			"Tool schema",
			"Timing",
			"Tokens",
			"Correlation",
			"Source",
			"Redaction",
		]) {
			expect(html).toContain(`>${heading}<`);
		}
		expect(html).toContain('aria-label="Trajectory record details"');
		expect(html).toContain('data-open="true"');
		expect(html).toContain("payloads/sha256/detail");
		expect(html).not.toContain("href=");
		expect(html).toContain("Raw details");
		expect(html).toContain("<details");
		expect(html).not.toContain("<details open");
	});

	it("omits unavailable detail sections while stating unknown timing", () => {
		const html = renderToStaticMarkup(createElement(TrajectoryInspector, {
			record: record("sparse", 9),
		}));

		for (const absent of ["Input", "Output", "Thinking", "Tool schema", "Tokens", "Correlation", "Redaction"]) {
			expect(html).not.toContain(`>${absent}<`);
		}
		expect(html).toContain(">Timing<");
		expect(html).toContain("—");
	});

	it("uses recorded result evidence when no separate output detail exists", () => {
		const html = renderToStaticMarkup(createElement(TrajectoryInspector, {
			record: record("result-only", 10, { result: "Result evidence" }),
		}));

		expect(html).toContain(">Output<");
		expect(html).toContain("Result evidence");
	});

	it("labels live elapsed separately from unknown recorded duration", () => {
		const open = record("open-detail", 11, {
			isOpen: true,
			startedAt: new Date(1_000).toISOString(),
			durationMs: null,
		});
		const html = renderToStaticMarkup(createElement(TrajectoryInspector, {
			record: open,
			nowMs: 1_500,
		}));

		expect(html).toContain("Live elapsed");
		expect(html).toContain("500 ms");
		expect(html).toContain("<dt>Duration</dt><dd>—</dd>");
	});

	it("exposes mobile drawer as a modal dialog with focus entry and close control", () => {
		const html = renderToStaticMarkup(createElement(TrajectoryInspector, {
			record: record("mobile-detail", 12),
			drawerMode: true,
			drawerOpen: true,
			onClose: () => {},
		}));

		expect(html).toContain('role="dialog"');
		expect(html).toContain('aria-modal="true"');
		expect(html).toContain('data-drawer="true"');
		expect(html).toContain('data-focus-entry="true"');
		expect(html).toContain('aria-label="Close record details"');
	});
});

describe("TrajectoryToolbar", () => {
	it("renders read-only mode, fold, search, filter, and live controls", () => {
		const html = renderToStaticMarkup(createElement(TrajectoryToolbar, {
			mode: "wall",
			foldTurns: true,
			foldCalls: false,
			searchQuery: "bash",
			filters: {
				kind: "TOOL",
				source: "pi",
				errorsOnly: true,
				activeOnly: false,
				stalledOnly: false,
				traceId: "trace-8",
			},
			sourceOptions: ["pi", "ua-runtime"],
			isFollowingLive: false,
		}));

		expect(html).toContain('role="toolbar"');
		expect(html).toContain('aria-label="Trajectory toolbar"');
		expect(html).toContain('aria-label="Time mode"');
		expect(html).toContain("Wall clock");
		expect(html).toContain("Idle compressed");
		expect(html).toContain("Sequence");
		expect(html).toContain("Fold Turns");
		expect(html).toContain("Fold calls");
		expect(html).toContain('aria-label="Search trajectory"');
		expect(html).toContain('aria-label="Kind filter"');
		expect(html).toContain('aria-label="Source filter"');
		expect(html).toContain("Errors only");
		expect(html).toContain("Active only");
		expect(html).toContain("Possibly stalled");
		expect(html).toContain('aria-label="Trace ID filter"');
		expect(html).toContain("Jump to live");
		expect(html).not.toMatch(/repair|restart|abort/i);
	});
});

describe("TrajectoryLedger", () => {
	it("server-renders a virtualized accessible ledger with stable record selection", () => {
		const records = [
			record("request-row", 1, { kind: "REQUEST", summary: "Run tests" }),
			record("tool-row", 2, {
				kind: "TOOL",
				eventKind: "tool.execution",
				toolName: "bash",
				summary: "bash completed",
				durationMs: 250,
				state: "completed",
				attributes: { input_tokens: 12, output_tokens: 8 },
			}),
		];
		const html = renderToStaticMarkup(createElement(TrajectoryLedger, {
			turns: [turn(records)],
			selectedRecordId: "tool-row",
			searchMatchRecordIds: new Set(["tool-row"]),
			isFollowingLive: false,
		}));

		expect(html).toContain('role="grid"');
		expect(html).toContain('aria-label="Trajectory ledger"');
		expect(html).toContain('data-virtualized="true"');
		expect(html).toContain('aria-rowcount="3"');
		expect(html).toContain('aria-rowindex="1"');
		expect(html).toContain('aria-rowindex="2"');
		expect(html).toContain('aria-rowindex="3"');
		for (const heading of ["Index", "Kind", "Summary", "Tokens", "Duration", "State"]) {
			expect(html).toContain(`>${heading}<`);
		}
		expect(html).toContain("Turn turn-stable");
		expect(html).toContain("Step step:stable");
		expect(html).toContain('data-record-id="tool-row"');
		expect(html).toContain('aria-selected="true"');
		expect(html).toContain("250 ms");
	});

	it("folds a Turn into one summary without changing record identity", () => {
		const records = [record("first-stable", 1), record("second-stable", 2)];
		const html = renderToStaticMarkup(createElement(TrajectoryLedger, {
			turns: [turn(records)],
			selectedRecordId: "second-stable",
			foldTurns: true,
			isFollowingLive: false,
		}));

		expect(html).toContain("2 records");
		expect(html).toContain('data-record-id="second-stable"');
		expect(html).toContain('aria-activedescendant="observe-trajectory-row-second-stable"');
		expect(html).toContain('id="observe-trajectory-row-second-stable"');
		expect((html.match(/data-record-id=/g) ?? [])).toHaveLength(1);
	});

	it("retains each Step header across adjacent virtual rows", () => {
		const request = record("request-step-a", 1, { kind: "REQUEST" });
		const tool = record("tool-step-b", 2, { kind: "TOOL", eventKind: "tool.execution" });
		const multiStepTurn: TrajectoryTurn = {
			id: "turn:multi",
			turnId: "turn-multi",
			firstSequence: 1,
			steps: [
				{ id: "step:a", stepId: "step:a", firstSequence: 1, records: [request] },
				{ id: "step:b", stepId: "step:b", firstSequence: 2, records: [tool] },
			],
			records: [request, tool],
		};
		const html = renderToStaticMarkup(createElement(TrajectoryLedger, {
			turns: [multiStepTurn],
			isFollowingLive: false,
		}));

		expect(html).toContain("Step step:a");
		expect(html).toContain("Step step:b");
	});

	it("starts keyboard movement at visible edges when active selection is stale", () => {
		const records = [record("first-visible", 1), record("last-visible", 2)];

		expect(nextTrajectoryLedgerRecordId(records, "filtered-out", 1)).toBe("first-visible");
		expect(nextTrajectoryLedgerRecordId(records, "filtered-out", -1)).toBe("last-visible");
		expect(nextTrajectoryLedgerRecordId(records, "first-visible", 1)).toBe("last-visible");
	});

	it("does not reference a virtual row outside rendered DOM", () => {
		const records = Array.from({ length: 100 }, (_, index) =>
			record(`virtual-${index}`, index + 1));
		const html = renderToStaticMarkup(createElement(TrajectoryLedger, {
			turns: [turn(records)],
			selectedRecordId: "virtual-99",
			isFollowingLive: false,
		}));

		expect(html).not.toContain('aria-activedescendant="observe-trajectory-row-virtual-99"');
	});

	it("changes live-tail key when stable record ID gains terminal evidence", () => {
		const open = record("stable-tail", 1, {
			isOpen: true,
			state: "running",
			sourceEventIds: ["event:start"],
		});
		const closed = record("stable-tail", 1, {
			isOpen: false,
			state: "completed",
			durationMs: 50,
			sourceEventIds: ["event:start", "event:end"],
		});

		expect(trajectoryLedgerTailKey([open])).not.toBe(trajectoryLedgerTailKey([closed]));
	});

	it("shows live elapsed on an open ledger row without replacing duration", () => {
		const open = record("open-ledger", 1, {
			isOpen: true,
			startedAt: new Date(1_000).toISOString(),
			durationMs: null,
		});
		const html = renderToStaticMarkup(createElement(TrajectoryLedger, {
			turns: [turn([open])],
			isFollowingLive: false,
			nowMs: 1_500,
		}));

		expect(html).toContain("Open · elapsed 500 ms");
		expect(html).toContain(">—<");
	});

	it("uses bounded semantic labels instead of internal unscoped map keys", () => {
		const only = record("unscoped-record", 1);
		const unscoped: TrajectoryTurn = {
			id: "robot-secret\u0000session-secret\u0000unscoped",
			firstSequence: 1,
			steps: [{
				id: "robot-secret\u0000session-secret\u0000unscoped-step",
				firstSequence: 1,
				records: [only],
			}],
			records: [only],
		};
		const html = renderToStaticMarkup(createElement(TrajectoryLedger, {
			turns: [unscoped],
			isFollowingLive: false,
		}));

		expect(html).toContain("Unscoped turn");
		expect(html).toContain("Unscoped step");
		expect(html).not.toContain("robot-secret");
	});
});
