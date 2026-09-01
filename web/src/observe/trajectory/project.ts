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
	"user.message",
	"model.response",
	"tool.execution",
	"tool.result",
	"provider.thinking",
	"agent.stall",
	"agent.reset",
	"context.changed",
]);
const MAX_RECORD_SUMMARY_LENGTH = 512;
const MAX_INLINE_GAP_EVIDENCE = 16;
const INLINE_GAP_HEAD = 8;
const INLINE_GAP_TAIL = 8;

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
	lastGapIndexSeen: number;
	hasSettledAttempt: boolean;
	open?: OpenAttempt;
	uncertainRecordIndex?: number;
	uncertainGapStartIndex?: number;
	pendingTerminalRecordIndex?: number;
}

interface GapEvidenceSummary {
	readonly evidence: readonly TelemetryReplayGap[];
	readonly count: number;
	readonly truncated: boolean;
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

function attemptRecordId(
	key: string,
	anchor: TelemetryEvent,
	disambiguate = false,
): string {
	const suffix = disambiguate
		? `|reuse:${identityPart(anchor.event_id)}|sequence:${anchor.sequence}`
		: "";
	return `attempt:${key}${suffix}`;
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
	const attemptId = stringAttribute(event.attributes, "lifecycle_attempt_id");
	if (attemptId !== undefined) return attemptId;
	switch (event.kind) {
		case "agent.run":
			return event.correlation?.trace_id;
		case "agent.turn":
			return event.correlation?.turn_id;
		case "tool.execution":
			return stringAttribute(event.attributes, "lifecycle_attempt_id");
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

function ordinalLifecycleKey(event: TelemetryEvent): string | undefined {
	const semanticId = event.kind === "tool.execution"
		? event.correlation?.tool_call_id
		: lifecycleSemanticId(event);
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
		case "user.message":
			return "USER";
		case "model.response":
			return "ASSISTANT";
		case "tool.result":
			return "RESULT";
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

function detailValue(value: TelemetryJson | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value.length === 0 ? undefined : value;
	return JSON.stringify(value, null, 2);
}

function detailFields(
	attributes: Readonly<Record<string, TelemetryJson>>,
): {
	readonly inputDetail?: string;
	readonly outputDetail?: string;
	readonly result?: string;
} {
	const inputDetail = detailValue(attributes.input_detail ?? attributes.input);
	const outputDetail = detailValue(attributes.output_detail);
	const result = detailValue(attributes.output);
	return {
		...(inputDetail === undefined ? {} : { inputDetail }),
		...(outputDetail === undefined ? {} : { outputDetail }),
		...(result === undefined ? {} : { result }),
	};
}

function defaultSummary(event: TelemetryEvent): string {
	const terminal = event.state === undefined ? "updated" : event.state.replaceAll("_", " ");
	switch (event.kind) {
		case "agent.run":
			return event.phase === "start" ? "Agent run started" : `Agent run ${terminal}`;
		case "agent.turn":
			return event.phase === "start" ? "Agent Turn started" : `Agent Turn ${terminal}`;
		case "user.message":
			return "User message";
		case "model.response":
			return event.phase === "start" ? "Model response started" : `Model response ${terminal}`;
		case "tool.execution": {
			const tool = stringAttribute(event.attributes, "tool_name") ?? "Tool";
			return event.phase === "start" ? `${tool} started` : `${tool} ${terminal}`;
		}
		case "tool.result": {
			const tool = stringAttribute(event.attributes, "tool_name") ?? "Tool";
			return `${tool} result ${terminal}`;
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
	identityReuse = false,
): TelemetryTrajectoryRecord {
	return {
		id: attemptRecordId(key, event, identityReuse),
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
		...detailFields(event.attributes),
		attemptOrdinal: ordinal,
		attemptOrdinalKnown: false,
		closureUnknown: false,
		gapTainted: false,
		gapEvidence: [],
		identityReuse,
		terminalConflict: identityReuse,
		unmatchedTerminal: false,
		diagnostic: diagnosticEvidence([event], identityReuse),
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
	const attributes = mergedAttributes(events);
	return {
		...record,
		attributes,
		...detailFields(attributes),
		diagnostic: diagnosticEvidence(
			events,
			record.diagnostic || record.identityReuse || record.terminalConflict,
		),
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
		...detailFields(attributes),
		closureUnknown: false,
		gapTainted: false,
		gapEvidence: [],
		terminalConflict: record.identityReuse,
		unmatchedTerminal: false,
		diagnostic: diagnosticEvidence(evidence, record.identityReuse),
		...attemptEvidenceFields(evidence),
		phase: "end",
		...(event.state === undefined ? {} : { state: event.state }),
		endedAt: event.observed_at,
		...(toolName === undefined ? {} : { toolName }),
	};
}

function settleGapTaintedAttempt(
	record: TelemetryTrajectoryRecord,
	event: TelemetryEvent,
): TelemetryTrajectoryRecord {
	const gapEvidence = record.gapEvidence;
	const gapCount = record.gapCount;
	const gapEvidenceTruncated = record.gapEvidenceTruncated;
	return {
		...settleAttempt(record, event),
		closureUnknown: false,
		gapTainted: true,
		gapEvidence,
		...(gapCount === undefined ? {} : { gapCount }),
		...(gapEvidenceTruncated === undefined ? {} : { gapEvidenceTruncated }),
		diagnostic: true,
	};
}

function reconcileTerminalBeforeStart(
	record: TelemetryTrajectoryRecord,
	start: TelemetryEvent,
): TelemetryTrajectoryRecord {
	const terminal = record.sourceEnvelopes.find((event) => event.phase === "end");
	if (terminal === undefined) return record;
	const evidence = [...record.sourceEnvelopes, start].sort((left, right) =>
		left.sequence === right.sequence
			? compareText(left.event_id, right.event_id)
			: left.sequence - right.sequence,
	);
	const attributes = mergedAttributes(evidence);
	const normalizedTerminal = { ...terminal, attributes };
	const toolName = stringAttribute(attributes, "tool_name");
	const startTime = Date.parse(start.observed_at);
	const terminalTime = Date.parse(terminal.observed_at);
	const temporalOrderConflict = startTime > terminalTime;
	const reconciled: TelemetryTrajectoryRecord = {
		...record,
		kind: recordKind(normalizedTerminal),
		...eventSummary(normalizedTerminal),
		sequence: Math.min(...evidence.map((event) => event.sequence)),
		durationMs: recordedDuration(terminal),
		isOpen: false,
		isError: eventIsError(normalizedTerminal),
		severity: terminal.severity,
		attributes,
		...detailFields(attributes),
		closureUnknown: false,
		gapTainted: false,
		gapEvidence: [],
		identityReuse: false,
		terminalConflict: false,
		unmatchedTerminal: false,
		diagnostic: true,
		...(temporalOrderConflict ? { temporalOrderConflict: true } : {}),
		...attemptEvidenceFields(evidence),
		phase: "end",
		...(terminal.state === undefined ? {} : { state: terminal.state }),
		...(temporalOrderConflict
			? {}
			: { startedAt: start.observed_at, endedAt: terminal.observed_at }),
		...(toolName === undefined ? {} : { toolName }),
	};
	if (!temporalOrderConflict) return reconciled;
	const {
		startedAt: ignoredStartedAt,
		endedAt: ignoredEndedAt,
		...withoutConventionalTiming
	} = reconciled;
	void ignoredStartedAt;
	void ignoredEndedAt;
	return withoutConventionalTiming;
}

function terminalOnlyAttempt(
	event: TelemetryEvent,
	key: string,
	ordinal: number,
	tracker: AttemptTracker,
	gapSummary: GapEvidenceSummary,
	identityReuse = false,
): TelemetryTrajectoryRecord {
	const closureUnknown = gapSummary.count > 0;
	const terminalConflict = !closureUnknown && (tracker.hasSettledAttempt || identityReuse);
	const state = closureUnknown
		? "closure_unknown"
		: terminalConflict
			? "conflict"
			: "unmatched_terminal";
	const toolName = stringAttribute(event.attributes, "tool_name");
	return {
		id: attemptRecordId(key, event, identityReuse),
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
		...detailFields(event.attributes),
		attemptOrdinal: ordinal,
		attemptOrdinalKnown: false,
		closureUnknown,
		gapTainted: closureUnknown,
		gapEvidence: gapSummary.evidence,
		gapCount: gapSummary.count,
		...(gapSummary.truncated ? { gapEvidenceTruncated: true } : {}),
		identityReuse,
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
	const thinkingDetail = event.kind === "provider.thinking"
		? detailValue(event.attributes.content)
		: undefined;
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
		...detailFields(event.attributes),
		attemptOrdinalKnown: false,
		closureUnknown: false,
		gapTainted: false,
		gapEvidence: [],
		identityReuse: false,
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
		...(thinkingDetail === undefined ? {} : { thinkingDetail }),
		...(toolName === undefined ? {} : { toolName }),
	};
}

function unidentifiedLifecycleRecord(event: TelemetryEvent): TelemetryTrajectoryRecord {
	const record = standaloneEventRecord(event);
	if (event.phase === "start") {
		return {
			...record,
			state: "unmatched_start",
			closureUnknown: true,
			diagnostic: true,
		};
	}
	return {
		...record,
		state: "unmatched_terminal",
		unmatchedTerminal: true,
		diagnostic: true,
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

function summarizeGapEvidence(
	gaps: readonly TelemetryReplayGap[],
	startIndex: number,
): GapEvidenceSummary {
	const count = Math.max(0, gaps.length - startIndex);
	if (count <= MAX_INLINE_GAP_EVIDENCE) {
		return {
			evidence: gaps.slice(startIndex),
			count,
			truncated: false,
		};
	}
	return {
		evidence: [
			...gaps.slice(startIndex, startIndex + INLINE_GAP_HEAD),
			...gaps.slice(gaps.length - INLINE_GAP_TAIL),
		],
		count,
		truncated: true,
	};
}

function withGapEvidence(
	record: TelemetryTrajectoryRecord,
	summary: GapEvidenceSummary,
): TelemetryTrajectoryRecord {
	return {
		...record,
		gapTainted: summary.count > 0,
		gapEvidence: summary.evidence,
		gapCount: summary.count,
		...(summary.truncated ? { gapEvidenceTruncated: true } : {}),
	};
}

function markGapBoundary(
	record: TrajectoryRecord,
	summary: GapEvidenceSummary,
): TrajectoryRecord {
	if (record.kind === "GAP") return record;
	return {
		...withGapEvidence(record, summary),
		isOpen: false,
		closureUnknown: true,
		state: "closure_unknown",
		diagnostic: true,
	};
}

function disambiguateRecordIds(
	records: readonly TrajectoryRecord[],
): TrajectoryRecord[] {
	const used = new Set<string>();
	return records.map((record) => {
		if (!used.has(record.id)) {
			used.add(record.id);
			return record;
		}
		const evidenceId = record.kind === "GAP"
			? gapRecordId(record.gap)
			: record.sourceEventIds[0] ?? `sequence:${record.sequence}`;
		let id = `${record.id}|collision:${identityPart(evidenceId)}|sequence:${record.sequence}`;
		let collision = 1;
		while (used.has(id)) {
			collision += 1;
			id = `${record.id}|collision:${identityPart(evidenceId)}|sequence:${record.sequence}|${collision}`;
		}
		used.add(id);
		if (record.kind === "GAP") return { ...record, id };
		return {
			...record,
			id,
			identityReuse: true,
			terminalConflict: true,
			diagnostic: true,
		};
	});
}

function projectAttemptRecords(inputs: readonly OrderedInput[]): readonly TrajectoryRecord[] {
	const output: TrajectoryRecord[] = [];
	const trackers = new Map<string, AttemptTracker>();
	const ordinalCounters = new Map<string, number>();
	const openTrackers = new Set<AttemptTracker>();
	const uncertainTrackers = new Set<AttemptTracker>();
	const pendingTerminalTrackers = new Set<AttemptTracker>();
	const gaps: TelemetryReplayGap[] = [];

	for (const input of inputs) {
		if (input.type === "gap") {
			output.push(gapRecord(input.gap));
			gaps.push(input.gap);
			for (const tracker of openTrackers) {
				const open = tracker.open;
				if (open === undefined) continue;
				tracker.uncertainGapStartIndex = tracker.lastGapIndexSeen;
				const gapSummary = summarizeGapEvidence(
					gaps,
					tracker.uncertainGapStartIndex,
				);
				const record = output[open.recordIndex];
				if (record !== undefined && record.kind !== "GAP") {
					output[open.recordIndex] = markGapBoundary(
						mergeOpenAttemptEvidence(record, open.events),
						gapSummary,
					);
				}
				tracker.uncertainRecordIndex = open.recordIndex;
				tracker.open = undefined;
				tracker.hasSettledAttempt = true;
				uncertainTrackers.add(tracker);
			}
			openTrackers.clear();
			for (const tracker of pendingTerminalTrackers) {
				tracker.pendingTerminalRecordIndex = undefined;
			}
			pendingTerminalTrackers.clear();
			continue;
		}

		const event = input.event;
		if (!SUPPORTED_EVENT_KINDS.has(event.kind)) continue;
		const key = lifecycleKey(event);
		if (key === undefined) {
			if (
				(event.kind === "agent.run" ||
					event.kind === "agent.turn" ||
					event.kind === "tool.execution") &&
				(event.phase === "start" || event.phase === "end")
			) {
				output.push(unidentifiedLifecycleRecord(event));
			} else {
				output.push(standaloneEventRecord(event));
			}
			continue;
		}
		if (event.phase !== "start" && event.phase !== "end") {
			output.push(standaloneEventRecord(event));
			continue;
		}

		let tracker = trackers.get(key);
		if (tracker === undefined) {
			tracker = {
				lastGapIndexSeen: 0,
				hasSettledAttempt: false,
			};
			trackers.set(key, tracker);
		}
		if (
			event.kind === "tool.execution" &&
			tracker.uncertainRecordIndex !== undefined
		) {
			const recordIndex = tracker.uncertainRecordIndex;
			const current = output[recordIndex];
			const record = current !== undefined && current.kind !== "GAP"
				? withGapEvidence(
					current,
					summarizeGapEvidence(
						gaps,
						tracker.uncertainGapStartIndex ?? tracker.lastGapIndexSeen,
					),
				)
				: current;
			if (record !== undefined && record.kind !== "GAP") {
				if (event.phase === "start") {
					const reopened = mergeOpenAttemptEvidence(
							record,
							[...record.sourceEnvelopes, event],
						);
					output[recordIndex] = {
						...reopened,
						kind: recordKind(event),
						...eventSummary(event),
						isOpen: true,
						closureUnknown: false,
						gapTainted: true,
						gapEvidence: record.gapEvidence,
						phase: "start",
						state: event.state ?? "running",
						diagnostic: true,
					};
					tracker.lastGapIndexSeen = gaps.length;
					continue;
				}
				output[recordIndex] = settleGapTaintedAttempt(record, event);
			}
			tracker.uncertainRecordIndex = undefined;
			tracker.uncertainGapStartIndex = undefined;
			tracker.hasSettledAttempt = true;
			tracker.lastGapIndexSeen = gaps.length;
			uncertainTrackers.delete(tracker);
			continue;
		}
		if (tracker.uncertainRecordIndex !== undefined) {
			const recordIndex = tracker.uncertainRecordIndex;
			const record = output[recordIndex];
			if (record !== undefined && record.kind !== "GAP") {
				output[recordIndex] = withGapEvidence(
					record,
					summarizeGapEvidence(
						gaps,
						tracker.uncertainGapStartIndex ?? tracker.lastGapIndexSeen,
					),
				);
			}
			tracker.uncertainRecordIndex = undefined;
			tracker.uncertainGapStartIndex = undefined;
			uncertainTrackers.delete(tracker);
		}

		if (event.phase === "start") {
			if (tracker.pendingTerminalRecordIndex !== undefined) {
				const recordIndex = tracker.pendingTerminalRecordIndex;
				const record = output[recordIndex];
				if (record !== undefined && record.kind !== "GAP") {
					output[recordIndex] = reconcileTerminalBeforeStart(record, event);
				}
				tracker.pendingTerminalRecordIndex = undefined;
				pendingTerminalTrackers.delete(tracker);
				tracker.hasSettledAttempt = true;
				tracker.lastGapIndexSeen = gaps.length;
				continue;
			}
			if (tracker.open !== undefined) {
				tracker.open.events.push(event);
				continue;
			}
			const ordinalKey = ordinalLifecycleKey(event) ?? key;
			const ordinal = (ordinalCounters.get(ordinalKey) ?? 0) + 1;
			ordinalCounters.set(ordinalKey, ordinal);
			const identityReuse = tracker.hasSettledAttempt;
			const recordIndex = output.push(
				openAttemptRecord(event, key, ordinal, identityReuse),
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

		if (tracker.pendingTerminalRecordIndex !== undefined) {
			tracker.pendingTerminalRecordIndex = undefined;
			pendingTerminalTrackers.delete(tracker);
		}

		const ordinalKey = ordinalLifecycleKey(event) ?? key;
		const ordinal = (ordinalCounters.get(ordinalKey) ?? 0) + 1;
		ordinalCounters.set(ordinalKey, ordinal);
		const relevantGaps = summarizeGapEvidence(gaps, tracker.lastGapIndexSeen);
		const identityReuse = tracker.hasSettledAttempt;
		const recordIndex = output.push(terminalOnlyAttempt(
			event,
			key,
			ordinal,
			tracker,
			relevantGaps,
			identityReuse,
		)) - 1;
		if (!identityReuse && relevantGaps.count === 0) {
			tracker.pendingTerminalRecordIndex = recordIndex;
			pendingTerminalTrackers.add(tracker);
		}
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
	for (const tracker of uncertainTrackers) {
		const recordIndex = tracker.uncertainRecordIndex;
		if (recordIndex === undefined) continue;
		const record = output[recordIndex];
		if (record === undefined || record.kind === "GAP") continue;
		output[recordIndex] = withGapEvidence(
			record,
			summarizeGapEvidence(
				gaps,
				tracker.uncertainGapStartIndex ?? tracker.lastGapIndexSeen,
			),
		);
	}

	return disambiguateRecordIds(output)
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

/**
 * Replace only selected row envelopes returned by exact-ID reads, then rerun
 * projection for detail fields. Row identity, grouping, timing, and gap state
 * remain owned by the bounded ledger projection.
 */
export function hydrateTrajectoryRecordDetail(
	record: TelemetryTrajectoryRecord,
	exactEvents: readonly TelemetryEvent[],
): TelemetryTrajectoryRecord {
	if (exactEvents.length === 0 || record.sourceEnvelopes.length === 0) return record;
	const sourceIds = new Set(record.sourceEventIds);
	const replacements = new Map(
		exactEvents
			.filter((event) => sourceIds.has(event.event_id))
			.map((event) => [event.event_id, event] as const),
	);
	if (replacements.size === 0) return record;
	const envelopes = record.sourceEnvelopes.map(
		(event) => replacements.get(event.event_id) ?? event,
	);
	const candidates = flattenTrajectoryRecords(projectTrajectory(envelopes));
	const hydrated = candidates.find(
		(candidate): candidate is TelemetryTrajectoryRecord =>
			candidate.kind !== "GAP" &&
			(candidate.id === record.id ||
				(candidate.sourceEventIds.length === record.sourceEventIds.length &&
					candidate.sourceEventIds.every(
						(eventId, index) => eventId === record.sourceEventIds[index],
					))),
	);
	if (hydrated === undefined) return record;
	return {
		...record,
		attributes: hydrated.attributes,
		sourceEnvelopes: hydrated.sourceEnvelopes,
		inputDetail: hydrated.inputDetail,
		outputDetail: hydrated.outputDetail,
		thinkingDetail: hydrated.thinkingDetail,
		schemaDetail: hydrated.schemaDetail,
		result: hydrated.result,
		privacyClass: hydrated.privacyClass,
		privacyIncomplete: hydrated.privacyIncomplete,
		payloadRefs: hydrated.payloadRefs,
		redaction: hydrated.redaction,
	};
}
