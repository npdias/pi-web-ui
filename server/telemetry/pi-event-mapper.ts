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
	onFailure?: (reason: "invalid_context_schema") => void;
}

interface SpanCorrelation {
	trace_id?: string;
	turn_id?: string;
	step_id?: string;
	request_id?: string;
}

interface RunSpan {
	id: string;
	attemptId: string;
	attemptOpen: boolean;
	startedAt: number;
}

interface TurnSpan {
	ids: Required<Pick<SpanCorrelation, "turn_id" | "step_id" | "request_id">>;
	attemptId: string;
	startedAt: number;
}

interface ToolSpan {
	attemptId: string;
	correlation: SpanCorrelation;
	startedAt: number;
	toolName: string;
}

interface ModelSpan {
	attemptId: string;
	correlation: SpanCorrelation;
	startedAt: number;
}

interface FinalState {
	state: string;
	severity: TelemetrySeverity;
}

const MAX_STRUCTURED_DETAIL_BYTES = 256 * 1024;
const MAX_TEXT_DETAIL_BYTES = 768 * 1024;

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
		case "message_start":
		case "message_end":
			return isAgentMessage(value.message);
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

type CanonicalJsonFrame =
	| { kind: "value"; value: unknown }
	| { kind: "text"; value: string }
	| { kind: "leave"; value: object };

interface CanonicalJsonResult {
	sha256: string;
	originalBytes: number;
	serialized?: string;
}

function jsonPrimitive(value: unknown): string | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		return JSON.stringify(Number.isFinite(value) ? value : String(value));
	}
	if (typeof value === "bigint") return JSON.stringify(value.toString());
	if (typeof value !== "object") return JSON.stringify(String(value));
	return undefined;
}

function canonicalJson(value: unknown, retainThroughBytes: number): CanonicalJsonResult {
	const digest = createHash("sha256");
	let originalBytes = 0;
	let retained: string[] | undefined = [];
	const append = (text: string) => {
		digest.update(text);
		originalBytes += Buffer.byteLength(text, "utf8");
		if (!retained) return;
		if (originalBytes > retainThroughBytes) {
			retained = undefined;
			return;
		}
		retained.push(text);
	};
	const ancestors = new Set<object>();
	const stack: CanonicalJsonFrame[] = [{ kind: "value", value }];
	while (stack.length > 0) {
		const frame = stack.pop();
		if (!frame) break;
		if (frame.kind === "text") {
			append(frame.value);
			continue;
		}
		if (frame.kind === "leave") {
			ancestors.delete(frame.value);
			continue;
		}
		const primitive = jsonPrimitive(frame.value);
		if (primitive !== undefined) {
			append(primitive);
			continue;
		}
		const object = frame.value as object;
		if (ancestors.has(object)) {
			append(JSON.stringify("[Circular]"));
			continue;
		}
		if (Array.isArray(object)) {
			ancestors.add(object);
			append("[");
			stack.push({ kind: "leave", value: object });
			stack.push({ kind: "text", value: "]" });
			for (let index = object.length - 1; index >= 0; index--) {
				let item: unknown = null;
				try {
					const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
					if (descriptor && "value" in descriptor) item = descriptor.value;
				} catch {
					item = "[Unserializable]";
				}
				stack.push({ kind: "value", value: item });
				if (index > 0) stack.push({ kind: "text", value: "," });
			}
			continue;
		}
		let entries: Array<readonly [string, unknown]> = [];
		try {
			entries = Object.keys(object)
				.sort()
				.flatMap((key) => {
					const descriptor = Object.getOwnPropertyDescriptor(object, key);
					if (!descriptor || !("value" in descriptor)) return [];
					const field = descriptor.value;
					return field === undefined || typeof field === "function" || typeof field === "symbol"
						? []
						: [[key, field] as const];
				});
		} catch {
			append(JSON.stringify("[Unserializable]"));
			continue;
		}
		ancestors.add(object);
		append("{");
		stack.push({ kind: "leave", value: object });
		stack.push({ kind: "text", value: "}" });
		for (let index = entries.length - 1; index >= 0; index--) {
			const [key, field] = entries[index];
			stack.push({ kind: "value", value: field });
			stack.push({ kind: "text", value: ":" });
			stack.push({ kind: "text", value: JSON.stringify(key) });
			if (index > 0) stack.push({ kind: "text", value: "," });
		}
	}
	return {
		sha256: `sha256:${digest.digest("hex")}`,
		originalBytes,
		...(retained ? { serialized: retained.join("") } : {}),
	};
}

function hash(value: unknown): string {
	return canonicalJson(value, 0).sha256;
}

function truncationMarker(serialized: string): JsonValue {
	return {
		truncated: true,
		sha256: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
		original_bytes: Buffer.byteLength(serialized, "utf8"),
	};
}

function boundedStructured(value: unknown): JsonValue {
	const result = canonicalJson(value, MAX_STRUCTURED_DETAIL_BYTES);
	return result.serialized === undefined
		? {
			truncated: true,
			sha256: result.sha256,
			original_bytes: result.originalBytes,
		}
		: JSON.parse(result.serialized) as JsonValue;
}

function boundedText(value: string): JsonValue {
	return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_TEXT_DETAIL_BYTES
		? value
		: truncationMarker(value);
}

function textContent(message: unknown): string {
	if (!isRecord(message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(isTextBlock)
		.map((block) => (block as { text: string }).text)
		.join("\n");
}

function imageCount(message: unknown): number {
	if (!isRecord(message) || !Array.isArray(message.content)) return 0;
	return message.content.filter(isImageBlock).length;
}

function assistantMetadata(message: AssistantMessageShape): { [key: string]: JsonValue } {
	return {
		api: message.api,
		provider: message.provider,
		model: message.model,
	};
}

interface AssistantMessageShape {
	api: string;
	provider: string;
	model: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cacheWrite1h?: number;
		reasoning?: number;
		totalTokens: number;
	};
	stopReason: string;
}

function assistantUsage(message: AssistantMessageShape): { [key: string]: JsonValue } {
	const usage = message.usage;
	return {
		input_tokens: usage.input,
		output_tokens: usage.output,
		cache_read_tokens: usage.cacheRead,
		cache_write_tokens: usage.cacheWrite,
		...(isFiniteNumber(usage.cacheWrite1h)
			? { cache_write_1h_tokens: usage.cacheWrite1h }
			: {}),
		...(isFiniteNumber(usage.reasoning) ? { reasoning_tokens: usage.reasoning } : {}),
		total_tokens: usage.totalTokens,
	};
}

function toolResultOutput(message: unknown): JsonValue {
	if (!isRecord(message)) return null;
	return boundedStructured({
		content: message.content,
		...(Object.hasOwn(message, "details") ? { details: message.details } : {}),
		...(Object.hasOwn(message, "usage") ? { usage: message.usage } : {}),
		...(Object.hasOwn(message, "addedToolNames")
			? { added_tool_names: message.addedToolNames }
			: {}),
	});
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
	private readonly onFailure?: (reason: "invalid_context_schema") => void;
	private runSequence = 0;
	private turnSequence = 0;
	private runAttemptSequence = 0;
	private turnAttemptSequence = 0;
	private toolAttemptSequence = 0;
	private modelAttemptSequence = 0;
	private currentRun: RunSpan | null = null;
	private currentTurn: TurnSpan | null = null;
	private currentModelResponse: ModelSpan | null = null;
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
		this.onFailure = options.onFailure;
	}

	map(event: AgentSessionEvent, context?: PiTelemetryContext): PiTelemetryRecord[] {
		if (this.disposed) return [];
		if (!isSupportedEvent(event)) return [];
		let validatedContext: PiTelemetryContext | undefined;
		if (context !== undefined) {
			if (isTelemetryContextShape(context) && hasJsonToolSchemas(context)) {
				validatedContext = context;
			} else {
				try {
					this.onFailure?.("invalid_context_schema");
				} catch {
					// Telemetry-health reporting cannot interrupt Pi lifecycle mapping.
				}
			}
		}
		const wallTime = this.wallNow();
		const monotonicTime = this.monotonicNow();
		this.recordActivity(wallTime);
		const records: PiTelemetryRecord[] = [];
		let duplicateStart = false;
		if (event.type === "agent_start") {
			if (!this.currentRun) {
				const sequence = ++this.runSequence;
				this.currentRun = {
					id: `${this.idNamespace}:run:${sequence}`,
					attemptId: `${this.idNamespace}:run-attempt:${++this.runAttemptSequence}`,
					attemptOpen: true,
					startedAt: monotonicTime,
				};
			} else if (!this.currentRun.attemptOpen) {
				this.currentRun.attemptOpen = true;
				this.currentRun.startedAt = monotonicTime;
			} else {
				duplicateStart = true;
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
					attemptId: `${this.idNamespace}:turn-attempt:${++this.turnAttemptSequence}`,
					startedAt: monotonicTime,
				};
			}
		} else if (event.type === "message_start" && event.message.role === "assistant") {
			duplicateStart = this.currentModelResponse !== null;
			if (!this.currentModelResponse) {
				this.currentModelResponse = {
					attemptId: `${this.idNamespace}:model-attempt:${++this.modelAttemptSequence}`,
					correlation: this.currentSpan(),
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
						attributes: {
							lifecycle_attempt_id: this.currentRun?.attemptId ??
								`${this.idNamespace}:run-attempt:${++this.runAttemptSequence}`,
							...(duplicateStart ? { duplicate_start: true } : {}),
						},
					}),
				);
				break;
			}
			case "agent_end": {
				const matchedRun = this.currentRun?.attemptOpen ? this.currentRun : null;
				const attemptId = this.currentRun?.attemptId ??
					`${this.idNamespace}:run-attempt:${++this.runAttemptSequence}`;
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
							lifecycle_attempt_id: attemptId,
							matched_start: matchedRun !== null,
							will_retry: event.willRetry,
						},
					}),
				);
				this.currentTurn = null;
				this.currentModelResponse = null;
				this.toolStarts.clear();
				if (event.willRetry && this.currentRun) {
					this.currentRun.attemptId =
						`${this.idNamespace}:run-attempt:${++this.runAttemptSequence}`;
					this.currentRun.attemptOpen = false;
				} else {
					this.currentRun = null;
				}
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
						attributes: {
							lifecycle_attempt_id: this.currentTurn?.attemptId ??
								`${this.idNamespace}:turn-attempt:${++this.turnAttemptSequence}`,
							...(duplicateStart ? { duplicate_start: true } : {}),
						},
					}),
				);
				break;
			}
			case "turn_end": {
				const matchedTurn = this.currentTurn;
				const attemptId = matchedTurn?.attemptId ??
					`${this.idNamespace}:turn-attempt:${++this.turnAttemptSequence}`;
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
						attributes: {
							lifecycle_attempt_id: attemptId,
							matched_start: matchedTurn !== null,
						},
					}),
				);
				this.currentTurn = null;
				break;
			}
			case "message_start": {
				if (event.message.role !== "assistant") break;
				const response = this.currentModelResponse;
				const span = response?.correlation ?? this.currentSpan();
				records.push(
					this.record({
						kind: "model.response",
						phase: "start",
						state: "running",
						severity: "info",
						wallTime,
						parentId: span.request_id ?? span.trace_id ?? this.sessionId,
						span,
						attributes: {
							lifecycle_attempt_id: response?.attemptId ??
								`${this.idNamespace}:model-attempt:${++this.modelAttemptSequence}`,
							...assistantMetadata(event.message),
							...(duplicateStart ? { duplicate_start: true } : {}),
						},
					}),
				);
				break;
			}
			case "message_end": {
				if (event.message.role === "user") {
					const span = this.currentSpan();
					records.push(
						this.record({
							kind: "user.message",
							phase: "observation",
							state: "emitted",
							severity: "info",
							wallTime,
							parentId: span.request_id ?? span.trace_id ?? this.sessionId,
							span,
							attributes: {
								input_detail: boundedText(textContent(event.message)),
								image_count: imageCount(event.message),
							},
						}),
					);
					break;
				}
				if (event.message.role === "assistant") {
					const response = this.currentModelResponse;
					const span = response?.correlation ?? this.currentSpan();
					const attemptId = response?.attemptId ??
						`${this.idNamespace}:model-attempt:${++this.modelAttemptSequence}`;
					const outcome = finalState(event.message.stopReason);
					records.push(
						this.record({
							kind: "model.response",
							phase: "end",
							...outcome,
							wallTime,
							parentId: span.request_id ?? span.trace_id ?? this.sessionId,
							span,
							durationMs: response
								? Math.max(0, monotonicTime - response.startedAt)
								: undefined,
							attributes: {
								lifecycle_attempt_id: attemptId,
								matched_start: response !== null,
								...assistantMetadata(event.message),
								output_detail: boundedText(textContent(event.message)),
								...assistantUsage(event.message),
								stop_reason: event.message.stopReason,
							},
						}),
					);
					this.currentModelResponse = null;
					break;
				}
				if (event.message.role === "toolResult") {
					const span = this.currentSpan();
					records.push(
						this.record({
							kind: "tool.result",
							phase: "observation",
							state: event.message.isError ? "error" : "completed",
							severity: event.message.isError ? "error" : "info",
							wallTime,
							parentId: span.request_id ?? span.trace_id ?? this.sessionId,
							span,
							toolCallId: event.message.toolCallId,
							attributes: {
								tool_name: event.message.toolName,
								is_error: event.message.isError,
								output: toolResultOutput(event.message),
							},
						}),
					);
				}
				break;
			}
			case "tool_execution_start": {
				const existing = this.toolStarts.get(event.toolCallId);
				const span: ToolSpan = existing ?? {
					attemptId: `${this.idNamespace}:tool-attempt:${++this.toolAttemptSequence}`,
					correlation: this.currentSpan(),
					startedAt: monotonicTime,
					toolName: event.toolName,
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
							lifecycle_attempt_id: span.attemptId,
							tool_name: event.toolName,
							input: boundedStructured(event.args),
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
				const attemptId = started?.attemptId ??
					`${this.idNamespace}:tool-attempt:${++this.toolAttemptSequence}`;
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
							lifecycle_attempt_id: attemptId,
							tool_name: event.toolName,
							is_error: event.isError,
							matched_start: started !== undefined,
							output: boundedStructured(event.result),
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
							content: boundedText(update.content),
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

	forceReset(): PiTelemetryRecord[] {
		if (this.disposed) return [];
		const wallTime = this.wallNow();
		const monotonicTime = this.monotonicNow();
		const records: PiTelemetryRecord[] = [];
		if (this.currentModelResponse) {
			const model = this.currentModelResponse;
			records.push(
				this.record({
					kind: "model.response",
					phase: "end",
					state: "cancelled",
					severity: "warning",
					wallTime,
					parentId:
						model.correlation.request_id ??
						model.correlation.trace_id ??
						this.sessionId,
					span: model.correlation,
					durationMs: Math.max(0, monotonicTime - model.startedAt),
					attributes: {
						cause_class: "forced_reset",
						lifecycle_attempt_id: model.attemptId,
						matched_start: true,
					},
				}),
			);
		}
		for (const [toolCallId, tool] of this.toolStarts) {
			records.push(
				this.record({
					kind: "tool.execution",
					phase: "end",
					state: "cancelled",
					severity: "warning",
					wallTime,
					parentId:
						tool.correlation.request_id ??
						tool.correlation.trace_id ??
						this.sessionId,
					span: tool.correlation,
					toolCallId,
					durationMs: Math.max(0, monotonicTime - tool.startedAt),
					attributes: {
						cause_class: "forced_reset",
						lifecycle_attempt_id: tool.attemptId,
						matched_start: true,
						tool_name: tool.toolName,
					},
				}),
			);
		}
		if (this.currentTurn) {
			const span = this.currentSpan();
			records.push(
				this.record({
					kind: "agent.turn",
					phase: "end",
					state: "cancelled",
					severity: "warning",
					wallTime,
					parentId: this.currentRun?.id ?? this.sessionId,
					span,
					durationMs: Math.max(0, monotonicTime - this.currentTurn.startedAt),
					attributes: {
						cause_class: "forced_reset",
						lifecycle_attempt_id: this.currentTurn.attemptId,
						matched_start: true,
					},
				}),
			);
		}
		if (this.currentRun?.attemptOpen) {
			records.push(
				this.record({
					kind: "agent.run",
					phase: "end",
					state: "aborted",
					severity: "warning",
					wallTime,
					parentId: this.sessionId,
					span: { trace_id: this.currentRun.id },
					durationMs: Math.max(0, monotonicTime - this.currentRun.startedAt),
					attributes: {
						cause_class: "forced_reset",
						lifecycle_attempt_id: this.currentRun.attemptId,
						matched_start: true,
					},
				}),
			);
		}
		if (records.length === 0) {
			records.push(
				this.record({
					kind: "agent.reset",
					phase: "observation",
					state: "forced_reset",
					severity: "warning",
					wallTime,
					parentId: this.sessionId,
					attributes: { cause_class: "forced_reset" },
				}),
			);
		}
		this.clearOpenSpans();
		this.contextHashes = null;
		return records;
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
		this.currentModelResponse = null;
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
