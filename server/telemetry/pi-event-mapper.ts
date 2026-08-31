import { createHash } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
	JsonValue,
	PiTelemetryCorrelation,
	PiTelemetryRecord,
	PiTelemetrySource,
	TelemetrySeverity,
} from "./types.js";

export interface PiTelemetryToolSchema {
	name: string;
	schema: unknown;
}

export interface PiTelemetryContext {
	systemPrompt: string;
	toolSchemas: readonly PiTelemetryToolSchema[];
}

export interface PiEventMapperOptions {
	source: PiTelemetrySource;
	sessionId: string;
	conversationId: string;
	idNamespace?: string;
	wallNow?: () => number;
	monotonicNow?: () => number;
	stallThresholdMs?: number;
}

interface SpanCorrelation {
	trace_id?: string;
	turn_id?: string;
	step_id?: string;
	request_id?: string;
}

interface RunSpan {
	id: string;
	startedAt: number;
}

interface TurnSpan {
	ids: Required<Pick<SpanCorrelation, "turn_id" | "step_id" | "request_id">>;
	startedAt: number;
}

interface ToolSpan {
	correlation: SpanCorrelation;
	startedAt: number;
}

interface FinalState {
	state: string;
	severity: TelemetrySeverity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContentIndex(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isDenseArrayOf(value: unknown, predicate: (item: unknown) => boolean): value is unknown[] {
	if (!Array.isArray(value)) return false;
	for (let index = 0; index < value.length; index++) {
		if (!Object.hasOwn(value, index) || !predicate(value[index])) return false;
	}
	return true;
}

function isTextBlock(value: unknown): boolean {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageBlock(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.type === "image" &&
		typeof value.data === "string" &&
		typeof value.mimeType === "string"
	);
}

function isThinkingBlock(value: unknown): boolean {
	return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string";
}

function isToolCallBlock(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.type === "toolCall" &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		isRecord(value.arguments)
	);
}

function isAssistantContentBlock(value: unknown): boolean {
	return isTextBlock(value) || isThinkingBlock(value) || isToolCallBlock(value);
}

function isInputContentBlock(value: unknown): boolean {
	return isTextBlock(value) || isImageBlock(value);
}

function isUsage(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	return (
		isFiniteNumber(value.input) &&
		isFiniteNumber(value.output) &&
		isFiniteNumber(value.cacheRead) &&
		isFiniteNumber(value.cacheWrite) &&
		isFiniteNumber(value.totalTokens) &&
		isFiniteNumber(value.cost.input) &&
		isFiniteNumber(value.cost.output) &&
		isFiniteNumber(value.cost.cacheRead) &&
		isFiniteNumber(value.cost.cacheWrite) &&
		isFiniteNumber(value.cost.total)
	);
}

function isStopReason(value: unknown): boolean {
	return (
		value === "pending" ||
		value === "stop" ||
		value === "length" ||
		value === "toolUse" ||
		value === "error" ||
		value === "aborted" ||
		value === "deferred"
	);
}

function isAssistantMessage(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.role === "assistant" &&
		isDenseArrayOf(value.content, isAssistantContentBlock) &&
		typeof value.api === "string" &&
		typeof value.provider === "string" &&
		typeof value.model === "string" &&
		isUsage(value.usage) &&
		isStopReason(value.stopReason) &&
		isFiniteNumber(value.timestamp)
	);
}

function isToolResultMessage(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.role === "toolResult" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		isDenseArrayOf(value.content, isInputContentBlock) &&
		typeof value.isError === "boolean" &&
		isFiniteNumber(value.timestamp)
	);
}

function isAgentMessage(value: unknown): boolean {
	if (!isRecord(value) || typeof value.role !== "string") return false;
	switch (value.role) {
		case "assistant":
			return isAssistantMessage(value);
		case "user":
			return (
				(typeof value.content === "string" ||
					isDenseArrayOf(value.content, isInputContentBlock)) &&
				isFiniteNumber(value.timestamp)
			);
		case "toolResult":
			return isToolResultMessage(value);
		case "bashExecution":
			return (
				typeof value.command === "string" &&
				typeof value.output === "string" &&
				(value.exitCode === undefined || isFiniteNumber(value.exitCode)) &&
				typeof value.cancelled === "boolean" &&
				typeof value.truncated === "boolean" &&
				isFiniteNumber(value.timestamp)
			);
		case "custom":
			return (
				typeof value.customType === "string" &&
				(typeof value.content === "string" ||
					isDenseArrayOf(value.content, isInputContentBlock)) &&
				typeof value.display === "boolean" &&
				isFiniteNumber(value.timestamp)
			);
		case "branchSummary":
			return (
				typeof value.summary === "string" &&
				typeof value.fromId === "string" &&
				isFiniteNumber(value.timestamp)
			);
		case "compactionSummary":
			return (
				typeof value.summary === "string" &&
				isFiniteNumber(value.tokensBefore) &&
				isFiniteNumber(value.timestamp)
			);
		default:
			return false;
	}
}

function isAssistantMessageEvent(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	const hasPartial = isAssistantMessage(value.partial);
	switch (value.type) {
		case "start":
			return hasPartial;
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
			return isContentIndex(value.contentIndex) && hasPartial;
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return isContentIndex(value.contentIndex) && typeof value.delta === "string" && hasPartial;
		case "text_end":
		case "thinking_end":
			return isContentIndex(value.contentIndex) && typeof value.content === "string" && hasPartial;
		case "toolcall_end":
			return (
				isContentIndex(value.contentIndex) &&
				isToolCallBlock(value.toolCall) &&
				hasPartial
			);
		case "done":
			return (
				(value.reason === "stop" ||
					value.reason === "length" ||
					value.reason === "toolUse" ||
					value.reason === "deferred") &&
				isAssistantMessage(value.message)
			);
		case "error":
			return (
				(value.reason === "aborted" || value.reason === "error") &&
				isAssistantMessage(value.error)
			);
		default:
			return false;
	}
}

function hasThinkingBlockAt(message: unknown, contentIndex: number): boolean {
	return (
		isRecord(message) &&
		Array.isArray(message.content) &&
		contentIndex < message.content.length &&
		Object.hasOwn(message.content, contentIndex) &&
		isThinkingBlock(message.content[contentIndex])
	);
}

function hasAlignedThinkingContent(message: unknown, update: unknown): boolean {
	if (!isRecord(update)) return false;
	if (
		update.type !== "thinking_start" &&
		update.type !== "thinking_delta" &&
		update.type !== "thinking_end"
	) {
		return true;
	}
	if (!isContentIndex(update.contentIndex)) return false;
	return (
		hasThinkingBlockAt(message, update.contentIndex) &&
		hasThinkingBlockAt(update.partial, update.contentIndex)
	);
}

function isSupportedEvent(value: unknown): value is AgentSessionEvent {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	switch (value.type) {
		case "agent_start":
		case "turn_start":
		case "agent_settled":
			return true;
		case "agent_end":
			return (
				isDenseArrayOf(value.messages, isAgentMessage) &&
				typeof value.willRetry === "boolean"
			);
		case "turn_end":
			return isAgentMessage(value.message) && isDenseArrayOf(value.toolResults, isToolResultMessage);
		case "tool_execution_start":
			return (
				typeof value.toolCallId === "string" &&
				value.toolCallId.length > 0 &&
				typeof value.toolName === "string" &&
				value.toolName.length > 0 &&
				Object.hasOwn(value, "args")
			);
		case "tool_execution_end":
			return (
				typeof value.toolCallId === "string" &&
				value.toolCallId.length > 0 &&
				typeof value.toolName === "string" &&
				value.toolName.length > 0 &&
				Object.hasOwn(value, "result") &&
				typeof value.isError === "boolean"
			);
		case "message_update":
			return (
				isAssistantMessage(value.message) &&
				isAssistantMessageEvent(value.assistantMessageEvent) &&
				hasAlignedThinkingContent(value.message, value.assistantMessageEvent)
			);
		case "auto_retry_end":
			return (
				typeof value.success === "boolean" &&
				typeof value.attempt === "number" &&
				Number.isSafeInteger(value.attempt) &&
				value.attempt >= 0 &&
				(value.finalError === undefined || typeof value.finalError === "string")
			);
		default:
			return false;
	}
}

function isTelemetryContextShape(value: unknown): value is PiTelemetryContext {
	if (
		!isRecord(value) ||
		typeof value.systemPrompt !== "string" ||
		!Array.isArray(value.toolSchemas)
	) {
		return false;
	}
	for (let index = 0; index < value.toolSchemas.length; index++) {
		if (!Object.hasOwn(value.toolSchemas, index)) return false;
		const tool = value.toolSchemas[index];
		if (
			!isRecord(tool) ||
			typeof tool.name !== "string" ||
			tool.name.length === 0 ||
			!Object.hasOwn(tool, "schema")
		) {
			return false;
		}
	}
	return true;
}

function isJsonGraph(value: unknown, ancestors = new Set<object>()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index++) {
				if (!Object.hasOwn(value, index) || !isJsonGraph(value[index], ancestors)) return false;
			}
			return true;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		for (const key of Object.keys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || !isJsonGraph(descriptor.value, ancestors)) {
				return false;
			}
		}
		return true;
	} finally {
		ancestors.delete(value);
	}
}

function hasJsonToolSchemas(context: PiTelemetryContext): boolean {
	try {
		return context.toolSchemas.every((tool) => isJsonGraph(tool.schema));
	} catch {
		return false;
	}
}

function stableValue(value: unknown, seen = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	const normalized: { [key: string]: JsonValue } = {};
	for (const key of Object.keys(value).sort()) {
		const field = (value as Record<string, unknown>)[key];
		if (field === undefined || typeof field === "function" || typeof field === "symbol") continue;
		normalized[key] = stableValue(field, seen);
	}
	seen.delete(value);
	return normalized;
}

function hash(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function assistantStopReason(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const candidate = message as { role?: unknown; stopReason?: unknown };
	return candidate.role === "assistant" && typeof candidate.stopReason === "string"
		? candidate.stopReason
		: undefined;
}

function lastAssistantStopReason(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const stopReason = assistantStopReason(messages[index]);
		if (stopReason !== undefined) return stopReason;
	}
	return undefined;
}

function finalState(stopReason: string | undefined): FinalState {
	switch (stopReason) {
		case "stop":
			return { state: "completed", severity: "info" };
		case "aborted":
			return { state: "cancelled", severity: "warning" };
		case "error":
			return { state: "error", severity: "error" };
		case "length":
			return { state: "truncated", severity: "warning" };
		case "deferred":
			return { state: "deferred", severity: "info" };
		case "toolUse":
			return { state: "tool_use", severity: "info" };
		case "pending":
			return { state: "pending", severity: "info" };
		default:
			return { state: "unknown", severity: "warning" };
	}
}

export class PiEventMapper {
	private readonly source: PiTelemetrySource;
	private readonly sessionId: string;
	private readonly conversationId: string;
	private readonly idNamespace: string;
	private readonly namespaceToolCallIds: boolean;
	private readonly wallNow: () => number;
	private readonly monotonicNow: () => number;
	private readonly stallThresholdMs: number;
	private runSequence = 0;
	private turnSequence = 0;
	private currentRun: RunSpan | null = null;
	private currentTurn: TurnSpan | null = null;
	private readonly toolStarts = new Map<string, ToolSpan>();
	private contextHashes: { systemPrompt: string; toolSchemas: string } | null = null;
	private lastEventAt: number | null = null;
	private stallObserved = false;
	private disposed = false;

	constructor(options: PiEventMapperOptions) {
		this.source = { ...options.source };
		this.sessionId = options.sessionId;
		this.conversationId = options.conversationId;
		this.idNamespace = options.idNamespace ?? options.conversationId;
		this.namespaceToolCallIds = options.idNamespace !== undefined;
		this.wallNow = options.wallNow ?? Date.now;
		this.monotonicNow = options.monotonicNow ?? (() => performance.now());
		this.stallThresholdMs = options.stallThresholdMs ?? 180_000;
	}

	map(event: AgentSessionEvent, context?: PiTelemetryContext): PiTelemetryRecord[] {
		if (this.disposed) return [];
		if (!isSupportedEvent(event)) return [];
		const validatedContext = isTelemetryContextShape(context) ? context : undefined;
		if (validatedContext && !hasJsonToolSchemas(validatedContext)) return [];
		const wallTime = this.wallNow();
		const monotonicTime = this.monotonicNow();
		this.recordActivity(wallTime);
		const records: PiTelemetryRecord[] = [];
		let duplicateStart = false;
		if (event.type === "agent_start") {
			duplicateStart = this.currentRun !== null;
			if (!this.currentRun) {
				this.currentRun = {
					id: `${this.idNamespace}:run:${++this.runSequence}`,
					startedAt: monotonicTime,
				};
			}
		} else if (event.type === "turn_start") {
			duplicateStart = this.currentTurn !== null;
			if (!this.currentTurn) {
				const sequence = ++this.turnSequence;
				this.currentTurn = {
					ids: {
						turn_id: `${this.idNamespace}:turn:${sequence}`,
						step_id: `${this.idNamespace}:step:${sequence}`,
						request_id: `${this.idNamespace}:request:${sequence}`,
					},
					startedAt: monotonicTime,
				};
			}
		}
		const contextRecord = validatedContext
			? this.mapContext(validatedContext, wallTime)
			: undefined;
		if (contextRecord) records.push(contextRecord);

		switch (event.type) {
			case "agent_start": {
				records.push(
					this.record({
						kind: "agent.run",
						phase: "start",
						state: "running",
						severity: "info",
						wallTime,
						parentId: this.sessionId,
						attributes: duplicateStart ? { duplicate_start: true } : {},
					}),
				);
				break;
			}
			case "agent_end": {
				const matchedRun = this.currentRun;
				const outcome = event.willRetry
					? { state: "retrying", severity: "warning" as const }
					: finalState(lastAssistantStopReason(event.messages));
				records.push(
					this.record({
						kind: "agent.run",
						phase: "end",
						...outcome,
						wallTime,
						parentId: this.sessionId,
						durationMs: matchedRun
							? Math.max(0, monotonicTime - matchedRun.startedAt)
							: undefined,
						attributes: {
							matched_start: matchedRun !== null,
							will_retry: event.willRetry,
						},
					}),
				);
				this.currentTurn = null;
				this.toolStarts.clear();
				if (!event.willRetry) this.currentRun = null;
				break;
			}
			case "turn_start": {
				records.push(
					this.record({
						kind: "agent.turn",
						phase: "start",
						state: "running",
						severity: "info",
						wallTime,
						parentId: this.currentRun?.id ?? this.sessionId,
						span: this.currentSpan(),
						attributes: duplicateStart ? { duplicate_start: true } : {},
					}),
				);
				break;
			}
			case "turn_end": {
				const matchedTurn = this.currentTurn;
				const outcome = finalState(assistantStopReason(event.message));
				records.push(
					this.record({
						kind: "agent.turn",
						phase: "end",
						...outcome,
						wallTime,
						parentId: this.currentRun?.id ?? this.sessionId,
						span: this.currentSpan(),
						durationMs: matchedTurn
							? Math.max(0, monotonicTime - matchedTurn.startedAt)
							: undefined,
						attributes: { matched_start: matchedTurn !== null },
					}),
				);
				this.currentTurn = null;
				break;
			}
			case "tool_execution_start": {
				const existing = this.toolStarts.get(event.toolCallId);
				const span: ToolSpan = existing ?? {
					correlation: this.currentSpan(),
					startedAt: monotonicTime,
				};
				if (!existing) this.toolStarts.set(event.toolCallId, span);
				records.push(
					this.record({
						kind: "tool.execution",
						phase: "start",
						state: "running",
						severity: "info",
						wallTime,
						parentId: span.correlation.request_id ?? span.correlation.trace_id ?? this.sessionId,
						span: span.correlation,
						toolCallId: event.toolCallId,
						attributes: {
							tool_name: event.toolName,
							...(existing ? { duplicate_start: true } : {}),
						},
					}),
				);
				break;
			}
			case "tool_execution_end": {
				const started = this.toolStarts.get(event.toolCallId);
				if (started) this.toolStarts.delete(event.toolCallId);
				const span = started?.correlation ?? this.currentSpan();
				records.push(
					this.record({
						kind: "tool.execution",
						phase: "end",
						state: event.isError ? "error" : "completed",
						severity: event.isError ? "error" : "info",
						wallTime,
						parentId: span.request_id ?? span.trace_id ?? this.sessionId,
						span,
						toolCallId: event.toolCallId,
						durationMs: started
							? Math.max(0, monotonicTime - started.startedAt)
							: undefined,
						attributes: {
							tool_name: event.toolName,
							is_error: event.isError,
							matched_start: started !== undefined,
						},
					}),
				);
				break;
			}
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update.type !== "thinking_end" || update.content.length === 0) break;
				const span = this.currentSpan();
				records.push(
					this.record({
						kind: "provider.thinking",
						phase: "end",
						state: "emitted",
						severity: "debug",
						wallTime,
						parentId: span.request_id ?? span.trace_id ?? this.sessionId,
						span,
						attributes: {
							content: update.content,
							content_index: update.contentIndex,
						},
					}),
				);
				break;
			}
			case "auto_retry_end":
				if (event.success === false) this.clearOpenSpans();
				break;
			case "agent_settled":
				this.clearOpenSpans();
				break;
			default:
				break;
		}

		return records;
	}

	noteActivity(nowMs = this.wallNow()): void {
		if (this.disposed || !Number.isFinite(nowMs)) return;
		this.recordActivity(nowMs);
	}

	observeStall(nowMs: number): PiTelemetryRecord[] {
		if (
			this.disposed ||
			!this.currentRun ||
			this.lastEventAt === null ||
			this.stallObserved ||
			!Number.isFinite(nowMs)
		) {
			return [];
		}
		const silenceMs = nowMs - this.lastEventAt;
		if (silenceMs < this.stallThresholdMs) return [];
		this.stallObserved = true;
		const span = this.currentSpan();
		return [
			this.record({
				kind: "agent.stall",
				phase: "observation",
				state: "possibly_stalled",
				severity: "warning",
				wallTime: nowMs,
				parentId: span.request_id ?? span.trace_id ?? this.sessionId,
				span,
				durationMs: silenceMs,
				attributes: {
					silence_ms: silenceMs,
					threshold_ms: this.stallThresholdMs,
				},
			}),
		];
	}

	reset(): void {
		if (this.disposed) return;
		this.clearOpenSpans();
		this.contextHashes = null;
	}

	dispose(): void {
		if (this.disposed) return;
		this.reset();
		this.disposed = true;
	}

	private clearOpenSpans(): void {
		this.currentRun = null;
		this.currentTurn = null;
		this.toolStarts.clear();
		this.lastEventAt = null;
		this.stallObserved = false;
	}

	private recordActivity(nowMs: number): void {
		this.lastEventAt = nowMs;
		this.stallObserved = false;
	}

	private mapContext(context: PiTelemetryContext, wallTime: number): PiTelemetryRecord | undefined {
		const hashes = {
			systemPrompt: hash(context.systemPrompt),
			toolSchemas: hash(
				[...context.toolSchemas]
					.sort((left, right) => left.name.localeCompare(right.name))
					.map((tool) => ({ name: tool.name, schema: tool.schema })),
			),
		};
		if (
			this.contextHashes?.systemPrompt === hashes.systemPrompt &&
			this.contextHashes.toolSchemas === hashes.toolSchemas
		) {
			return undefined;
		}
		this.contextHashes = hashes;
		const span = this.currentSpan();
		return this.record({
			kind: "context.changed",
			phase: "snapshot",
			state: "changed",
			severity: "info",
			wallTime,
			parentId: span.request_id ?? span.trace_id ?? this.sessionId,
			span,
			attributes: {
				system_prompt_hash: hashes.systemPrompt,
				tool_schema_hash: hashes.toolSchemas,
			},
		});
	}

	private currentSpan(): SpanCorrelation {
		return {
			...(this.currentRun ? { trace_id: this.currentRun.id } : {}),
			...(this.currentTurn?.ids ?? {}),
		};
	}

	private record(input: {
		kind: string;
		phase: string;
		state: string;
		severity: TelemetrySeverity;
		wallTime: number;
		parentId: string;
		span?: SpanCorrelation;
		toolCallId?: string;
		durationMs?: number;
		attributes: { [key: string]: JsonValue };
	}): PiTelemetryRecord {
		const span = input.span ?? this.currentSpan();
		const correlation: PiTelemetryCorrelation = {
			...span,
			parent_id: input.parentId,
			session_id: this.sessionId,
			conversation_id: this.conversationId,
			...(input.toolCallId
				? {
					tool_call_id: this.namespaceToolCallIds
						? `${this.idNamespace}:tool:${input.toolCallId}`
						: input.toolCallId,
				}
				: {}),
		};
		return {
			kind: input.kind,
			phase: input.phase,
			severity: input.severity,
			state: input.state,
			source: { ...this.source },
			correlation,
			...(input.durationMs !== undefined ? { duration_ms: input.durationMs } : {}),
			attributes: {
				source_timestamp_ms: input.wallTime,
				...input.attributes,
			},
			privacy_class: "operator",
		};
	}
}
