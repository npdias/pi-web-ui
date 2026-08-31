/**
 * Turn/Step grouping and exact tool pairing adapted from DeepSeek Harness:
 * packages/client/ui-trajectory/src/client/layout.ts
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import type {
	TelemetryCorrelation,
	TelemetryEvent,
	TelemetryJson,
	TelemetryReplayGap,
	TelemetrySource,
} from "../telemetry-types.js";
import type {
	GapTrajectoryRecord,
	TelemetryTrajectoryRecord,
	TrajectoryProjectionInput,
	TrajectoryRecord,
	TrajectoryRecordKind,
	TrajectoryStep,
	TrajectoryTurn,
} from "./record.js";

const SUPPORTED_EVENT_KINDS = new Set([
	"agent.run",
	"agent.turn",
	"tool.execution",
	"provider.thinking",
	"agent.stall",
	"agent.reset",
	"context.changed",
]);
const MAX_RECORD_SUMMARY_LENGTH = 512;

interface OrderedEvent {
	readonly type: "event";
	readonly event: TelemetryEvent;
}

interface OrderedGap {
	readonly type: "gap";
	readonly gap: TelemetryReplayGap;
}

type OrderedInput = OrderedEvent | OrderedGap;

function compareText(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}

interface MutableTurn {
	readonly id: string;
	readonly turnId?: string;
	readonly traceId?: string;
	readonly steps: Map<string, MutableStep>;
	readonly records: TrajectoryRecord[];
}

interface MutableStep {
	readonly id: string;
	readonly stepId?: string;
	readonly requestId?: string;
	readonly records: TrajectoryRecord[];
}

interface OpenAttempt {
	readonly recordIndex: number;
	readonly events: TelemetryEvent[];
}

interface AttemptTracker {
	nextOrdinal: number;
	lastGapIndexSeen: number;
	hasSettledAttempt: boolean;
	open?: OpenAttempt;
	uncertainRecordIndex?: number;
}

function unwrap(input: TrajectoryProjectionInput): OrderedInput {
	if ("type" in input && input.type === "event") {
		return { type: "event", event: input.event };
	}
	if ("type" in input && input.type === "gap") {
		return { type: "gap", gap: input.gap };
	}
	return { type: "event", event: input };
}

function inputSequence(input: OrderedInput): number {
	return input.type === "event" ? input.event.sequence : input.gap.resume_after;
}

function inputIdentity(input: OrderedInput): string {
	return input.type === "event"
		? input.event.event_id
		: `gap:${input.gap.requested}:${input.gap.earliest_available ?? "none"}:${input.gap.resume_after}`;
}

function compareInputs(left: OrderedInput, right: OrderedInput): number {
	const leftSequence = inputSequence(left);
	const rightSequence = inputSequence(right);
	if (leftSequence !== rightSequence) return leftSequence < rightSequence ? -1 : 1;
	if (left.type !== right.type) return left.type === "event" ? -1 : 1;
	return compareText(inputIdentity(left), inputIdentity(right));
}

function normalizedInputs(inputs: readonly TrajectoryProjectionInput[]): readonly OrderedInput[] {
	const sorted = inputs.map(unwrap).sort(compareInputs);
	const eventIds = new Set<string>();
	const eventSequences = new Set<number>();
	const gaps = new Set<string>();
	const output: OrderedInput[] = [];
	for (const input of sorted) {
		if (input.type === "gap") {
			const id = inputIdentity(input);
			if (gaps.has(id)) continue;
			gaps.add(id);
			output.push(input);
			continue;
		}
		if (
			eventIds.has(input.event.event_id) ||
			eventSequences.has(input.event.sequence)
		) {
			continue;
		}
		eventIds.add(input.event.event_id);
		eventSequences.add(input.event.sequence);
		output.push(input);
	}
	return output;
}

function eventRecordId(event: TelemetryEvent): string {
	return event.event_id.length > 0
		? `event:${event.event_id}`
		: `sequence:${event.sequence}`;
}

function attemptRecordId(key: string, anchor: TelemetryEvent): string {
	return `attempt:${key}|anchor:${identityPart(anchor.event_id)}|sequence:${anchor.sequence}`;
}

function identityPart(value: string): string {
	return `${value.length}:${value}`;
}

function sourceIdentity(
	source: TelemetrySource,
	correlation: TelemetryCorrelation | undefined,
): string {
	return [
		source.robot_id,
		source.host_id,
		source.component,
		source.instance_id ?? "",
		correlation?.session_id ?? "",
		correlation?.conversation_id ?? "",
	]
		.map(identityPart)
		.join("|");
}

function scopedIdentity(
	source: TelemetrySource,
	correlation: TelemetryCorrelation | undefined,
	semanticId: string,
): string {
	return `${sourceIdentity(source, correlation)}|${identityPart(semanticId)}`;
}

function lifecycleSemanticId(event: TelemetryEvent): string | undefined {
	switch (event.kind) {
		case "agent.run":
			return event.correlation?.trace_id;
		case "agent.turn":
			return event.correlation?.turn_id;
		case "tool.execution":
			return event.correlation?.tool_call_id;
		default:
			return undefined;
	}
}

function lifecycleKey(event: TelemetryEvent): string | undefined {
	const semanticId = lifecycleSemanticId(event);
	return semanticId === undefined
		? undefined
		: `${event.kind}|${scopedIdentity(event.source, event.correlation, semanticId)}`;
}

function gapRecordId(gap: TelemetryReplayGap): string {
	return `gap:${gap.requested}:${gap.earliest_available ?? "none"}:${gap.resume_after}`;
}

function scopeFields(correlation: TelemetryCorrelation | undefined) {
	return {
		...(correlation?.trace_id === undefined ? {} : { traceId: correlation.trace_id }),
		...(correlation?.turn_id === undefined ? {} : { turnId: correlation.turn_id }),
		...(correlation?.step_id === undefined ? {} : { stepId: correlation.step_id }),
		...(correlation?.request_id === undefined
			? {}
			: { requestId: correlation.request_id }),
		...(correlation?.tool_call_id === undefined
			? {}
			: { toolCallId: correlation.tool_call_id }),
	};
}

function recordedDuration(event: TelemetryEvent): number | null {
	return typeof event.duration_ms === "number" &&
		Number.isFinite(event.duration_ms) &&
		event.duration_ms >= 0
		? event.duration_ms
		: null;
}

function terminalKind(event: TelemetryEvent, fallback: TrajectoryRecordKind): TrajectoryRecordKind {
	if (
		event.state === "cancelled" ||
		event.state === "aborted" ||
		event.state === "forced_reset"
	) {
		return "CANCELLED";
	}
	if (
		event.state === "error" ||
		event.severity === "error" ||
		event.severity === "critical" ||
		event.attributes.is_error === true
	) {
		return "ERROR";
	}
	return fallback;
}

function recordKind(event: TelemetryEvent): Exclude<TrajectoryRecordKind, "GAP"> {
	switch (event.kind) {
		case "agent.run":
			return terminalKind(event, "SYSTEM") as Exclude<TrajectoryRecordKind, "GAP">;
		case "agent.turn":
			return terminalKind(
				event,
				event.phase === "start" ? "REQUEST" : "RESULT",
			) as Exclude<TrajectoryRecordKind, "GAP">;
		case "tool.execution":
			return terminalKind(event, "TOOL") as Exclude<TrajectoryRecordKind, "GAP">;
		case "provider.thinking":
			return "ASSISTANT";
		case "agent.stall":
			return "STALL";
		case "agent.reset":
			return "CANCELLED";
		case "context.changed":
			return "CONTEXT";
		default:
			return "SYSTEM";
	}
}

function stringAttribute(
	attributes: Readonly<Record<string, TelemetryJson>>,
	key: string,
): string | undefined {
	const value = attributes[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function defaultSummary(event: TelemetryEvent): string {
	const terminal = event.state === undefined ? "updated" : event.state.replaceAll("_", " ");
	switch (event.kind) {
		case "agent.run":
			return event.phase === "start" ? "Agent run started" : `Agent run ${terminal}`;
		case "agent.turn":
			return event.phase === "start" ? "Agent Turn started" : `Agent Turn ${terminal}`;
		case "tool.execution": {
			const tool = stringAttribute(event.attributes, "tool_name") ?? "Tool";
			return event.phase === "start" ? `${tool} started` : `${tool} ${terminal}`;
		}
		case "provider.thinking":
			return "Provider thinking";
		case "agent.stall":
			return "Possibly stalled";
		case "agent.reset":
			return "Agent reset";
		case "context.changed":
			return "Context changed";
		default:
			return event.kind;
	}
}

function eventSummary(event: TelemetryEvent): {
	readonly summary: string;
	readonly summaryTruncated?: boolean;
} {
	const summary = event.summary === undefined || event.summary.length === 0
		? defaultSummary(event)
		: event.summary;
	if (summary.length <= MAX_RECORD_SUMMARY_LENGTH) return { summary };
	return {
		summary: `${summary.slice(0, MAX_RECORD_SUMMARY_LENGTH - 1)}…`,
		summaryTruncated: true,
	};
}

function eventIsError(event: TelemetryEvent): boolean {
	return (
		event.state === "error" ||
		event.severity === "error" ||
		event.severity === "critical" ||
		event.attributes.is_error === true
	);
}

const PRIVACY_ORDER: Readonly<Record<string, number>> = {
	public: 0,
	internal: 1,
	operator: 2,
	sensitive: 3,
	restricted: 4,
	secret: 5,
};

/** Unknown defined classes outrank known classes conservatively; equal ranks sort by value. */
function strictestPrivacyClass(events: readonly TelemetryEvent[]): string | undefined {
	let selected: string | undefined;
	let selectedRank = Number.NEGATIVE_INFINITY;
	for (const event of events) {
		const candidate = event.privacy_class;
		if (candidate === undefined) continue;
		const rank = PRIVACY_ORDER[candidate.toLowerCase()] ?? Number.POSITIVE_INFINITY;
		if (
			rank > selectedRank ||
			(rank === selectedRank && selected !== undefined && compareText(candidate, selected) > 0)
		) {
			selected = candidate;
			selectedRank = rank;
		}
	}
	return selected;
}

function aggregateRedaction(
	events: readonly TelemetryEvent[],
): Readonly<Record<string, TelemetryJson>> | undefined {
	let present = false;
	let applied = false;
	const fields = new Set<string>();
	for (const event of events) {
		const redaction = event.redaction;
		if (redaction === undefined) continue;
		present = true;
		if (redaction.applied === true) applied = true;
		const eventFields = redaction.fields;
		if (!Array.isArray(eventFields)) continue;
		for (const field of eventFields) {
			if (typeof field === "string") fields.add(field);
		}
	}
	if (!present) return undefined;
	return {
		applied,
		fields: [...fields].sort(compareText),
	};
}

function aggregateEnvelopeEvidence(events: readonly TelemetryEvent[]): Pick<
	TelemetryTrajectoryRecord,
	"payloadRefs" | "privacyClass" | "privacyIncomplete" | "redaction" | "sourceEnvelopes"
> {
	const sourceEnvelopes = [...events];
	const payloadRefs: string[] = [];
	const seenPayloadRefs = new Set<string>();
	for (const event of sourceEnvelopes) {
		const payloadRef = event.payload_ref;
		if (payloadRef === undefined || seenPayloadRefs.has(payloadRef)) continue;
		seenPayloadRefs.add(payloadRef);
		payloadRefs.push(payloadRef);
	}
	const privacyIncomplete = sourceEnvelopes.some((event) => event.privacy_class === undefined);
	const privacyClass = privacyIncomplete ? undefined : strictestPrivacyClass(sourceEnvelopes);
	const redaction = aggregateRedaction(sourceEnvelopes);
	return {
		sourceEnvelopes,
		payloadRefs,
		privacyIncomplete,
		...(privacyClass === undefined ? {} : { privacyClass }),
		...(redaction === undefined ? {} : { redaction }),
	};
}

function mergedAttributes(events: readonly TelemetryEvent[]): Readonly<Record<string, TelemetryJson>> {
	const attributes: Record<string, TelemetryJson> = {};
	for (const event of events) Object.assign(attributes, event.attributes);
	return attributes;
}

function diagnosticEvidence(
	events: readonly TelemetryEvent[],
	flags = false,
): boolean {
	return flags || events.some((event) =>
		event.attributes.duplicate_start === true ||
		event.attributes.matched_start === false ||
		event.attributes.cause_class !== undefined);
}

function attemptEvidenceFields(events: readonly TelemetryEvent[]) {
	const aggregate = aggregateEnvelopeEvidence(events);
	const sourceEnvelopes = aggregate.sourceEnvelopes;
	return {
		sourceEventIds: sourceEnvelopes.map((event) => event.event_id),
		sourceSequences: sourceEnvelopes.map((event) => event.sequence),
		...aggregate,
		...(aggregate.privacyIncomplete ? { privacyClass: undefined } : {}),
	};
}

function openAttemptRecord(
	event: TelemetryEvent,
	key: string,
	ordinal: number,
): TelemetryTrajectoryRecord {
	return {
		id: attemptRecordId(key, event),
		index: 0,
		kind: recordKind(event),
		sequence: event.sequence,
		...eventSummary(event),
		durationMs: null,
		isOpen: true,
		isError: eventIsError(event),
		eventKind: event.kind,
		severity: event.severity,
		source: event.source,
		attributes: event.attributes,
		attemptOrdinal: ordinal,
		attemptOrdinalKnown: false,
		closureUnknown: false,
		gapTainted: false,
		gapEvidence: [],
		terminalConflict: false,
		unmatchedTerminal: false,
		diagnostic: diagnosticEvidence([event]),
		...attemptEvidenceFields([event]),
		...(event.phase === undefined ? {} : { phase: event.phase }),
		...(event.state === undefined ? {} : { state: event.state }),
		...(event.correlation === undefined ? {} : { correlation: event.correlation }),
		...scopeFields(event.correlation),
		startedAt: event.observed_at,
		...(stringAttribute(event.attributes, "tool_name") === undefined
			? {}
			: { toolName: stringAttribute(event.attributes, "tool_name") }),
	};
}

function mergeOpenAttemptEvidence(
	record: TelemetryTrajectoryRecord,
	events: readonly TelemetryEvent[],
): TelemetryTrajectoryRecord {
	return {
		...record,
		attributes: mergedAttributes(events),
		diagnostic: diagnosticEvidence(events),
		...attemptEvidenceFields(events),
	};
}

function settleAttempt(
	record: TelemetryTrajectoryRecord,
	event: TelemetryEvent,
): TelemetryTrajectoryRecord {
	const evidence = [...record.sourceEnvelopes, event];
	const attributes = mergedAttributes(evidence);
	const terminal = { ...event, attributes };
	const toolName = stringAttribute(attributes, "tool_name");
	return {
		...record,
		kind: recordKind(terminal),
		...eventSummary(terminal),
		durationMs: recordedDuration(event),
		isOpen: false,
		isError: eventIsError(terminal),
		severity: event.severity,
		attributes,
		closureUnknown: false,
		gapTainted: false,
		gapEvidence: [],
		terminalConflict: false,
		unmatchedTerminal: false,
		diagnostic: diagnosticEvidence(evidence),
		...attemptEvidenceFields(evidence),
		phase: "end",
		...(event.state === undefined ? {} : { state: event.state }),
		endedAt: event.observed_at,
		...(toolName === undefined ? {} : { toolName }),
	};
}

function terminalOnlyAttempt(
	event: TelemetryEvent,
	key: string,
	ordinal: number,
	tracker: AttemptTracker,
	gapEvidence: readonly TelemetryReplayGap[],
): TelemetryTrajectoryRecord {
	const closureUnknown = gapEvidence.length > 0;
	const terminalConflict = !closureUnknown && tracker.hasSettledAttempt;
	const state = closureUnknown
		? "closure_unknown"
		: terminalConflict
			? "conflict"
			: "unmatched_terminal";
	const toolName = stringAttribute(event.attributes, "tool_name");
	return {
		id: attemptRecordId(key, event),
		index: 0,
		kind: recordKind(event),
		sequence: event.sequence,
		summary: closureUnknown
			? `${event.kind} terminal after replay gap`
			: terminalConflict
				? `Conflicting ${event.kind} terminal evidence`
				: eventSummary(event).summary,
		durationMs: recordedDuration(event),
		isOpen: false,
		isError: eventIsError(event),
		eventKind: event.kind,
		phase: "end",
		state,
		severity: event.severity,
		source: event.source,
		attributes: event.attributes,
		attemptOrdinal: ordinal,
		attemptOrdinalKnown: false,
		closureUnknown,
		gapTainted: closureUnknown,
		gapEvidence,
		terminalConflict,
		unmatchedTerminal: true,
		diagnostic: true,
		...attemptEvidenceFields([event]),
		...(event.correlation === undefined ? {} : { correlation: event.correlation }),
		...scopeFields(event.correlation),
		endedAt: event.observed_at,
		...(toolName === undefined ? {} : { toolName }),
	};
}

function standaloneEventRecord(event: TelemetryEvent): TelemetryTrajectoryRecord {
	const toolName = stringAttribute(event.attributes, "tool_name");
	return {
		id: eventRecordId(event),
		index: 0,
		kind: recordKind(event),
		sequence: event.sequence,
		...eventSummary(event),
		durationMs: recordedDuration(event),
		isOpen: false,
		isError: eventIsError(event),
		eventKind: event.kind,
		severity: event.severity,
		source: event.source,
		attributes: event.attributes,
		attemptOrdinalKnown: false,
		closureUnknown: false,
		gapTainted: false,
		gapEvidence: [],
		terminalConflict: false,
		unmatchedTerminal: false,
		diagnostic: diagnosticEvidence([event]),
		...attemptEvidenceFields([event]),
		...(event.phase === undefined ? {} : { phase: event.phase }),
		...(event.state === undefined ? {} : { state: event.state }),
		...(event.correlation === undefined ? {} : { correlation: event.correlation }),
		...scopeFields(event.correlation),
		...(event.phase === "start" ? { startedAt: event.observed_at } : {}),
		...(event.phase === "end" ? { endedAt: event.observed_at } : {}),
		...(event.kind === "provider.thinking" &&
			stringAttribute(event.attributes, "content") !== undefined
			? { thinkingDetail: stringAttribute(event.attributes, "content") }
			: {}),
		...(toolName === undefined ? {} : { toolName }),
	};
}

function gapRecord(gap: TelemetryReplayGap): GapTrajectoryRecord {
	return {
		id: gapRecordId(gap),
		index: 0,
		kind: "GAP",
		sequence: gap.resume_after,
		summary: gap.earliest_available === null
			? `Telemetry gap after sequence ${gap.resume_after}`
			: `Telemetry gap before sequence ${gap.earliest_available}`,
		durationMs: null,
		isOpen: false,
		isError: false,
		sourceEventIds: [],
		sourceSequences: [],
		gap,
	};
}

function markGapBoundary(
	record: TrajectoryRecord,
	gap: TelemetryReplayGap,
): TrajectoryRecord {
	if (record.kind === "GAP") return record;
	return {
		...record,
		isOpen: false,
		closureUnknown: true,
		gapTainted: true,
		gapEvidence: [...record.gapEvidence, gap],
		state: "closure_unknown",
		diagnostic: true,
	};
}

function projectAttemptRecords(inputs: readonly OrderedInput[]): readonly TrajectoryRecord[] {
	const output: TrajectoryRecord[] = [];
	const trackers = new Map<string, AttemptTracker>();
	const openTrackers = new Set<AttemptTracker>();
	const uncertainTrackers = new Set<AttemptTracker>();
	const gaps: TelemetryReplayGap[] = [];

	for (const input of inputs) {
		if (input.type === "gap") {
			output.push(gapRecord(input.gap));
			gaps.push(input.gap);
			for (const tracker of uncertainTrackers) {
				const recordIndex = tracker.uncertainRecordIndex;
				if (recordIndex === undefined) continue;
				const record = output[recordIndex];
				if (record !== undefined) output[recordIndex] = markGapBoundary(record, input.gap);
			}
			for (const tracker of openTrackers) {
				const open = tracker.open;
				if (open === undefined) continue;
				const record = output[open.recordIndex];
				if (record !== undefined && record.kind !== "GAP") {
					output[open.recordIndex] = markGapBoundary(
						mergeOpenAttemptEvidence(record, open.events),
						input.gap,
					);
				}
				tracker.uncertainRecordIndex = open.recordIndex;
				tracker.open = undefined;
				tracker.hasSettledAttempt = true;
				uncertainTrackers.add(tracker);
			}
			openTrackers.clear();
			continue;
		}

		const event = input.event;
		if (!SUPPORTED_EVENT_KINDS.has(event.kind)) continue;
		const key = lifecycleKey(event);
		if (key === undefined || (event.phase !== "start" && event.phase !== "end")) {
			output.push(standaloneEventRecord(event));
			continue;
		}

		let tracker = trackers.get(key);
		if (tracker === undefined) {
			tracker = {
				nextOrdinal: 0,
				lastGapIndexSeen: 0,
				hasSettledAttempt: false,
			};
			trackers.set(key, tracker);
		}
		if (tracker.uncertainRecordIndex !== undefined) {
			tracker.uncertainRecordIndex = undefined;
			uncertainTrackers.delete(tracker);
		}

		if (event.phase === "start") {
			if (tracker.open !== undefined) {
				tracker.open.events.push(event);
				continue;
			}
			const ordinal = ++tracker.nextOrdinal;
			const recordIndex = output.push(
				openAttemptRecord(event, key, ordinal),
			) - 1;
			tracker.open = { recordIndex, events: [event] };
			tracker.lastGapIndexSeen = gaps.length;
			openTrackers.add(tracker);
			continue;
		}

		if (tracker.open !== undefined) {
			const current = output[tracker.open.recordIndex];
			if (current !== undefined && current.kind !== "GAP") {
				output[tracker.open.recordIndex] = settleAttempt(
					mergeOpenAttemptEvidence(current, tracker.open.events),
					event,
				);
			}
			tracker.open = undefined;
			tracker.hasSettledAttempt = true;
			tracker.lastGapIndexSeen = gaps.length;
			openTrackers.delete(tracker);
			continue;
		}

		const ordinal = ++tracker.nextOrdinal;
		const relevantGaps = gaps.slice(tracker.lastGapIndexSeen);
		output.push(terminalOnlyAttempt(
			event,
			key,
			ordinal,
			tracker,
			relevantGaps,
		));
		tracker.hasSettledAttempt = true;
		tracker.lastGapIndexSeen = gaps.length;
	}

	for (const tracker of openTrackers) {
		const open = tracker.open;
		if (open === undefined) continue;
		const record = output[open.recordIndex];
		if (record !== undefined && record.kind !== "GAP") {
			output[open.recordIndex] = mergeOpenAttemptEvidence(record, open.events);
		}
	}

	return output
		.sort((left, right) => {
			if (left.sequence !== right.sequence) return left.sequence < right.sequence ? -1 : 1;
			if (left.kind === "GAP" && right.kind !== "GAP") return 1;
			if (left.kind !== "GAP" && right.kind === "GAP") return -1;
			return compareText(left.id, right.id);
		})
		.map((record, index) => ({ ...record, index: index + 1 }));
}

function ownerIndexes(records: readonly TrajectoryRecord[]): Map<string, string> {
	const owners = new Map<string, string>();
	for (const record of records) {
		if (
			record.kind === "GAP" ||
			!record.sourceEnvelopes.some((event) => event.phase === "start")
		) {
			continue;
		}
		if (record.eventKind === "agent.run" && record.traceId !== undefined) {
			const key = scopedIdentity(record.source, record.correlation, record.traceId);
			if (!owners.has(key)) owners.set(key, record.id);
		}
		if (record.eventKind !== "agent.turn") continue;
		for (const id of [record.turnId, record.stepId, record.requestId]) {
			if (id === undefined) continue;
			const key = scopedIdentity(record.source, record.correlation, id);
			if (!owners.has(key)) owners.set(key, record.id);
		}
	}
	return owners;
}

function withParents(records: readonly TrajectoryRecord[]): readonly TrajectoryRecord[] {
	const owners = ownerIndexes(records);
	return records.map((record) => {
		if (record.kind === "GAP") return record;
		let candidates: Array<string | undefined>;
		if (record.eventKind === "agent.run") {
			candidates = [record.traceId];
		} else if (record.eventKind === "agent.turn" && record.phase === "start") {
			candidates = [record.correlation?.parent_id, record.traceId];
		} else {
			candidates = [
				record.requestId,
				record.stepId,
				record.turnId,
				record.correlation?.parent_id,
				record.traceId,
			];
		}
		for (const candidate of candidates) {
			if (candidate === undefined) continue;
			const parentRecordId = owners.get(
				scopedIdentity(record.source, record.correlation, candidate),
			);
			if (parentRecordId !== undefined && parentRecordId !== record.id) {
				return { ...record, parentRecordId };
			}
		}
		return record;
	});
}

function turnKey(record: TrajectoryRecord): string {
	if (record.kind !== "GAP") {
		const source = sourceIdentity(record.source, record.correlation);
		if (record.turnId !== undefined) return `${source}|turn:${identityPart(record.turnId)}`;
		if (record.traceId !== undefined) return `${source}|trace:${identityPart(record.traceId)}`;
		return `${source}|unscoped`;
	}
	return `gap:${record.id}`;
}

function stepKey(record: TrajectoryRecord): string {
	if (record.stepId !== undefined) return `step:${record.stepId}`;
	if (record.requestId !== undefined) return `request:${record.requestId}`;
	return "unscoped";
}

function groupRecords(records: readonly TrajectoryRecord[]): readonly TrajectoryTurn[] {
	const turns = new Map<string, MutableTurn>();
	for (const record of records) {
		const key = turnKey(record);
		let turn = turns.get(key);
		if (turn === undefined) {
			turn = {
				id: key,
				...(record.turnId === undefined ? {} : { turnId: record.turnId }),
				...(record.traceId === undefined ? {} : { traceId: record.traceId }),
				steps: new Map(),
				records: [],
			};
			turns.set(key, turn);
		}
		turn.records.push(record);
		const keyForStep = stepKey(record);
		let step = turn.steps.get(keyForStep);
		if (step === undefined) {
			step = {
				id: `${key}\u0000${keyForStep}`,
				...(record.stepId === undefined ? {} : { stepId: record.stepId }),
				...(record.requestId === undefined ? {} : { requestId: record.requestId }),
				records: [],
			};
			turn.steps.set(keyForStep, step);
		}
		step.records.push(record);
	}

	return [...turns.values()]
		.map((turn): TrajectoryTurn => ({
			id: turn.id,
			...(turn.turnId === undefined ? {} : { turnId: turn.turnId }),
			...(turn.traceId === undefined ? {} : { traceId: turn.traceId }),
			firstSequence: Math.min(...turn.records.map((record) => record.sequence)),
			records: turn.records,
			steps: [...turn.steps.values()]
				.map((step): TrajectoryStep => ({
					id: step.id,
					...(step.stepId === undefined ? {} : { stepId: step.stepId }),
					...(step.requestId === undefined ? {} : { requestId: step.requestId }),
					firstSequence: Math.min(...step.records.map((record) => record.sequence)),
					records: step.records,
				}))
				.sort((left, right) =>
					left.firstSequence === right.firstSequence
						? compareText(left.id, right.id)
						: left.firstSequence - right.firstSequence,
				),
		}))
		.sort((left, right) =>
			left.firstSequence === right.firstSequence
				? compareText(left.id, right.id)
				: left.firstSequence - right.firstSequence,
		);
}

/**
 * Project normalized telemetry or store records into Turn then Step groups.
 * Sorting, replay de-duplication, exact-ID parenting, and tool pairing stay pure.
 */
export function projectTrajectory(
	inputs: readonly TrajectoryProjectionInput[],
): readonly TrajectoryTurn[] {
	const normalized = normalizedInputs(inputs);
	return groupRecords(withParents(projectAttemptRecords(normalized)));
}

/** Flatten grouped rows back into authoritative sequence order. */
export function flattenTrajectoryRecords(
	turns: readonly TrajectoryTurn[],
): readonly TrajectoryRecord[] {
	const records = new Map<string, TrajectoryRecord>();
	for (const turn of turns) {
		for (const record of turn.records) records.set(record.id, record);
	}
	return [...records.values()].sort((left, right) => {
		if (left.sequence !== right.sequence) return left.sequence < right.sequence ? -1 : 1;
		if (left.kind === "GAP" && right.kind !== "GAP") return 1;
		if (left.kind !== "GAP" && right.kind === "GAP") return -1;
		return compareText(left.id, right.id);
	});
}
