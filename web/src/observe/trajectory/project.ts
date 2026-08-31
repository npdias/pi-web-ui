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

function closedSpanKeys(inputs: readonly OrderedInput[]): {
	runs: ReadonlyMap<string, number>;
	turns: ReadonlyMap<string, number>;
} {
	const runs = new Map<string, number>();
	const turns = new Map<string, number>();
	for (const input of inputs) {
		if (input.type !== "event" || input.event.phase !== "end") continue;
		if (input.event.kind === "agent.run" && input.event.correlation?.trace_id) {
			const key = scopedIdentity(
				input.event.source,
				input.event.correlation,
				input.event.correlation.trace_id,
			);
			runs.set(key, Math.max(runs.get(key) ?? 0, input.event.sequence));
		}
		if (input.event.kind === "agent.turn" && input.event.correlation?.turn_id) {
			const key = scopedIdentity(
				input.event.source,
				input.event.correlation,
				input.event.correlation.turn_id,
			);
			turns.set(key, Math.max(turns.get(key) ?? 0, input.event.sequence));
		}
	}
	return { runs, turns };
}

function isOpenEvent(
	event: TelemetryEvent,
	closed: ReturnType<typeof closedSpanKeys>,
): boolean {
	if (event.phase !== "start") return false;
	if (event.kind === "agent.run") {
		const id = event.correlation?.trace_id;
		if (id === undefined) return true;
		const endSequence = closed.runs.get(scopedIdentity(event.source, event.correlation, id));
		return endSequence === undefined || endSequence < event.sequence;
	}
	if (event.kind === "agent.turn") {
		const id = event.correlation?.turn_id;
		if (id === undefined) return true;
		const endSequence = closed.turns.get(scopedIdentity(event.source, event.correlation, id));
		return endSequence === undefined || endSequence < event.sequence;
	}
	return event.kind === "tool.execution";
}

function eventRecord(
	event: TelemetryEvent,
	closed: ReturnType<typeof closedSpanKeys>,
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
		isOpen: isOpenEvent(event, closed),
		isError: eventIsError(event),
		sourceEventIds: [event.event_id],
		sourceSequences: [event.sequence],
		eventKind: event.kind,
		severity: event.severity,
		source: event.source,
		attributes: event.attributes,
		...(event.phase === undefined ? {} : { phase: event.phase }),
		...(event.state === undefined ? {} : { state: event.state }),
		...(event.correlation === undefined ? {} : { correlation: event.correlation }),
		...scopeFields(event.correlation),
		...(event.phase === "start" ? { startedAt: event.observed_at } : {}),
		...(event.phase === "end" ? { endedAt: event.observed_at } : {}),
		...(thinkingDetail === undefined ? {} : { thinkingDetail }),
		...(toolName === undefined ? {} : { toolName }),
		...(event.privacy_class === undefined
			? {}
			: { privacyClass: event.privacy_class }),
		...(event.payload_ref === undefined ? {} : { payloadRef: event.payload_ref }),
		...(event.redaction === undefined ? {} : { redaction: event.redaction }),
	};
}

function pairedToolRecord(
	starts: readonly TelemetryEvent[],
	end: TelemetryEvent,
): TelemetryTrajectoryRecord {
	const start = starts[0];
	if (start === undefined) return eventRecord(end, { runs: new Map(), turns: new Map() });
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
		isOpen: false,
		isError: eventIsError(terminal),
		sourceEventIds: [...starts.map((candidate) => candidate.event_id), end.event_id],
		sourceSequences: [...starts.map((candidate) => candidate.sequence), end.sequence],
		eventKind: start.kind,
		severity: end.severity,
		source: start.source,
		attributes: mergedAttributes,
		...(end.phase === undefined ? {} : { phase: end.phase }),
		...(end.state === undefined ? {} : { state: end.state }),
		...(start.correlation === undefined ? {} : { correlation: start.correlation }),
		...scopeFields(start.correlation),
		startedAt: start.observed_at,
		endedAt: end.observed_at,
		...(toolName === undefined ? {} : { toolName }),
		...(start.privacy_class === undefined
			? end.privacy_class === undefined
				? {}
				: { privacyClass: end.privacy_class }
			: { privacyClass: start.privacy_class }),
		...(start.payload_ref === undefined
			? end.payload_ref === undefined
				? {}
				: { payloadRef: end.payload_ref }
			: { payloadRef: start.payload_ref }),
		...(start.redaction === undefined
			? end.redaction === undefined
				? {}
				: { redaction: end.redaction }
			: { redaction: start.redaction }),
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
	return {
		...record,
		sourceEventIds: [...record.sourceEventIds, event.event_id],
		sourceSequences: [...record.sourceSequences, event.sequence],
	};
}

function projectRecords(inputs: readonly OrderedInput[]): readonly TrajectoryRecord[] {
	const closed = closedSpanKeys(inputs);
	const output: TrajectoryRecord[] = [];
	const openTools = new Map<
		string,
		{ readonly index: number; readonly starts: TelemetryEvent[] }
	>();
	const settledTools = new Map<string, number>();

	for (const input of inputs) {
		if (input.type === "gap") {
			output.push(gapRecord(input.gap));
			continue;
		}
		const event = input.event;
		if (!SUPPORTED_EVENT_KINDS.has(event.kind)) continue;
		if (event.kind !== "tool.execution") {
			output.push(eventRecord(event, closed));
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
					output[existing.index] = {
						...current,
						sourceEventIds: [...current.sourceEventIds, event.event_id],
						sourceSequences: [...current.sourceSequences, event.sequence],
					};
				}
				continue;
			}
			const settledIndex = key === undefined ? undefined : settledTools.get(key);
			if (settledIndex !== undefined) {
				const settled = output[settledIndex];
				if (settled !== undefined) {
					output[settledIndex] = appendSourceEvidence(settled, event);
				}
				continue;
			}
			const index = output.push(eventRecord(event, closed)) - 1;
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
				output[open.index] = pairedToolRecord(open.starts, event);
				settledTools.set(key, open.index);
				continue;
			}
			const settledIndex = settledTools.get(key);
			if (settledIndex !== undefined) {
				const settled = output[settledIndex];
				if (settled !== undefined) {
					output[settledIndex] = appendSourceEvidence(settled, event);
				}
				continue;
			}
		}
		const index = output.push(eventRecord(event, closed)) - 1;
		if (event.phase === "end" && callId !== undefined) {
			settledTools.set(scopedIdentity(event.source, event.correlation, callId), index);
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
	return record.kind === "GAP" ? `gap:${record.id}` : "unscoped";
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
