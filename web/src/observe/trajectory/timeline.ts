/**
 * Substantially adapted from DeepSeek Harness:
 * packages/client/ui-trajectory/src/client/timeline.ts
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import type {
	TelemetryTrajectoryRecord,
	TrajectoryRecord,
	TrajectoryTurn,
} from "./record.js";

/** Horizontal projection used by the trajectory timeline. Wall clock is default. */
export type TrajectoryTimelineMode = "wall" | "compressed" | "sequence";

/** Semantic lanes keep model, tool, service, and host evidence separate. */
export type TrajectoryTimelineLane = "model" | "tools" | "services" | "host";

export const TRAJECTORY_TIMELINE_LANES: readonly TrajectoryTimelineLane[] = [
	"model",
	"tools",
	"services",
	"host",
];

/** Inclusive selection in the active timeline projection's domain. */
export interface TrajectoryTimeRange {
	readonly start: number;
	readonly end: number;
}

/** One ledger record projected into the active timeline domain. */
export interface TrajectoryTimelineSpan extends TrajectoryTimeRange {
	readonly recordId: string;
	readonly sequence: number;
	readonly kind: TrajectoryRecord["kind"];
	readonly label: string;
	readonly lane: TrajectoryTimelineLane;
	/** Recorded duration only. Open display age never overwrites this value. */
	readonly durationMs: number | null;
	/** Derived browser display age for an evidence-confirmed open timed span. */
	readonly liveElapsedMs: number | null;
	readonly isError: boolean;
	readonly isCancelled: boolean;
	readonly isStalled: boolean;
	readonly isOpen: boolean;
	readonly closureUnknown: boolean;
}

/** Explicit replay-loss interval projected only from known surrounding bounds. */
export interface TrajectoryTimelineGapBand extends TrajectoryTimeRange {
	readonly recordId: string;
	readonly label: string;
}

/** One Turn boundary in the active timeline domain. */
export interface TrajectoryTimelineTurnBoundary {
	readonly turnId: string;
	readonly time: number;
}

/** Full-domain model used by the overview. */
export interface TrajectoryTimelineModel extends TrajectoryTimeRange {
	readonly mode: TrajectoryTimelineMode;
	readonly spans: readonly TrajectoryTimelineSpan[];
	readonly gapBands: readonly TrajectoryTimelineGapBand[];
	readonly turnBoundaries: readonly TrajectoryTimelineTurnBoundary[];
	readonly unknownTimingRecordIds: readonly string[];
}

export interface TrajectoryTimelineOptions {
	/** Browser display time for open spans. Omit to keep open spans as points. */
	readonly nowMs?: number;
}

/** Bounded renderer item. Aggregates carry several stable record IDs. */
export interface TrajectoryTimelineRenderSpan extends TrajectoryTimeRange {
	readonly id: string;
	readonly recordIds: readonly string[];
	readonly count: number;
	readonly sequence: number;
	readonly kind: TrajectoryRecord["kind"];
	readonly label: string;
	readonly lane: TrajectoryTimelineLane;
	readonly durationMs: number | null;
	readonly liveElapsedMs: number | null;
	readonly isError: boolean;
	readonly isCancelled: boolean;
	readonly isStalled: boolean;
	readonly isOpen: boolean;
	readonly closureUnknown: boolean;
}

export interface TrajectoryTimelineAggregationOptions {
	readonly maxItems?: number;
	/** Highest-priority stable record that must remain a singleton. */
	readonly primaryRecordId?: string;
	readonly preserveRecordIds?: ReadonlySet<string>;
}

export interface TrajectoryTimelineRenderGap extends TrajectoryTimeRange {
	readonly id: string;
	readonly recordIds: readonly string[];
	readonly count: number;
	readonly label: string;
}

export interface BoundedTrajectoryTimelineRenderModel {
	readonly spans: readonly TrajectoryTimelineRenderSpan[];
	readonly gapBands: readonly TrajectoryTimelineRenderGap[];
	readonly turnBoundaries: readonly TrajectoryTimelineTurnBoundary[];
}

interface OrderedRecord {
	readonly record: TrajectoryRecord;
	readonly turnId: string;
}

interface TimedRecord extends OrderedRecord {
	readonly span: TrajectoryTimelineSpan;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function orderedRecords(turns: readonly TrajectoryTurn[]): readonly OrderedRecord[] {
	const records = new Map<string, OrderedRecord>();
	for (const turn of turns) {
		for (const record of turn.records) {
			if (!records.has(record.id)) records.set(record.id, { record, turnId: turn.id });
		}
	}
	return [...records.values()].sort((left, right) => {
		if (left.record.sequence !== right.record.sequence) {
			return left.record.sequence < right.record.sequence ? -1 : 1;
		}
		if (left.record.kind === "GAP" && right.record.kind !== "GAP") return 1;
		if (left.record.kind !== "GAP" && right.record.kind === "GAP") return -1;
		return compareText(left.record.id, right.record.id);
	});
}

function parseTimestamp(value: string | undefined): number | null {
	if (value === undefined) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

interface RecordedAnchor {
	readonly time: number;
	readonly canExtendForward: boolean;
}

function recordedAnchor(record: TelemetryTrajectoryRecord): RecordedAnchor | null {
	if (record.temporalOrderConflict === true) return null;
	const startedAt = parseTimestamp(record.startedAt);
	if (startedAt !== null) return { time: startedAt, canExtendForward: true };
	const endedAt = parseTimestamp(record.endedAt);
	if (endedAt !== null) return { time: endedAt, canExtendForward: false };
	for (const envelope of record.sourceEnvelopes) {
		if (envelope.phase !== "start") continue;
		const observed = parseTimestamp(envelope.observed_at);
		if (observed !== null) return { time: observed, canExtendForward: true };
	}
	for (const envelope of record.sourceEnvelopes) {
		const observed = parseTimestamp(envelope.observed_at);
		if (observed !== null) return { time: observed, canExtendForward: false };
	}
	return null;
}

function finiteNonNegative(value: number | null | undefined): value is number {
	return value !== null && value !== undefined && Number.isFinite(value) && value >= 0;
}

/** Derive display-only age from explicit start evidence and caller-supplied now. */
export function trajectoryRecordLiveElapsedMs(
	record: TrajectoryRecord,
	nowMs: number | undefined,
): number | null {
	if (
		record.kind === "GAP" ||
		!record.isOpen ||
		record.closureUnknown ||
		!finiteNonNegative(nowMs)
	) {
		return null;
	}
	let start = parseTimestamp(record.startedAt);
	if (start === null) {
		for (const envelope of record.sourceEnvelopes) {
			if (envelope.phase !== "start") continue;
			start = parseTimestamp(envelope.observed_at);
			if (start !== null) break;
		}
	}
	return start === null ? null : Math.max(0, nowMs - start);
}

function recordedRange(
	record: TelemetryTrajectoryRecord,
	options: TrajectoryTimelineOptions,
): TrajectoryTimeRange | null {
	const anchor = recordedAnchor(record);
	if (anchor === null) return null;
	const start = anchor.time;
	if (!anchor.canExtendForward) return { start, end: start };
	if (
		record.isOpen &&
		!record.closureUnknown &&
		finiteNonNegative(options.nowMs)
	) {
		return { start, end: Math.max(start, options.nowMs) };
	}
	const endedAt = parseTimestamp(record.endedAt);
	if (endedAt !== null && endedAt >= start) return { start, end: endedAt };
	if (finiteNonNegative(record.durationMs)) {
		return { start, end: start + record.durationMs };
	}
	return { start, end: start };
}

/** Resolve one record into one of four operator-facing semantic lanes. */
export function timelineLaneForRecord(record: TrajectoryRecord): TrajectoryTimelineLane {
	if (record.kind === "GAP") return "model";
	const eventKind = record.eventKind.toLowerCase();
	const component = record.source.component.toLowerCase();
	if (
		record.kind === "TOOL" ||
		record.kind === "SUBTOOL" ||
		eventKind.startsWith("tool.")
	) {
		return "tools";
	}
	if (
		eventKind.startsWith("host.") ||
		eventKind.startsWith("hardware.") ||
		/(^|[-_.])(host|hardware|system-sampler)([-_.]|$)/u.test(component)
	) {
		return "host";
	}
	if (
		eventKind.startsWith("service.") ||
		/(^|[-_.])(service|server|gateway|speach|ua-runtime)([-_.]|$)/u.test(component)
	) {
		return "services";
	}
	return "model";
}

/** True only when current evidence confirms at least one span remains open. */
export function trajectoryHasOpenRecords(turns: readonly TrajectoryTurn[]): boolean {
	return turns.some((turn) => turn.records.some((record) =>
		record.kind !== "GAP" && record.isOpen && !record.closureUnknown));
}

function timelineSpan(
	record: TelemetryTrajectoryRecord,
	range: TrajectoryTimeRange,
	includeLiveElapsed = true,
): TrajectoryTimelineSpan {
	return {
		...range,
		recordId: record.id,
		sequence: record.sequence,
		kind: record.kind,
		label: record.summary,
		lane: timelineLaneForRecord(record),
		durationMs: record.durationMs,
		liveElapsedMs: includeLiveElapsed && record.isOpen && !record.closureUnknown
			? Math.max(0, range.end - range.start)
			: null,
		isError: record.isError,
		isCancelled: record.kind === "CANCELLED",
		isStalled: record.kind === "STALL",
		isOpen: record.isOpen,
		closureUnknown: record.closureUnknown,
	};
}

function renderSpan(span: TrajectoryTimelineSpan): TrajectoryTimelineRenderSpan {
	return {
		...span,
		id: `record:${span.recordId}`,
		recordIds: [span.recordId],
		count: 1,
	};
}

function aggregateSpanChunk(
	chunk: readonly TrajectoryTimelineSpan[],
	chunkIndex: number,
): TrajectoryTimelineRenderSpan {
	if (chunk.length === 1) return renderSpan(chunk[0] as TrajectoryTimelineSpan);
	const first = chunk[0] as TrajectoryTimelineSpan;
	return {
		id: `aggregate:${first.lane}:${chunkIndex}:${first.sequence}`,
		recordIds: chunk.map((span) => span.recordId),
		count: chunk.length,
		sequence: Math.min(...chunk.map((span) => span.sequence)),
		kind: first.kind,
		label: `${chunk.length} ${first.lane} records`,
		lane: first.lane,
		start: Math.min(...chunk.map((span) => span.start)),
		end: Math.max(...chunk.map((span) => span.end)),
		durationMs: null,
		liveElapsedMs: null,
		isError: chunk.some((span) => span.isError),
		isCancelled: chunk.some((span) => span.isCancelled),
		isStalled: chunk.some((span) => span.isStalled),
		isOpen: chunk.some((span) => span.isOpen),
		closureUnknown: chunk.some((span) => span.closureUnknown),
	};
}

/**
 * Bound dense timeline DOM by grouping spans into per-lane horizontal bins.
 * Explicitly preserved records remain singleton items for stable selection.
 */
export function aggregateTrajectoryTimelineSpans(
	spans: readonly TrajectoryTimelineSpan[],
	options: TrajectoryTimelineAggregationOptions = {},
): readonly TrajectoryTimelineRenderSpan[] {
	const requestedMaxItems = Math.max(1, Math.floor(options.maxItems ?? 512));
	const primary = options.primaryRecordId === undefined
		? undefined
		: spans.find((span) => span.recordId === options.primaryRecordId);
	const minimumLaneItems = new Set(
		spans.filter((span) => span !== primary).map((span) => span.lane),
	).size;
	const maxItems = Math.max(
		requestedMaxItems,
		minimumLaneItems + (primary === undefined ? 0 : 1),
	);
	if (spans.length <= maxItems) return spans.map(renderSpan);

	const preserveRecordIds = new Set(options.preserveRecordIds ?? []);
	if (options.primaryRecordId !== undefined) preserveRecordIds.add(options.primaryRecordId);
	const preserveLimit = Math.max(
		primary === undefined ? 0 : 1,
		maxItems - minimumLaneItems,
	);
	const orderedPreserveIds = [
		...(options.primaryRecordId === undefined ? [] : [options.primaryRecordId]),
		...preserveRecordIds,
	].filter((recordId, index, values) => values.indexOf(recordId) === index);
	const preservePriority = new Map(
		orderedPreserveIds.map((recordId, index) => [recordId, index]),
	);
	const preserved = spans
		.filter((span) => preserveRecordIds.has(span.recordId))
		.sort((left, right) =>
			(preservePriority.get(left.recordId) ?? Number.MAX_SAFE_INTEGER) -
			(preservePriority.get(right.recordId) ?? Number.MAX_SAFE_INTEGER))
		.slice(0, preserveLimit);
	const preservedIds = new Set(preserved.map((span) => span.recordId));
	const remaining = spans.filter((span) => !preservedIds.has(span.recordId));
	const groups = TRAJECTORY_TIMELINE_LANES
		.map((lane) => ({
			lane,
			spans: remaining
				.filter((span) => span.lane === lane)
				.sort((left, right) => left.start - right.start || left.sequence - right.sequence),
		}))
		.filter((group) => group.spans.length > 0);
	const bucketBudget = Math.max(groups.length, maxItems - preserved.length);
	const quotas = new Map(groups.map((group) => [group.lane, 1]));
	let unallocated = bucketBudget - groups.length;
	while (unallocated > 0) {
		const candidate = [...groups]
			.filter((group) => (quotas.get(group.lane) ?? 1) < group.spans.length)
			.sort((left, right) => {
				const leftQuota = quotas.get(left.lane) ?? 1;
				const rightQuota = quotas.get(right.lane) ?? 1;
				return right.spans.length / rightQuota - left.spans.length / leftQuota;
			})[0];
		if (candidate === undefined) break;
		quotas.set(candidate.lane, (quotas.get(candidate.lane) ?? 1) + 1);
		unallocated -= 1;
	}
	const aggregated: TrajectoryTimelineRenderSpan[] = [];
	for (const group of groups) {
		const quota = quotas.get(group.lane) ?? 1;
		for (let index = 0; index < quota; index += 1) {
			const start = Math.floor(index * group.spans.length / quota);
			const end = Math.floor((index + 1) * group.spans.length / quota);
			const chunk = group.spans.slice(start, end);
			if (chunk.length > 0) aggregated.push(aggregateSpanChunk(chunk, index));
		}
	}

	const laneOrder = new Map(TRAJECTORY_TIMELINE_LANES.map((lane, index) => [lane, index]));
	return [...preserved.map(renderSpan), ...aggregated].sort((left, right) =>
		left.start - right.start ||
		(laneOrder.get(left.lane) ?? 0) - (laneOrder.get(right.lane) ?? 0) ||
		compareText(left.id, right.id));
}

function renderGapBand(gap: TrajectoryTimelineGapBand): TrajectoryTimelineRenderGap {
	return {
		...gap,
		id: `gap-record:${gap.recordId}`,
		recordIds: [gap.recordId],
		count: 1,
	};
}

function aggregateTrajectoryTimelineGaps(
	gaps: readonly TrajectoryTimelineGapBand[],
	maxItems: number,
	primaryRecordId: string | undefined,
): readonly TrajectoryTimelineRenderGap[] {
	const limit = Math.max(1, Math.floor(maxItems));
	if (gaps.length <= limit) return gaps.map(renderGapBand);
	const primary = primaryRecordId === undefined
		? undefined
		: gaps.find((gap) => gap.recordId === primaryRecordId);
	const preserved = primary === undefined ? [] : [primary];
	const remaining = gaps.filter((gap) => gap !== primary);
	const slots = limit - preserved.length;
	if (slots <= 0) return preserved.map(renderGapBand);
	const chunkSize = Math.ceil(remaining.length / slots);
	const aggregated: TrajectoryTimelineRenderGap[] = [];
	for (let offset = 0; offset < remaining.length; offset += chunkSize) {
		const chunk = remaining.slice(offset, offset + chunkSize);
		if (chunk.length === 1) {
			aggregated.push(renderGapBand(chunk[0] as TrajectoryTimelineGapBand));
			continue;
		}
		const first = chunk[0] as TrajectoryTimelineGapBand;
		aggregated.push({
			id: `gap-aggregate:${first.recordId}`,
			recordIds: chunk.map((gap) => gap.recordId),
			count: chunk.length,
			label: `${chunk.length} telemetry gaps`,
			start: Math.min(...chunk.map((gap) => gap.start)),
			end: Math.max(...chunk.map((gap) => gap.end)),
		});
	}
	return [...preserved.map(renderGapBand), ...aggregated]
		.sort((left, right) => left.start - right.start || compareText(left.id, right.id));
}

function sampleTurnBoundaries(
	boundaries: readonly TrajectoryTimelineTurnBoundary[],
	maxItems: number,
): readonly TrajectoryTimelineTurnBoundary[] {
	const limit = Math.max(0, Math.floor(maxItems));
	if (boundaries.length <= limit) return boundaries;
	if (limit === 0) return [];
	return Array.from({ length: limit }, (_, index) =>
		boundaries[Math.min(
			boundaries.length - 1,
			Math.floor(index * boundaries.length / limit),
		)] as TrajectoryTimelineTurnBoundary);
}

/** Apply one total DOM-node budget across spans, gaps, and Turn boundaries. */
export function boundTrajectoryTimelineForRender(
	model: TrajectoryTimelineModel | null,
	options: TrajectoryTimelineAggregationOptions = {},
): BoundedTrajectoryTimelineRenderModel {
	if (model === null) return { spans: [], gapBands: [], turnBoundaries: [] };
	const maxItems = Math.max(8, Math.floor(options.maxItems ?? 512));
	const rawTotal = model.spans.length + model.gapBands.length + model.turnBoundaries.length;
	if (rawTotal <= maxItems) {
		return {
			spans: model.spans.map(renderSpan),
			gapBands: model.gapBands.map(renderGapBand),
			turnBoundaries: model.turnBoundaries,
		};
	}

	const primarySpan = options.primaryRecordId === undefined
		? undefined
		: model.spans.find((span) => span.recordId === options.primaryRecordId);
	const primaryGap = options.primaryRecordId === undefined
		? undefined
		: model.gapBands.find((gap) => gap.recordId === options.primaryRecordId);
	const spanMinimum = model.spans.length === 0
		? 0
		: new Set(model.spans
			.filter((span) => span !== primarySpan)
			.map((span) => span.lane)).size + (primarySpan === undefined ? 0 : 1);
	const gapMinimum = model.gapBands.length === 0
		? 0
		: primaryGap !== undefined && model.gapBands.length > 1 ? 2 : 1;
	const boundaryCap = Math.min(64, model.turnBoundaries.length);
	const budgets = {
		spans: spanMinimum,
		gaps: gapMinimum,
		boundaries: boundaryCap === 0 ? 0 : 1,
	};
	const caps = {
		spans: model.spans.length,
		gaps: model.gapBands.length,
		boundaries: boundaryCap,
	};
	const rawCounts = {
		spans: model.spans.length,
		gaps: model.gapBands.length,
		boundaries: model.turnBoundaries.length,
	};
	type BudgetKey = keyof typeof budgets;
	let unallocated = maxItems - budgets.spans - budgets.gaps - budgets.boundaries;
	while (unallocated > 0) {
		const candidate = (["spans", "gaps", "boundaries"] as const)
			.filter((key) => budgets[key] < caps[key])
			.sort((left, right) => {
				const leftScore = (rawCounts[left] - budgets[left]) / Math.max(1, budgets[left]);
				const rightScore = (rawCounts[right] - budgets[right]) / Math.max(1, budgets[right]);
				return rightScore - leftScore;
			})[0] as BudgetKey | undefined;
		if (candidate === undefined) break;
		budgets[candidate] += 1;
		unallocated -= 1;
	}
	const spanBudget = budgets.spans;
	const gapBudget = budgets.gaps;
	const boundaryBudget = budgets.boundaries;

	return {
		spans: spanBudget === 0
			? []
			: aggregateTrajectoryTimelineSpans(model.spans, {
				...options,
				maxItems: spanBudget,
			}),
		gapBands: gapBudget === 0
			? []
			: aggregateTrajectoryTimelineGaps(
				model.gapBands,
				gapBudget,
				options.primaryRecordId,
			),
		turnBoundaries: sampleTurnBoundaries(model.turnBoundaries, boundaryBudget),
	};
}

function sequenceTimeline(records: readonly OrderedRecord[]): TrajectoryTimelineModel | null {
	if (records.length === 0) return null;
	const spans: TrajectoryTimelineSpan[] = [];
	const gapBands: TrajectoryTimelineGapBand[] = [];
	const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];
	const seenTurns = new Set<string>();
	let cursor = 0;

	for (const { record, turnId } of records) {
		if (!seenTurns.has(turnId)) {
			seenTurns.add(turnId);
			turnBoundaries.push({ turnId, time: cursor });
		}
		if (record.kind === "GAP") {
			gapBands.push({
				recordId: record.id,
				start: cursor,
				end: cursor + 1,
				label: record.summary,
			});
		} else {
			spans.push(timelineSpan(record, { start: cursor, end: cursor + 1 }, false));
		}
		cursor += 1;
	}

	return {
		mode: "sequence",
		start: 0,
		end: cursor,
		spans,
		gapBands,
		turnBoundaries,
		unknownTimingRecordIds: [],
	};
}

function knownGapBands(
	records: readonly OrderedRecord[],
	spanById: ReadonlyMap<string, TrajectoryTimelineSpan>,
): readonly TrajectoryTimelineGapBand[] {
	const bands: TrajectoryTimelineGapBand[] = [];
	for (const [index, { record }] of records.entries()) {
		if (record.kind !== "GAP") continue;
		let before: TrajectoryTimelineSpan | undefined;
		let after: TrajectoryTimelineSpan | undefined;
		for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
			before = spanById.get(records[cursor]?.record.id ?? "");
			if (before !== undefined) break;
		}
		for (let cursor = index + 1; cursor < records.length; cursor += 1) {
			after = spanById.get(records[cursor]?.record.id ?? "");
			if (after !== undefined) break;
		}
		if (before === undefined || after === undefined || after.start < before.end) continue;
		bands.push({
			recordId: record.id,
			start: before.end,
			end: after.start,
			label: record.summary,
		});
	}
	return bands;
}

/**
 * Project recorded evidence into wall clock or idle-compressed time. Compression
 * removes only uncovered intervals. It never changes a recorded span duration.
 */
function timedTimeline(
	records: readonly OrderedRecord[],
	mode: "wall" | "compressed",
	options: TrajectoryTimelineOptions,
): TrajectoryTimelineModel | null {
	const timedRecords: TimedRecord[] = [];
	const unknownTimingRecordIds: string[] = [];
	for (const entry of records) {
		if (entry.record.kind === "GAP") continue;
		const range = recordedRange(entry.record, options);
		if (range === null) {
			unknownTimingRecordIds.push(entry.record.id);
			continue;
		}
		timedRecords.push({
			...entry,
			span: timelineSpan(entry.record, range),
		});
	}
	if (timedRecords.length === 0) return null;

	const rawSpans = timedRecords.map((entry) => entry.span);
	const removedIdleBySpan = new Map<TrajectoryTimelineSpan, number>();
	let removedIdle = 0;
	let coveredUntil: number | null = null;
	for (const span of [...rawSpans].sort((left, right) =>
		left.start - right.start || left.end - right.end || compareText(left.recordId, right.recordId))) {
		if (mode === "compressed" && coveredUntil !== null && span.start > coveredUntil) {
			removedIdle += span.start - coveredUntil;
		}
		removedIdleBySpan.set(span, removedIdle);
		coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
	}

	const spans: TrajectoryTimelineSpan[] = [];
	const spanById = new Map<string, TrajectoryTimelineSpan>();
	for (const { span } of timedRecords) {
		const offset = removedIdleBySpan.get(span) ?? 0;
		const projected = {
			...span,
			start: span.start - offset,
			end: span.end - offset,
		};
		spans.push(projected);
		spanById.set(projected.recordId, projected);
	}

	const gapBands = knownGapBands(records, spanById);
	const placedGapIds = new Set(gapBands.map((gap) => gap.recordId));
	for (const { record } of records) {
		if (record.kind === "GAP" && !placedGapIds.has(record.id)) {
			unknownTimingRecordIds.push(record.id);
		}
	}
	const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];
	const seenTurns = new Set<string>();
	for (const entry of timedRecords) {
		if (seenTurns.has(entry.turnId)) continue;
		const span = spanById.get(entry.record.id);
		if (span === undefined) continue;
		seenTurns.add(entry.turnId);
		turnBoundaries.push({ turnId: entry.turnId, time: span.start });
	}

	return {
		mode,
		start: Math.min(...spans.map((span) => span.start)),
		end: Math.max(...spans.map((span) => span.end)),
		spans,
		gapBands,
		turnBoundaries,
		unknownTimingRecordIds,
	};
}

/**
 * Project every record into four stable lanes. Wall mode is the default;
 * sequence is the explicit fallback when timing evidence is absent.
 */
export function deriveTrajectoryTimeline(
	turns: readonly TrajectoryTurn[],
	mode: TrajectoryTimelineMode = "wall",
	options: TrajectoryTimelineOptions = {},
): TrajectoryTimelineModel | null {
	const records = orderedRecords(turns);
	return mode === "sequence"
		? sequenceTimeline(records)
		: timedTimeline(records, mode, options);
}

/** Select records intersecting an inclusive range by stable record ID. */
export function trajectoryTimelineFocusRecordIds(
	turns: readonly TrajectoryTurn[],
	range: TrajectoryTimeRange,
	mode: TrajectoryTimelineMode = "wall",
	options: TrajectoryTimelineOptions = {},
): ReadonlySet<string> {
	const model = deriveTrajectoryTimeline(turns, mode, options);
	if (model === null) return new Set();
	return new Set([
		...model.spans
			.filter((span) => span.start <= range.end && span.end >= range.start)
			.map((span) => span.recordId),
		...model.gapBands
			.filter((gap) => gap.start <= range.end && gap.end >= range.start)
			.map((gap) => gap.recordId),
	]);
}
