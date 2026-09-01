/**
 * Timeline projection tests adapted from DeepSeek Harness:
 * packages/client/ui-trajectory/tests/views.client.spec.tsx
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { describe, expect, it } from "vitest";
import type {
	GapTrajectoryRecord,
	TelemetryTrajectoryRecord,
	TrajectoryRecord,
	TrajectoryRecordKind,
	TrajectoryTurn,
} from "../../web/src/observe/trajectory/record.js";
import {
	aggregateTrajectoryTimelineSpans,
	boundTrajectoryTimelineForRender,
	deriveTrajectoryTimeline,
	timelineLaneForRecord,
	trajectoryHasOpenRecords,
	trajectoryTimelineFocusRecordIds,
} from "../../web/src/observe/trajectory/timeline.js";

const SOURCE = {
	robot_id: "robot-01",
	host_id: "host-01",
	component: "pi",
} as const;

function record(
	id: string,
	overrides: Partial<TelemetryTrajectoryRecord> = {},
): TelemetryTrajectoryRecord {
	const sequence = overrides.sequence ?? (Number(id.replace(/\D/g, "")) || 1);
	const startedAt = overrides.startedAt;
	const observedAt = startedAt ?? overrides.endedAt ?? "2026-08-31T00:00:00.000Z";
	const kind = overrides.kind ?? "ASSISTANT";
	const eventKind = overrides.eventKind ?? "provider.response";
	return {
		id,
		index: overrides.index ?? sequence,
		kind,
		sequence,
		summary: overrides.summary ?? id,
		durationMs: overrides.durationMs ?? null,
		isOpen: overrides.isOpen ?? false,
		isError: overrides.isError ?? kind === "ERROR",
		sourceEventIds: overrides.sourceEventIds ?? [`event:${id}`],
		sourceSequences: overrides.sourceSequences ?? [sequence],
		eventKind,
		severity: overrides.severity ?? (kind === "ERROR" ? "error" : "info"),
		source: overrides.source ?? SOURCE,
		attributes: overrides.attributes ?? {},
		attemptOrdinalKnown: overrides.attemptOrdinalKnown ?? false,
		closureUnknown: overrides.closureUnknown ?? false,
		gapTainted: overrides.gapTainted ?? false,
		gapEvidence: overrides.gapEvidence ?? [],
		identityReuse: overrides.identityReuse ?? false,
		terminalConflict: overrides.terminalConflict ?? false,
		unmatchedTerminal: overrides.unmatchedTerminal ?? false,
		diagnostic: overrides.diagnostic ?? false,
		sourceEnvelopes: overrides.sourceEnvelopes ?? [{
			schema_version: 1,
			event_id: `event:${id}`,
			sequence,
			observed_at: observedAt,
			monotonic_ns: sequence,
			kind: eventKind,
			severity: overrides.severity ?? "info",
			source: overrides.source ?? SOURCE,
			attributes: overrides.attributes ?? {},
		}],
		privacyIncomplete: overrides.privacyIncomplete ?? false,
		payloadRefs: overrides.payloadRefs ?? [],
		...overrides,
	};
}

function gap(id = "gap:2:3:2", sequence = 2): GapTrajectoryRecord {
	return {
		id,
		index: sequence,
		kind: "GAP",
		sequence,
		summary: "Telemetry gap before sequence 3",
		durationMs: null,
		isOpen: false,
		isError: false,
		sourceEventIds: [],
		sourceSequences: [],
		gap: { requested: sequence, earliest_available: sequence + 1, resume_after: sequence },
	};
}

function turn(records: readonly TrajectoryRecord[]): TrajectoryTurn {
	return {
		id: "turn:1",
		turnId: "turn-1",
		traceId: "trace-1",
		firstSequence: Math.min(...records.map((candidate) => candidate.sequence)),
		steps: [{
			id: "step:1",
			stepId: "step-1",
			firstSequence: Math.min(...records.map((candidate) => candidate.sequence)),
			records,
		}],
		records,
	};
}

function at(milliseconds: number): string {
	return new Date(milliseconds).toISOString();
}

describe("trajectory timeline projection", () => {
	it("detects only evidence-confirmed open records for live display ticking", () => {
		expect(trajectoryHasOpenRecords([turn([
			record("unknown-1", { closureUnknown: true, isOpen: false }),
			record("closed-2", { isOpen: false }),
		])])).toBe(false);
		expect(trajectoryHasOpenRecords([turn([
			record("open-3", { isOpen: true, closureUnknown: false }),
		])])).toBe(true);
	});

	it("maps records into model, tools, services, and host lanes", () => {
		const cases: Array<[Exclude<TrajectoryRecordKind, "GAP">, string, string, string]> = [
			["ASSISTANT", "provider.response", "pi", "model"],
			["TOOL", "tool.execution", "pi", "tools"],
			["SYSTEM", "service.health", "ua-runtime", "services"],
			["SYSTEM", "host.sample", "host-sampler", "host"],
		];

		for (const [kind, eventKind, component, lane] of cases) {
			expect(timelineLaneForRecord(record(`${lane}-1`, {
				kind,
				eventKind,
				source: { ...SOURCE, component },
			}))).toBe(lane);
		}
	});

	it("uses recorded wall clock by default without renumbering records", () => {
		const first = record("first-1", {
			index: 40,
			sequence: 10,
			startedAt: at(1_000),
			durationMs: 500,
		});
		const second = record("second-2", {
			index: 2,
			sequence: 20,
			startedAt: at(2_500),
			endedAt: at(3_000),
			durationMs: 500,
		});

		expect(deriveTrajectoryTimeline([turn([first, second])])).toMatchObject({
			mode: "wall",
			start: 1_000,
			end: 3_000,
			spans: [
				{ recordId: "first-1", start: 1_000, end: 1_500 },
				{ recordId: "second-2", start: 2_500, end: 3_000 },
			],
		});
	});

	it("compresses idle wall-clock gaps while preserving recorded durations", () => {
		const first = record("first-1", { startedAt: at(1_000), durationMs: 500 });
		const second = record("second-2", { startedAt: at(5_000), durationMs: 500 });

		expect(deriveTrajectoryTimeline([turn([first, second])], "compressed")).toMatchObject({
			mode: "compressed",
			start: 1_000,
			end: 2_000,
			spans: [
				{ recordId: "first-1", start: 1_000, end: 1_500 },
				{ recordId: "second-2", start: 1_500, end: 2_000 },
			],
		});
	});

	it("projects every record in stable source order for sequence fallback", () => {
		const first = record("first-1", { sequence: 20, startedAt: undefined });
		const second = record("second-2", { sequence: 10, startedAt: undefined });

		expect(deriveTrajectoryTimeline([turn([first, second])], "sequence")).toMatchObject({
			mode: "sequence",
			start: 0,
			end: 2,
			spans: [
				{ recordId: "second-2", start: 0, end: 1 },
				{ recordId: "first-1", start: 1, end: 2 },
			],
		});
	});

	it("keeps missing, open, and closure-unknown timing states distinct", () => {
		const missing = record("missing-1", {
			startedAt: undefined,
			endedAt: undefined,
			sourceEnvelopes: [],
			durationMs: null,
		});
		const point = record("point-2", { startedAt: at(1_000), durationMs: null });
		const open = record("open-3", {
			startedAt: at(2_000),
			durationMs: null,
			isOpen: true,
		});
		const closureUnknown = record("unknown-4", {
			startedAt: at(3_000),
			durationMs: null,
			isOpen: false,
			closureUnknown: true,
		});
		const model = deriveTrajectoryTimeline(
			[turn([missing, point, open, closureUnknown])],
			"wall",
			{ nowMs: 5_000 },
		);

		expect(model?.unknownTimingRecordIds).toEqual(["missing-1"]);
		expect(model?.spans).toMatchObject([
			{ recordId: "point-2", start: 1_000, end: 1_000, durationMs: null },
			{
				recordId: "open-3",
				start: 2_000,
				end: 5_000,
				liveElapsedMs: 3_000,
				isOpen: true,
				closureUnknown: false,
			},
			{
				recordId: "unknown-4",
				start: 3_000,
				end: 3_000,
				liveElapsedMs: null,
				isOpen: false,
				closureUnknown: true,
			},
		]);
	});

	it("does not synthesize wall timing after a recorded temporal-order conflict", () => {
		const conflict = record("conflict-1", {
			startedAt: undefined,
			endedAt: undefined,
			durationMs: 250,
			temporalOrderConflict: true,
			sourceEnvelopes: [{
				schema_version: 1,
				event_id: "event:conflict-1",
				sequence: 1,
				observed_at: at(4_000),
				monotonic_ns: 1,
				kind: "tool.execution",
				severity: "warning",
				source: SOURCE,
				attributes: {},
			}],
		});
		const anchor = record("anchor-2", { startedAt: at(5_000), durationMs: 1 });
		const model = deriveTrajectoryTimeline([turn([conflict, anchor])], "wall");

		expect(model?.unknownTimingRecordIds).toContain("conflict-1");
		expect(model?.spans.map((span) => span.recordId)).toEqual(["anchor-2"]);
	});

	it("renders fixture-shaped stall duration as an observation point, not future time", () => {
		const stall = record("stall-observation", {
			kind: "STALL",
			eventKind: "agent.stall",
			phase: "observation",
			state: "possibly_stalled",
			durationMs: 180_000,
			startedAt: undefined,
			endedAt: undefined,
			sourceEnvelopes: [{
				schema_version: 1,
				event_id: "event:stall-observation",
				sequence: 1,
				observed_at: at(180_000),
				monotonic_ns: 180_000,
				kind: "agent.stall",
				phase: "observation",
				state: "possibly_stalled",
				severity: "warning",
				source: SOURCE,
				duration_ms: 180_000,
				attributes: { silence_ms: 180_000, threshold_ms: 180_000 },
			}],
		});

		expect(deriveTrajectoryTimeline([turn([stall])], "wall")?.spans[0]).toMatchObject({
			recordId: "stall-observation",
			start: 180_000,
			end: 180_000,
			durationMs: 180_000,
			isStalled: true,
		});
	});

	it("selects intersecting records by stable record ID, not display index", () => {
		const first = record("stable-A", {
			index: 99,
			startedAt: at(1_000),
			durationMs: 400,
		});
		const second = record("stable-B", {
			index: 1,
			startedAt: at(2_000),
			durationMs: 400,
		});

		expect(trajectoryTimelineFocusRecordIds(
			[turn([first, second])],
			{ start: 2_100, end: 2_200 },
			"wall",
		)).toEqual(new Set(["stable-B"]));
	});

	it("renders replay gaps as bounded bands only when evidence supplies both wall bounds", () => {
		const before = record("before-1", {
			sequence: 1,
			startedAt: at(1_000),
			endedAt: at(2_000),
			durationMs: 1_000,
		});
		const replayGap = gap();
		const after = record("after-3", {
			sequence: 3,
			startedAt: at(4_000),
			durationMs: 500,
		});

		expect(deriveTrajectoryTimeline([turn([before, replayGap, after])], "wall")?.gapBands)
			.toEqual([{
				recordId: replayGap.id,
				start: 2_000,
				end: 4_000,
				label: replayGap.summary,
			}]);
		const leadingGap = deriveTrajectoryTimeline([turn([replayGap, after])], "wall");
		expect(leadingGap?.gapBands).toEqual([]);
		expect(leadingGap?.unknownTimingRecordIds).toContain(replayGap.id);
		expect(trajectoryTimelineFocusRecordIds(
			[turn([before, replayGap, after])],
			{ start: 2_500, end: 3_500 },
			"wall",
		)).toEqual(new Set([replayGap.id]));
	});

	it("marks error, cancellation, and stall evidence without treating them as one state", () => {
		const error = record("error-1", {
			kind: "ERROR",
			isError: true,
			startedAt: at(1_000),
			durationMs: 10,
		});
		const cancelled = record("cancelled-2", {
			kind: "CANCELLED",
			startedAt: at(2_000),
			durationMs: 10,
		});
		const stalled = record("stall-3", {
			kind: "STALL",
			startedAt: at(3_000),
			durationMs: 10,
		});
		const spans = deriveTrajectoryTimeline([turn([error, cancelled, stalled])], "wall")?.spans;

		expect(spans).toMatchObject([
			{ recordId: "error-1", isError: true, isCancelled: false, isStalled: false },
			{ recordId: "cancelled-2", isError: false, isCancelled: true, isStalled: false },
			{ recordId: "stall-3", isError: false, isCancelled: false, isStalled: true },
		]);
	});

	it("aggregates 10,000 dense spans while preserving selected record identity", () => {
		const records = Array.from({ length: 10_000 }, (_, index) => record(`dense-${index}`, {
			sequence: index + 1,
			index: index + 1,
			kind: index % 2 === 0 ? "ASSISTANT" : "TOOL",
			eventKind: index % 2 === 0 ? "provider.response" : "tool.execution",
			isError: index === 500,
		}));
		const model = deriveTrajectoryTimeline([turn(records)], "sequence");
		const selectedId = "dense-9999";
		const preserveRecordIds = new Set([
			selectedId,
			...records.slice(0, 200).map((candidate) => candidate.id),
		]);
		const rendered = aggregateTrajectoryTimelineSpans(model?.spans ?? [], {
			maxItems: 128,
			preserveRecordIds,
		});

		expect(rendered.length).toBeLessThanOrEqual(128);
		expect(rendered.find((item) => item.recordIds.includes(selectedId))).toMatchObject({
			count: 1,
			recordIds: [selectedId],
		});
		expect(rendered.some((item) => item.count > 1)).toBe(true);
		expect(rendered.some((item) => item.isError)).toBe(true);
	});

	it("reserves primary selection ahead of over-cap open-span preservation", () => {
		const records = Array.from({ length: 600 }, (_, index) => record(`open-dense-${index}`, {
			sequence: index + 1,
			index: index + 1,
			isOpen: true,
		}));
		const spans = deriveTrajectoryTimeline([turn(records)], "sequence")?.spans ?? [];
		const selectedId = "open-dense-599";
		const rendered = aggregateTrajectoryTimelineSpans(spans, {
			maxItems: 512,
			primaryRecordId: selectedId,
			preserveRecordIds: new Set(records.map((candidate) => candidate.id)),
		});

		expect(rendered.find((item) => item.recordIds.includes(selectedId))).toMatchObject({
			count: 1,
			recordIds: [selectedId],
		});
	});

	it("bounds spans, gap bands, and Turn boundaries under one render budget", () => {
		const turns = Array.from({ length: 10_000 }, (_, index): TrajectoryTurn => {
			const replayGap = gap(`gap:${index}`, index + 1);
			return {
				id: `turn:gap:${index}`,
				firstSequence: index + 1,
				steps: [{ id: `step:gap:${index}`, firstSequence: index + 1, records: [replayGap] }],
				records: [replayGap],
			};
		});
		const model = deriveTrajectoryTimeline(turns, "sequence");
		const selectedId = "gap:9999";
		const bounded = boundTrajectoryTimelineForRender(model, {
			maxItems: 512,
			primaryRecordId: selectedId,
		});

		expect(
			bounded.spans.length + bounded.gapBands.length + bounded.turnBoundaries.length,
		).toBeLessThanOrEqual(512);
		expect(bounded.gapBands.find((item) => item.recordIds.includes(selectedId))).toMatchObject({
			count: 1,
			recordIds: [selectedId],
		});
		expect(bounded.gapBands.some((item) => item.count > 1)).toBe(true);
	});

	it("reserves selected and aggregate gap slots inside a mixed render budget", () => {
		const firstGap = gap("gap:first", 1);
		const secondGap = gap("gap:selected", 2);
		const records: TrajectoryRecord[] = [firstGap, secondGap];
		for (let index = 0; index < 100; index += 1) {
			records.push(record(`mixed-${index}`, { sequence: index + 3, index: index + 3 }));
		}
		const model = deriveTrajectoryTimeline([turn(records)], "sequence");
		const bounded = boundTrajectoryTimelineForRender(model, {
			maxItems: 8,
			primaryRecordId: secondGap.id,
		});

		expect(
			bounded.spans.length + bounded.gapBands.length + bounded.turnBoundaries.length,
		).toBeLessThanOrEqual(8);
		expect(bounded.gapBands.find((item) => item.recordIds.includes(secondGap.id))?.count).toBe(1);
		expect(bounded.gapBands).toHaveLength(2);
	});

	it("keeps selected span singleton when gaps dominate category budget", () => {
		const spans = Array.from({ length: 5 }, (_, index) => record(`skew-span-${index}`, {
			sequence: index + 1,
			index: index + 1,
		}));
		const gaps = Array.from({ length: 10_000 }, (_, index) =>
			gap(`skew-gap-${index}`, index + 6));
		const model = deriveTrajectoryTimeline([turn([...spans, ...gaps])], "sequence");
		const selectedId = "skew-span-4";
		const bounded = boundTrajectoryTimelineForRender(model, {
			maxItems: 512,
			primaryRecordId: selectedId,
		});

		expect(bounded.spans.find((item) => item.recordIds.includes(selectedId))).toMatchObject({
			count: 1,
			recordIds: [selectedId],
		});
	});

	it("never exceeds total cap with preserved opens, selected gap, and dense boundaries", () => {
		const openRecords = Array.from({ length: 10_000 }, (_, index) => record(`preserved-${index}`, {
			sequence: index + 1,
			index: index + 1,
			isOpen: true,
		}));
		const base = deriveTrajectoryTimeline([turn(openRecords)], "sequence");
		expect(base).not.toBeNull();
		const selectedGap = "selected-gap";
		const denseModel = {
			...(base as NonNullable<typeof base>),
			gapBands: [
				{ recordId: "other-gap", label: "Other gap", start: 2, end: 3 },
				{ recordId: selectedGap, label: "Selected gap", start: 4, end: 5 },
			],
			turnBoundaries: Array.from({ length: 10_000 }, (_, index) => ({
				turnId: `dense-turn-${index}`,
				time: index,
			})),
		};
		const bounded = boundTrajectoryTimelineForRender(denseModel, {
			maxItems: 512,
			primaryRecordId: selectedGap,
			preserveRecordIds: new Set(openRecords.map((candidate) => candidate.id)),
		});

		expect(
			bounded.spans.length + bounded.gapBands.length + bounded.turnBoundaries.length,
		).toBeLessThanOrEqual(512);
		expect(bounded.gapBands.find((item) => item.recordIds.includes(selectedGap))?.count).toBe(1);
	});
});
