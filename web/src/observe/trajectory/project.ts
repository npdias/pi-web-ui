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

interface LifecycleEvidence {
	readonly starts: TelemetryEvent[];
	readonly terminals: TelemetryEvent[];
}

interface SettledTool extends LifecycleEvidence {
	readonly index: number;
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
	const toolCallId = event.correlation?.tool_call_id;
	if (event.kind === "tool.execution" && toolCallId !== undefined) {
		return `tool:${scopedIdentity(event.source, event.correlation, toolCallId)}`;
	}
	return event.event_id.length > 0
		? `event:${event.event_id}`
		: `sequence:${event.sequence}`;
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

function lifecycleEvidence(inputs: readonly OrderedInput[]): ReadonlyMap<string, LifecycleEvidence> {
	const evidence = new Map<string, LifecycleEvidence>();
	for (const input of inputs) {
		if (input.type !== "event") continue;
		const key = lifecycleKey(input.event);
		if (key === undefined) continue;
		let entry = evidence.get(key);
		if (entry === undefined) {
			entry = { starts: [], terminals: [] };
			evidence.set(key, entry);
		}
		if (input.event.phase === "start") entry.starts.push(input.event);
		if (input.event.phase === "end") entry.terminals.push(input.event);
	}
	return evidence;
}

function terminalEvidenceIndex(
	inputs: readonly OrderedInput[],
): {
	readonly byEventId: ReadonlyMap<string, LifecycleEvidence>;
	readonly conflicts: ReadonlyMap<string, LifecycleEvidence>;
} {
	interface Tracker {
		readonly activeStarts: TelemetryEvent[];
		lastSettlement?: LifecycleEvidence;
	}
	const trackers = new Map<string, Tracker>();
	const byEventId = new Map<string, LifecycleEvidence>();
	const conflicts = new Map<string, LifecycleEvidence>();
	for (const input of inputs) {
		if (
			input.type !== "event" ||
			(input.event.kind !== "agent.run" && input.event.kind !== "agent.turn")
		) {
			continue;
		}
		const key = lifecycleKey(input.event);
		if (key === undefined) continue;
		let tracker = trackers.get(key);
		if (tracker === undefined) {
			tracker = { activeStarts: [] };
			trackers.set(key, tracker);
		}
		if (input.event.phase === "start") {
			tracker.activeStarts.push(input.event);
			continue;
		}
		if (input.event.phase !== "end") continue;
		if (tracker.activeStarts.length > 0) {
			const settlement = {
				starts: tracker.activeStarts.splice(0),
				terminals: [input.event],
			};
			tracker.lastSettlement = settlement;
			byEventId.set(input.event.event_id, settlement);
			continue;
		}
		if (tracker.lastSettlement === undefined) {
			const settlement = { starts: [], terminals: [input.event] };
			tracker.lastSettlement = settlement;
			byEventId.set(input.event.event_id, settlement);
			continue;
		}
		tracker.lastSettlement.terminals.push(input.event);
		const conflict = {
			starts: [...tracker.lastSettlement.starts],
			terminals: [...tracker.lastSettlement.terminals],
		};
		byEventId.set(input.event.event_id, conflict);
		conflicts.set(input.event.event_id, conflict);
	}
	return { byEventId, conflicts };
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

const SEVERITY_ORDER: Readonly<Record<TelemetryEvent["severity"], number>> = {
	debug: 0,
	info: 1,
	warning: 2,
	error: 3,
	critical: 4,
};

function highestSeverity(events: readonly TelemetryEvent[]): TelemetryEvent["severity"] {
	let severity: TelemetryEvent["severity"] = "debug";
	for (const event of events) {
		if (SEVERITY_ORDER[event.severity] > SEVERITY_ORDER[severity]) {
			severity = event.severity;
		}
	}
	if (events.some(eventIsError) && SEVERITY_ORDER[severity] < SEVERITY_ORDER.error) {
		return "error";
	}
	return severity;
}

function conflictKind(
	eventKind: string,
	terminals: readonly TelemetryEvent[],
): Exclude<TrajectoryRecordKind, "GAP"> {
	if (terminals.some(eventIsError)) return "ERROR";
	if (
		terminals.some((event) =>
			event.state === "cancelled" ||
			event.state === "aborted" ||
			event.state === "forced_reset")
	) {
		return "CANCELLED";
	}
	if (eventKind === "agent.turn") return "RESULT";
	if (eventKind === "tool.execution") return "TOOL";
	return "SYSTEM";
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
	"payloadRefs" | "privacyClass" | "redaction" | "sourceEnvelopes"
> {
	const sourceEnvelopes = [...events].sort((left, right) =>
		left.sequence === right.sequence
			? compareText(left.event_id, right.event_id)
			: left.sequence - right.sequence,
	);
	const payloadRefs: string[] = [];
	const seenPayloadRefs = new Set<string>();
	for (const event of sourceEnvelopes) {
		const payloadRef = event.payload_ref;
		if (payloadRef === undefined || seenPayloadRefs.has(payloadRef)) continue;
		seenPayloadRefs.add(payloadRef);
		payloadRefs.push(payloadRef);
	}
	const privacyClass = strictestPrivacyClass(sourceEnvelopes);
	const redaction = aggregateRedaction(sourceEnvelopes);
	return {
		sourceEnvelopes,
		payloadRefs,
		...(privacyClass === undefined ? {} : { privacyClass }),
		...(redaction === undefined ? {} : { redaction }),
	};
}

function closedSpanKeys(inputs: readonly OrderedInput[]): {
	runs: ReadonlyMap<string, readonly number[]>;
	turns: ReadonlyMap<string, readonly number[]>;
	tools: ReadonlyMap<string, readonly number[]>;
} {
	const runs = new Map<string, number[]>();
	const turns = new Map<string, number[]>();
	const tools = new Map<string, number[]>();
	const append = (map: Map<string, number[]>, key: string, sequence: number) => {
		const sequences = map.get(key) ?? [];
		sequences.push(sequence);
		map.set(key, sequences);
	};
	for (const input of inputs) {
		if (input.type !== "event" || input.event.phase !== "end") continue;
		if (input.event.kind === "agent.run" && input.event.correlation?.trace_id) {
			const key = scopedIdentity(
				input.event.source,
				input.event.correlation,
				input.event.correlation.trace_id,
			);
			append(runs, key, input.event.sequence);
		}
		if (input.event.kind === "agent.turn" && input.event.correlation?.turn_id) {
			const key = scopedIdentity(
				input.event.source,
				input.event.correlation,
				input.event.correlation.turn_id,
			);
			append(turns, key, input.event.sequence);
		}
		if (input.event.kind === "tool.execution" && input.event.correlation?.tool_call_id) {
			const key = scopedIdentity(
				input.event.source,
				input.event.correlation,
				input.event.correlation.tool_call_id,
			);
			append(tools, key, input.event.sequence);
		}
	}
	return { runs, turns, tools };
}

function nextTerminalSequence(
	event: TelemetryEvent,
	closed: ReturnType<typeof closedSpanKeys>,
): number | undefined {
	if (event.phase !== "start") return undefined;
	let sequences: readonly number[] | undefined;
	if (event.kind === "agent.run") {
		const id = event.correlation?.trace_id;
		if (id !== undefined) {
			sequences = closed.runs.get(scopedIdentity(event.source, event.correlation, id));
		}
	} else if (event.kind === "agent.turn") {
		const id = event.correlation?.turn_id;
		if (id !== undefined) {
			sequences = closed.turns.get(scopedIdentity(event.source, event.correlation, id));
		}
	} else if (event.kind === "tool.execution") {
		const id = event.correlation?.tool_call_id;
		if (id !== undefined) {
			sequences = closed.tools.get(scopedIdentity(event.source, event.correlation, id));
		}
	}
	return sequences?.find((sequence) => sequence > event.sequence);
}

function gapEvidenceForSpan(
	startSequence: number,
	terminalSequence: number | undefined,
	gaps: readonly TelemetryReplayGap[],
): readonly TelemetryReplayGap[] {
	return gaps.filter(
		(gap) =>
			gap.resume_after > startSequence &&
			(terminalSequence === undefined || gap.resume_after < terminalSequence),
	);
}

function spanStatus(
	event: TelemetryEvent,
	closed: ReturnType<typeof closedSpanKeys>,
	gaps: readonly TelemetryReplayGap[],
	terminalSequence = nextTerminalSequence(event, closed),
): Pick<
	TelemetryTrajectoryRecord,
	"closureUnknown" | "gapEvidence" | "gapTainted" | "isOpen"
> {
	if (
		event.phase !== "start" ||
		(event.kind !== "agent.run" &&
			event.kind !== "agent.turn" &&
			event.kind !== "tool.execution")
	) {
		return {
			closureUnknown: false,
			gapEvidence: [],
			gapTainted: false,
			isOpen: false,
		};
	}
	const gapEvidence = gapEvidenceForSpan(event.sequence, terminalSequence, gaps);
	const closureUnknown = terminalSequence === undefined && gapEvidence.length > 0;
	return {
		closureUnknown,
		gapEvidence,
		gapTainted: gapEvidence.length > 0,
		isOpen: terminalSequence === undefined && !closureUnknown,
	};
}

function terminalSpanStatus(
	event: TelemetryEvent,
	evidence: LifecycleEvidence | undefined,
	gaps: readonly TelemetryReplayGap[],
): Pick<
	TelemetryTrajectoryRecord,
	"closureUnknown" | "gapEvidence" | "gapTainted" | "isOpen"
> {
	if (event.phase !== "end" || evidence === undefined) {
		return {
			closureUnknown: false,
			gapEvidence: [],
			gapTainted: false,
			isOpen: false,
		};
	}
	const start = evidence.starts.find((candidate) => candidate.sequence < event.sequence);
	const gapEvidence = start === undefined
		? []
		: gapEvidenceForSpan(start.sequence, event.sequence, gaps);
	return {
		closureUnknown: false,
		gapEvidence,
		gapTainted: gapEvidence.length > 0,
		isOpen: false,
	};
}

function eventRecord(
	event: TelemetryEvent,
	closed: ReturnType<typeof closedSpanKeys>,
	gaps: readonly TelemetryReplayGap[],
	evidence?: LifecycleEvidence,
): TelemetryTrajectoryRecord {
	const thinkingDetail =
		event.kind === "provider.thinking"
			? stringAttribute(event.attributes, "content")
			: undefined;
	const toolName =
		event.kind === "tool.execution"
			? stringAttribute(event.attributes, "tool_name")
			: undefined;
	return {
		id: eventRecordId(event),
		index: 0,
		kind: recordKind(event),
		sequence: event.sequence,
		...eventSummary(event),
		durationMs: recordedDuration(event),
		...(event.phase === "end"
			? terminalSpanStatus(event, evidence, gaps)
			: spanStatus(event, closed, gaps)),
		isError: eventIsError(event),
		sourceEventIds: [event.event_id],
		sourceSequences: [event.sequence],
		eventKind: event.kind,
		severity: event.severity,
		source: event.source,
		attributes: event.attributes,
		terminalConflict: false,
		...aggregateEnvelopeEvidence([event]),
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

function conflictingTerminalRecord(
	id: string,
	eventKind: string,
	evidence: LifecycleEvidence,
	gaps: readonly TelemetryReplayGap[],
	recordSequence?: number,
): TelemetryTrajectoryRecord {
	const sourceEvents = [...evidence.starts, ...evidence.terminals].sort(
		(left, right) => left.sequence - right.sequence,
	);
	const first = evidence.starts[0] ?? evidence.terminals[0];
	const latestTerminal = evidence.terminals.at(-1);
	if (first === undefined || latestTerminal === undefined) {
		throw new Error("conflicting terminal evidence requires source events");
	}
	const attributes: Record<string, TelemetryJson> = {};
	for (const event of sourceEvents) Object.assign(attributes, event.attributes);
	const toolName = stringAttribute(attributes, "tool_name");
	const start = evidence.starts[0];
	const gapEvidence = start === undefined
		? []
		: gapEvidenceForSpan(start.sequence, latestTerminal.sequence, gaps);
	return {
		id,
		index: 0,
		kind: conflictKind(eventKind, evidence.terminals),
		sequence: recordSequence ?? first.sequence,
		summary: `Conflicting ${eventKind} terminal evidence`,
		durationMs: null,
		isOpen: false,
		isError: evidence.terminals.some(eventIsError),
		sourceEventIds: sourceEvents.map((event) => event.event_id),
		sourceSequences: sourceEvents.map((event) => event.sequence),
		eventKind,
		phase: "end",
		state: "conflict",
		severity: highestSeverity(evidence.terminals),
		source: first.source,
		attributes,
		closureUnknown: false,
		gapEvidence,
		gapTainted: gapEvidence.length > 0,
		terminalConflict: true,
		...aggregateEnvelopeEvidence(sourceEvents),
		...(first.correlation === undefined ? {} : { correlation: first.correlation }),
		...scopeFields(first.correlation),
		...(start === undefined ? {} : { startedAt: start.observed_at }),
		endedAt: latestTerminal.observed_at,
		...(toolName === undefined ? {} : { toolName }),
	};
}

function pairedToolRecord(
	starts: readonly TelemetryEvent[],
	end: TelemetryEvent,
	closed: ReturnType<typeof closedSpanKeys>,
	gaps: readonly TelemetryReplayGap[],
): TelemetryTrajectoryRecord {
	const start = starts[0];
	if (start === undefined) return eventRecord(end, closed, gaps);
	const mergedAttributes: Record<string, TelemetryJson> = {};
	for (const candidate of starts) Object.assign(mergedAttributes, candidate.attributes);
	Object.assign(mergedAttributes, end.attributes);
	const terminal = { ...end, attributes: mergedAttributes };
	const toolName = stringAttribute(mergedAttributes, "tool_name");
	const summary = end.summary ?? start.summary;
	return {
		id: eventRecordId(start),
		index: 0,
		kind: recordKind(terminal),
		sequence: start.sequence,
		...eventSummary(summary === undefined ? terminal : { ...terminal, summary }),
		durationMs: recordedDuration(end),
		...spanStatus(start, closed, gaps, end.sequence),
		isError: eventIsError(terminal),
		sourceEventIds: [...starts.map((candidate) => candidate.event_id), end.event_id],
		sourceSequences: [...starts.map((candidate) => candidate.sequence), end.sequence],
		eventKind: start.kind,
		severity: end.severity,
		source: start.source,
		attributes: mergedAttributes,
		terminalConflict: false,
		...aggregateEnvelopeEvidence([...starts, end]),
		...(end.phase === undefined ? {} : { phase: end.phase }),
		...(end.state === undefined ? {} : { state: end.state }),
		...(start.correlation === undefined ? {} : { correlation: start.correlation }),
		...scopeFields(start.correlation),
		startedAt: start.observed_at,
		endedAt: end.observed_at,
		...(toolName === undefined ? {} : { toolName }),
	};
}

function gapRecord(gap: TelemetryReplayGap): GapTrajectoryRecord {
	return {
		id: gapRecordId(gap),
		index: 0,
		kind: "GAP",
		sequence: gap.resume_after,
		summary:
			gap.earliest_available === null
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

function appendSourceEvidence(
	record: TrajectoryRecord,
	event: TelemetryEvent,
): TrajectoryRecord {
	if (record.kind === "GAP") return record;
	const evidence = [...record.sourceEnvelopes, event];
	return {
		...record,
		sourceEventIds: evidence.map((candidate) => candidate.event_id),
		sourceSequences: evidence.map((candidate) => candidate.sequence),
		...aggregateEnvelopeEvidence(evidence),
	};
}

function projectRecords(inputs: readonly OrderedInput[]): readonly TrajectoryRecord[] {
	const closed = closedSpanKeys(inputs);
	const gaps = inputs.flatMap((input) => input.type === "gap" ? [input.gap] : []);
	const lifecycles = lifecycleEvidence(inputs);
	const terminalEvidence = terminalEvidenceIndex(inputs);
	const output: TrajectoryRecord[] = [];
	const openTools = new Map<
		string,
		{ readonly index: number; readonly starts: TelemetryEvent[] }
	>();
	const settledTools = new Map<string, SettledTool>();

	for (const input of inputs) {
		if (input.type === "gap") {
			output.push(gapRecord(input.gap));
			continue;
		}
		const event = input.event;
		if (!SUPPORTED_EVENT_KINDS.has(event.kind)) continue;
		if (event.kind !== "tool.execution") {
			const key = lifecycleKey(event);
			const evidence = event.phase === "end"
				? terminalEvidence.byEventId.get(event.event_id)
				: key === undefined
					? undefined
					: lifecycles.get(key);
			const conflictEvidence = terminalEvidence.conflicts.get(event.event_id);
			if (conflictEvidence !== undefined) {
				output.push(conflictingTerminalRecord(
					eventRecordId(event),
					event.kind,
					conflictEvidence,
					gaps,
					event.sequence,
				));
				continue;
			}
			output.push(eventRecord(event, closed, gaps, evidence));
			continue;
		}
		const callId = event.correlation?.tool_call_id;
		if (event.phase === "start") {
			const key =
				callId === undefined
					? undefined
					: scopedIdentity(event.source, event.correlation, callId);
			const existing = key === undefined ? undefined : openTools.get(key);
			if (existing !== undefined) {
				existing.starts.push(event);
				const current = output[existing.index];
				if (current !== undefined) {
					output[existing.index] = appendSourceEvidence(current, event);
				}
				continue;
			}
			const settled = key === undefined ? undefined : settledTools.get(key);
			if (settled !== undefined) {
				settled.starts.push(event);
				const record = output[settled.index];
				if (record !== undefined) {
					output[settled.index] = settled.terminals.length > 1
						? conflictingTerminalRecord(
							eventRecordId(event),
							event.kind,
							settled,
							gaps,
						)
						: appendSourceEvidence(record, event);
				}
				continue;
			}
			const index = output.push(eventRecord(event, closed, gaps)) - 1;
			if (key !== undefined) {
				openTools.set(key, { index, starts: [event] });
			}
			continue;
		}
		if (event.phase === "end" && callId !== undefined) {
			const key = scopedIdentity(event.source, event.correlation, callId);
			const open = openTools.get(key);
			openTools.delete(key);
			if (open !== undefined) {
				output[open.index] = pairedToolRecord(open.starts, event, closed, gaps);
				settledTools.set(key, {
					index: open.index,
					starts: open.starts,
					terminals: [event],
				});
				continue;
			}
			const settled = settledTools.get(key);
			if (settled !== undefined) {
				settled.terminals.push(event);
				const record = output[settled.index];
				if (record !== undefined) {
					output[settled.index] = conflictingTerminalRecord(
						record.id,
						event.kind,
						settled,
						gaps,
					);
				}
				continue;
			}
		}
		const evidenceKey = lifecycleKey(event);
		const evidence = evidenceKey === undefined ? undefined : lifecycles.get(evidenceKey);
		const index = output.push(eventRecord(event, closed, gaps, evidence)) - 1;
		if (event.phase === "end" && callId !== undefined) {
			settledTools.set(scopedIdentity(event.source, event.correlation, callId), {
				index,
				starts: [],
				terminals: [event],
			});
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
		if (record.kind === "GAP" || record.phase !== "start") continue;
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
	return groupRecords(withParents(projectRecords(normalized)));
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
