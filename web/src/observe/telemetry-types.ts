export type TelemetrySeverity =
	| "debug"
	| "info"
	| "warning"
	| "error"
	| "critical";

export type TelemetryJson =
	| null
	| boolean
	| number
	| string
	| readonly TelemetryJson[]
	| { readonly [key: string]: TelemetryJson };

export interface TelemetrySource {
	readonly robot_id: string;
	readonly host_id: string;
	readonly component: string;
	readonly instance_id?: string;
	readonly version?: string;
}

export interface TelemetryCorrelation {
	readonly trace_id?: string;
	readonly parent_id?: string;
	readonly session_id?: string;
	readonly conversation_id?: string;
	readonly turn_id?: string;
	readonly step_id?: string;
	readonly request_id?: string;
	readonly tool_call_id?: string;
	readonly assignment_id?: string;
}

export interface TelemetryEvent {
	readonly schema_version: 1;
	readonly event_id: string;
	readonly sequence: number;
	readonly observed_at: string;
	readonly monotonic_ns: number;
	readonly kind: string;
	readonly severity: TelemetrySeverity;
	readonly source: TelemetrySource;
	readonly attributes: Readonly<Record<string, TelemetryJson>>;
	readonly phase?: string;
	readonly state?: string;
	readonly summary?: string;
	readonly correlation?: TelemetryCorrelation;
	readonly duration_ms?: number;
	readonly privacy_class?: string;
	readonly payload_ref?: string;
	readonly redaction?: Readonly<Record<string, TelemetryJson>>;
}

export interface TelemetryReplayGap {
	readonly requested: number;
	readonly earliest_available: number | null;
	readonly resume_after: number;
}

export interface TelemetryEventsPage {
	readonly events: readonly TelemetryEvent[];
	readonly gap: TelemetryReplayGap | null;
	readonly next_cursor: number | null;
}

export interface TelemetrySourceHealth {
	readonly source: TelemetrySource;
	readonly last_event_at: string;
	readonly last_event_age_seconds: number;
	readonly status: "healthy" | "stale";
}

export interface TelemetryHealth {
	readonly status: "idle" | "healthy" | "degraded";
	readonly counters: {
		readonly accepted: number;
		readonly rejected: number;
		readonly persistence_gap: number;
		readonly dropped: number;
		readonly torn_lines: number;
		readonly stale_sources: number;
		readonly retention_runs: number;
		readonly retention_deleted_segments: number;
		readonly retention_deleted_bytes: number;
		readonly retention_failures: number;
	};
	readonly memory_tail: { readonly size: number; readonly capacity: number };
	readonly sources: readonly TelemetrySourceHealth[];
}

const SEVERITIES = new Set<TelemetrySeverity>([
	"debug",
	"info",
	"warning",
	"error",
	"critical",
]);
const CORRELATION_KEYS = [
	"trace_id",
	"parent_id",
	"session_id",
	"conversation_id",
	"turn_id",
	"step_id",
	"request_id",
	"tool_call_id",
	"assignment_id",
] as const;
const HEALTH_COUNTER_KEYS = [
	"accepted",
	"rejected",
	"persistence_gap",
	"dropped",
	"torn_lines",
	"stale_sources",
	"retention_runs",
	"retention_deleted_segments",
	"retention_deleted_bytes",
	"retention_failures",
] as const;
const REDACTED = "[REDACTED]";
const MAX_DISPLAY_KEY_LENGTH = 256;
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_OBJECT_KEYS = 256;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_JSON_DEPTH = 12;
const TRUNCATED_MARKER = "[TRUNCATED]";
const TRUNCATED_OBJECT_KEY = "__telemetry_truncated__";

export class TelemetryProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TelemetryProtocolError";
	}
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TelemetryProtocolError(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function truncateDisplayString(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - TRUNCATED_MARKER.length))}${TRUNCATED_MARKER}`;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TelemetryProtocolError(`${name} must be a non-empty string`);
	}
	return value;
}

function optionalString(
	value: unknown,
	name: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new TelemetryProtocolError(`${name} must be a string`);
	}
	return value;
}

function optionalDisplayString(value: unknown, name: string): string | undefined {
	const parsed = optionalString(value, name);
	return parsed === undefined
		? undefined
		: truncateDisplayString(parsed, MAX_TEXT_LENGTH);
}

function safeInteger(value: unknown, name: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		throw new TelemetryProtocolError(`${name} must be a safe integer`);
	}
	return value as number;
}

function finiteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TelemetryProtocolError(`${name} must be a finite number`);
	}
	return value;
}

function nonNegativeNumber(value: unknown, name: string): number {
	const result = finiteNumber(value, name);
	if (result < 0) throw new TelemetryProtocolError(`${name} must not be negative`);
	return result;
}

function nonNegativeInteger(value: unknown, name: string): number {
	const result = nonNegativeNumber(value, name);
	if (!Number.isInteger(result)) {
		throw new TelemetryProtocolError(`${name} must be an integer`);
	}
	return result;
}

function timestamp(value: unknown, name: string): string {
	const text = requiredString(value, name);
	if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) {
		throw new TelemetryProtocolError(`${name} must be an ISO timestamp with timezone`);
	}
	return text;
}

function normalizedKey(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[.\s-]+/g, "_")
		.toLowerCase();
}

function isSecretKey(value: string): boolean {
	const key = normalizedKey(value);
	return (
		key === "authorization" ||
		key === "proxy_authorization" ||
		key === "cookie" ||
		key === "set_cookie" ||
		key === "api_key" ||
		key === "apikey" ||
		key === "access_token" ||
		key === "refresh_token" ||
		key === "bearer_token" ||
		key === "session_token" ||
		key === "auth_token" ||
		key === "token" ||
		key === "password" ||
		key === "passwd" ||
		key === "secret" ||
		key === "client_secret" ||
		key === "credential" ||
		key === "credentials" ||
		key.endsWith("_api_key") ||
		key.endsWith("_access_token") ||
		key.endsWith("_refresh_token") ||
		key.endsWith("_client_secret")
	);
}

function sanitizeJson(value: unknown, name: string, depth = 0): TelemetryJson {
	if (depth > MAX_JSON_DEPTH) {
		return TRUNCATED_MARKER;
	}
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return finiteNumber(value, name);
	if (typeof value === "string") {
		return truncateDisplayString(value, MAX_TEXT_LENGTH);
	}
	if (Array.isArray(value)) {
		const truncated = value.length > MAX_ARRAY_ITEMS;
		const kept = truncated ? value.slice(0, MAX_ARRAY_ITEMS - 1) : value;
		const output = kept.map((item, index) =>
			sanitizeJson(item, `${name}[${index}]`, depth + 1),
		);
		if (truncated) output.push(TRUNCATED_MARKER);
		return output;
	}
	const input = objectValue(value, name);
	const entries = Object.entries(input);
	const truncated = entries.length > MAX_OBJECT_KEYS;
	const kept = truncated ? entries.slice(0, MAX_OBJECT_KEYS - 1) : entries;
	const output: Record<string, TelemetryJson> = {};
	for (const [key, item] of kept) {
		if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
		const displayKey = truncateDisplayString(key, MAX_DISPLAY_KEY_LENGTH);
		output[displayKey] = isSecretKey(key)
			? REDACTED
			: sanitizeJson(item, `${name}.${key}`, depth + 1);
	}
	if (truncated) output[TRUNCATED_OBJECT_KEY] = TRUNCATED_MARKER;
	return output;
}

function structuredRecord(
	value: unknown,
	name: string,
): Readonly<Record<string, TelemetryJson>> {
	const sanitized = sanitizeJson(value, name);
	if (sanitized === null || typeof sanitized !== "object" || Array.isArray(sanitized)) {
		throw new TelemetryProtocolError(`${name} must be an object`);
	}
	// Array.isArray narrows mutable arrays only; TelemetryJson exposes arrays as
	// readonly. Runtime guard above excludes both forms, so this cast records the
	// already-proven object branch for TypeScript.
	return sanitized as Readonly<Record<string, TelemetryJson>>;
}

function parseSource(value: unknown): TelemetrySource {
	const source = objectValue(value, "source");
	return {
		robot_id: requiredString(source.robot_id, "source.robot_id"),
		host_id: requiredString(source.host_id, "source.host_id"),
		component: requiredString(source.component, "source.component"),
		instance_id: optionalString(source.instance_id, "source.instance_id"),
		version: optionalString(source.version, "source.version"),
	};
}

function parseCorrelation(value: unknown): TelemetryCorrelation {
	const input = objectValue(value, "correlation");
	const output: Record<string, string> = {};
	for (const key of CORRELATION_KEYS) {
		const parsed = optionalString(input[key], `correlation.${key}`);
		if (parsed !== undefined) output[key] = parsed;
	}
	return output;
}

export function parseTelemetryEvent(value: unknown): TelemetryEvent {
	const input = objectValue(value, "event");
	if (input.schema_version !== 1) {
		throw new TelemetryProtocolError("event.schema_version must be 1");
	}
	const severity = requiredString(input.severity, "event.severity") as TelemetrySeverity;
	if (!SEVERITIES.has(severity)) {
		throw new TelemetryProtocolError("event.severity is invalid");
	}
	const correlation =
		input.correlation === undefined ? undefined : parseCorrelation(input.correlation);
	const duration =
		input.duration_ms === undefined
			? undefined
			: finiteNumber(input.duration_ms, "event.duration_ms");
	const redaction =
		input.redaction === undefined
			? undefined
			: structuredRecord(input.redaction, "event.redaction");
	return {
		schema_version: 1,
		event_id: requiredString(input.event_id, "event.event_id"),
		sequence: safeInteger(input.sequence, "event.sequence", 1),
		observed_at: timestamp(input.observed_at, "event.observed_at"),
		monotonic_ns: nonNegativeInteger(input.monotonic_ns, "event.monotonic_ns"),
		kind: requiredString(input.kind, "event.kind"),
		severity,
		source: parseSource(input.source),
		attributes: structuredRecord(input.attributes ?? {}, "event.attributes"),
		phase: optionalString(input.phase, "event.phase"),
		state: optionalString(input.state, "event.state"),
		summary: optionalDisplayString(input.summary, "event.summary"),
		correlation,
		duration_ms: duration,
		privacy_class: optionalString(input.privacy_class, "event.privacy_class"),
		payload_ref: optionalString(input.payload_ref, "event.payload_ref"),
		redaction,
	};
}

function nullableCursor(value: unknown, name: string): number | null {
	return value === null ? null : safeInteger(value, name);
}

export function parseTelemetryReplayGap(value: unknown): TelemetryReplayGap {
	const input = objectValue(value, "gap");
	return {
		requested: safeInteger(input.requested, "gap.requested"),
		earliest_available: nullableCursor(
			input.earliest_available,
			"gap.earliest_available",
		),
		resume_after: safeInteger(input.resume_after, "gap.resume_after"),
	};
}

export function parseTelemetryEventsPage(value: unknown): TelemetryEventsPage {
	const input = objectValue(value, "events page");
	if (!Array.isArray(input.events) || input.events.length > 1_000) {
		throw new TelemetryProtocolError("events page.events must be a bounded array");
	}
	return {
		events: input.events.map(parseTelemetryEvent),
		gap: input.gap === null ? null : parseTelemetryReplayGap(input.gap),
		next_cursor: nullableCursor(input.next_cursor, "events page.next_cursor"),
	};
}

export function parseTelemetryEventResponse(value: unknown): TelemetryEvent {
	return parseTelemetryEvent(objectValue(value, "event response").event);
}

function parseSourceHealth(value: unknown): TelemetrySourceHealth {
	const input = objectValue(value, "source health");
	if (input.status !== "healthy" && input.status !== "stale") {
		throw new TelemetryProtocolError("source health.status is invalid");
	}
	return {
		source: parseSource(input.source),
		last_event_at: timestamp(input.last_event_at, "source health.last_event_at"),
		last_event_age_seconds: nonNegativeNumber(
			input.last_event_age_seconds,
			"source health.last_event_age_seconds",
		),
		status: input.status,
	};
}

export function parseTelemetrySourcesResponse(value: unknown): readonly TelemetrySourceHealth[] {
	const input = objectValue(value, "sources response");
	if (!Array.isArray(input.sources) || input.sources.length > MAX_ARRAY_ITEMS) {
		throw new TelemetryProtocolError("sources response.sources must be a bounded array");
	}
	return input.sources.map(parseSourceHealth);
}

export function parseTelemetryHealth(value: unknown): TelemetryHealth {
	const input = objectValue(value, "health");
	if (input.status !== "idle" && input.status !== "healthy" && input.status !== "degraded") {
		throw new TelemetryProtocolError("health.status is invalid");
	}
	const countersInput = objectValue(input.counters, "health.counters");
	const counters = Object.fromEntries(
		HEALTH_COUNTER_KEYS.map((name) => [
			name,
			safeInteger(countersInput[name], `health.counters.${name}`),
		]),
	) as unknown as TelemetryHealth["counters"];
	const memory = objectValue(input.memory_tail, "health.memory_tail");
	if (!Array.isArray(input.sources) || input.sources.length > MAX_ARRAY_ITEMS) {
		throw new TelemetryProtocolError("health.sources must be a bounded array");
	}
	return {
		status: input.status,
		counters,
		memory_tail: {
			size: safeInteger(memory.size, "health.memory_tail.size"),
			capacity: safeInteger(memory.capacity, "health.memory_tail.capacity"),
		},
		sources: input.sources.map(parseSourceHealth),
	};
}
