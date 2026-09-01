import { appUrl } from "../base-url.js";
import { withToken } from "../auth-token.js";
import {
	TelemetryProtocolError,
	parseTelemetryEvent,
	parseTelemetryEventDetailResponse,
	parseTelemetryEventsPage,
	parseTelemetryHealth,
	parseTelemetryReplayGap,
	parseTelemetrySourcesResponse,
	type TelemetryEvent,
	type TelemetryEventsPage,
	type TelemetryHealth,
	type TelemetryReplayGap,
	type TelemetrySeverity,
	type TelemetrySourceHealth,
} from "./telemetry-types.js";

export interface TelemetryUiPreferences {
	readonly followLive: boolean;
	readonly timeMode: "wall" | "compressed" | "sequence";
	readonly foldTurns: boolean;
	readonly foldCalls: boolean;
}

export type TelemetryRecord =
	| { readonly type: "event"; readonly event: TelemetryEvent }
	| { readonly type: "gap"; readonly gap: TelemetryReplayGap };

export interface TelemetrySnapshot {
	readonly records: readonly TelemetryRecord[];
	readonly events: readonly TelemetryEvent[];
	readonly gaps: readonly TelemetryReplayGap[];
	readonly cursor: number | null;
	/** In-memory epoch incremented when retained high-water proves a core reset. */
	readonly coreGeneration: number;
	readonly status:
		| "idle"
		| "replaying"
		| "connecting"
		| "connected"
		| "backoff"
		| "stopped";
	readonly preferences: TelemetryUiPreferences;
}

export interface TelemetryQuery {
	readonly after?: number;
	readonly before?: number;
	readonly cursor?: number;
	readonly limit?: number;
	readonly source?: string;
	readonly kind?: string;
	readonly severity?: TelemetrySeverity;
	readonly traceId?: string;
}

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type StoreStatus = TelemetrySnapshot["status"];
type Listener = (snapshot: TelemetrySnapshot) => void;

export interface TelemetryStoreOptions {
	readonly fetch?: FetchLike;
	readonly storage?: StorageLike;
	readonly maxRecords?: number;
	readonly backoffMs?: readonly number[];
	readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

interface SseFrame {
	readonly event: string;
	readonly data: string;
	readonly id?: string;
}

const CURSOR_STORAGE_KEY = "pi-web-ui.observe.cursor.v1";
const PREFERENCES_STORAGE_KEY = "pi-web-ui.observe.preferences.v1";
const MAX_RECORDS = 10_000;
const MAX_QUERY_PAGE_SIZE = 1_000;
const REPLAY_PAGE_SIZE = 100;
const REPLAY_PAGE_LIMITS = [100, 15, 1] as const;
const MAX_REPLAY_PAGES = 100_000;
const MAX_DETAIL_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;
const DEFAULT_PREFERENCES: TelemetryUiPreferences = {
	followLive: true,
	timeMode: "wall",
	foldTurns: false,
	foldCalls: false,
};

function browserStorage(): StorageLike | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timeout = setTimeout(done, delayMs);
		function done() {
			signal.removeEventListener("abort", aborted);
			resolve();
		}
		function aborted() {
			clearTimeout(timeout);
			reject(signal.reason);
		}
		signal.addEventListener("abort", aborted, { once: true });
	});
}

function loadCursor(storage: StorageLike | undefined): {
	readonly cursor: number;
	readonly persisted: boolean;
} {
	if (!storage) return { cursor: 0, persisted: false };
	try {
		const raw = storage.getItem(CURSOR_STORAGE_KEY);
		if (raw === null || !/^(0|[1-9]\d*)$/.test(raw)) {
			return { cursor: 0, persisted: false };
		}
		const cursor = Number(raw);
		return Number.isSafeInteger(cursor)
			? { cursor, persisted: true }
			: { cursor: 0, persisted: false };
	} catch {
		return { cursor: 0, persisted: false };
	}
}

function parsePreferences(value: unknown): TelemetryUiPreferences | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	if (
		typeof input.followLive !== "boolean" ||
		(input.timeMode !== "wall" &&
			input.timeMode !== "compressed" &&
			input.timeMode !== "sequence") ||
		typeof input.foldTurns !== "boolean" ||
		typeof input.foldCalls !== "boolean"
	) {
		return null;
	}
	return {
		followLive: input.followLive,
		timeMode: input.timeMode,
		foldTurns: input.foldTurns,
		foldCalls: input.foldCalls,
	};
}

function loadPreferences(storage: StorageLike | undefined): TelemetryUiPreferences {
	if (!storage) return DEFAULT_PREFERENCES;
	try {
		const raw = storage.getItem(PREFERENCES_STORAGE_KEY);
		if (raw === null) return DEFAULT_PREFERENCES;
		return parsePreferences(JSON.parse(raw)) ?? DEFAULT_PREFERENCES;
	} catch {
		return DEFAULT_PREFERENCES;
	}
}

function validateStoreOptions(options: TelemetryStoreOptions): {
	maxRecords: number;
	backoffMs: readonly number[];
} {
	const maxRecords = options.maxRecords ?? MAX_RECORDS;
	if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) {
		throw new Error(`maxRecords must be between 1 and ${MAX_RECORDS}`);
	}
	const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
	if (
		backoffMs.length === 0 ||
		backoffMs.some(
			(value) =>
				!Number.isFinite(value) ||
				!Number.isInteger(value) ||
				value < 0 ||
				value > 60_000,
		)
	) {
		throw new Error("backoffMs must contain delays between 0 and 60000");
	}
	return { maxRecords, backoffMs: [...backoffMs] };
}

function queryInteger(value: number | undefined, name: string): string | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative safe integer`);
	}
	return String(value);
}

function queryFilter(value: string | undefined, name: string): string | undefined {
	if (value === undefined) return undefined;
	if (value.length === 0) {
		throw new Error(`${name} is invalid`);
	}
	return value;
}

function queryUrl(query: TelemetryQuery): string {
	if (query.after !== undefined && query.cursor !== undefined) {
		throw new Error("use either after or cursor");
	}
	if (query.limit !== undefined && (query.limit < 1 || query.limit > MAX_QUERY_PAGE_SIZE)) {
		throw new Error(`limit must be between 1 and ${MAX_QUERY_PAGE_SIZE}`);
	}
	const params = new URLSearchParams();
	for (const [name, value] of [
		["after", queryInteger(query.after, "after")],
		["before", queryInteger(query.before, "before")],
		["cursor", queryInteger(query.cursor, "cursor")],
		["limit", queryInteger(query.limit, "limit")],
		["source", queryFilter(query.source, "source")],
		["kind", queryFilter(query.kind, "kind")],
		["severity", queryFilter(query.severity, "severity")],
		["trace_id", queryFilter(query.traceId, "traceId")],
	] as const) {
		if (value !== undefined) params.set(name, value);
	}
	const suffix = params.size > 0 ? `?${params.toString()}` : "";
	return appUrl(`/api/observe/events${suffix}`);
}

function recordSequence(record: TelemetryRecord): number {
	return record.type === "event" ? record.event.sequence : record.gap.resume_after;
}

function recordOrder(record: TelemetryRecord): number {
	return record.type === "gap" ? 0 : 1;
}

function gapKey(gap: TelemetryReplayGap): string {
	return `${gap.requested}:${gap.earliest_available ?? "none"}:${gap.resume_after}`;
}

function pageHighWater(page: TelemetryEventsPage): number {
	let highWater = page.next_cursor ?? page.gap?.resume_after ?? 0;
	for (const event of page.events) highWater = Math.max(highWater, event.sequence);
	return highWater;
}

function aborted(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

class TelemetryHttpError extends TelemetryProtocolError {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function smallerReplayPageSize(limit: number): number | null {
	return REPLAY_PAGE_LIMITS.find((candidate) => candidate < limit) ?? null;
}

async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Size rejection remains authoritative even when upstream cancellation fails.
	}
}

async function readBoundedResponseText(
	response: Response,
	limit: number,
	name: string,
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				try {
					await reader.cancel();
				} catch {
					// Reject oversized content even when upstream cancellation fails.
				}
				throw new TelemetryProtocolError(`${name} exceeds 1 MiB`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

export class TelemetryStore {
	private readonly fetchImpl: FetchLike;
	private readonly storage: StorageLike | undefined;
	private readonly maxRecords: number;
	private readonly backoffMs: readonly number[];
	private readonly sleepImpl: (delayMs: number, signal: AbortSignal) => Promise<void>;
	private readonly listeners = new Set<Listener>();
	private readonly eventSequences = new Set<number>();
	private readonly gapKeys = new Set<string>();
	private records: TelemetryRecord[] = [];
	private cursor: number | null;
	private preferences: TelemetryUiPreferences;
	private status: StoreStatus = "idle";
	private coreGeneration = 0;
	private generation = 0;
	private controller: AbortController | undefined;
	private replayPageSize = REPLAY_PAGE_SIZE;

	constructor(options: TelemetryStoreOptions = {}) {
		const validated = validateStoreOptions(options);
		this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
		this.storage = options.storage ?? browserStorage();
		this.maxRecords = validated.maxRecords;
		this.backoffMs = validated.backoffMs;
		this.sleepImpl = options.sleep ?? defaultSleep;
		const loadedCursor = loadCursor(this.storage);
		this.cursor = loadedCursor.cursor;
		this.preferences = loadPreferences(this.storage);
	}

	async connect(): Promise<void> {
		this.controller?.abort();
		const generation = ++this.generation;
		const controller = new AbortController();
		this.controller = controller;
		this.setStatus("replaying");
		try {
			await this.hydrateHistory(generation, controller.signal);
			if (!this.isActive(generation, controller.signal)) return;
			await this.replay(generation, controller.signal);
		} catch (error) {
			if (!this.isActive(generation, controller.signal)) return;
			if (aborted(error, controller.signal)) return;
			this.setStatus("backoff");
		}
		if (!this.isActive(generation, controller.signal)) return;
		void this.streamLoop(generation, controller);
	}

	disconnect(): void {
		this.generation++;
		this.controller?.abort();
		this.controller = undefined;
		this.setStatus("stopped");
	}

	async query(query: TelemetryQuery = {}): Promise<TelemetryEventsPage> {
		return this.fetchPage(query);
	}

	/** Fetch one exact selected envelope. It is returned only to the caller. */
	async fetchEventById(eventId: string, signal?: AbortSignal): Promise<TelemetryEvent> {
		if (eventId.trim().length === 0) {
			throw new Error("eventId must be a non-empty string");
		}
		const url = withToken(
			appUrl(`/api/observe/events/${encodeURIComponent(eventId)}`),
		);
		const response = await this.fetchImpl(url, {
			method: "GET",
			headers: { Accept: "application/json" },
			credentials: "same-origin",
			signal,
		});
		if (!response.ok) {
			throw new TelemetryHttpError(
				response.status,
				`telemetry event detail failed with HTTP ${response.status}`,
			);
		}
		const declaredLength = response.headers.get("content-length");
		if (
			declaredLength !== null &&
			Number.isFinite(Number(declaredLength)) &&
			Number(declaredLength) > MAX_DETAIL_RESPONSE_BYTES
		) {
			await cancelResponseBody(response);
			throw new TelemetryProtocolError("telemetry event detail exceeds 1 MiB");
		}
		const body = await readBoundedResponseText(
			response,
			MAX_DETAIL_RESPONSE_BYTES,
			"telemetry event detail",
		);
		let value: unknown;
		try {
			value = JSON.parse(body);
		} catch {
			throw new TelemetryProtocolError("telemetry event detail returned invalid JSON");
		}
		const event = parseTelemetryEventDetailResponse(value);
		if (event.event_id !== eventId) {
			throw new TelemetryProtocolError("telemetry event detail id does not match request");
		}
		return event;
	}

	/** Read current core health through the same authenticated Pi proxy boundary. */
	async getHealth(signal?: AbortSignal): Promise<TelemetryHealth> {
		return this.fetchJson(
			withToken(appUrl("/api/observe/health")),
			parseTelemetryHealth,
			"telemetry health",
			signal,
		);
	}

	/** Read current source health through the same authenticated Pi proxy boundary. */
	async getSources(signal?: AbortSignal): Promise<readonly TelemetrySourceHealth[]> {
		return this.fetchJson(
			withToken(appUrl("/api/observe/sources")),
			parseTelemetrySourcesResponse,
			"telemetry sources",
			signal,
		);
	}

	setPreferences(preferences: TelemetryUiPreferences): void {
		const parsed = parsePreferences(preferences);
		if (!parsed) throw new Error("preferences are invalid");
		this.preferences = parsed;
		try {
			this.storage?.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(parsed));
		} catch {
			// Browser storage is optional; in-memory preferences remain usable.
		}
		this.notify();
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	snapshot(): TelemetrySnapshot {
		const records = [...this.records];
		return {
			records,
			events: records.flatMap((record) =>
				record.type === "event" ? [record.event] : [],
			),
			gaps: records.flatMap((record) => (record.type === "gap" ? [record.gap] : [])),
			cursor: this.cursor,
			coreGeneration: this.coreGeneration,
			status: this.status,
			preferences: { ...this.preferences },
		};
	}

	private async fetchPage(
		query: TelemetryQuery,
		signal?: AbortSignal,
	): Promise<TelemetryEventsPage> {
		return this.fetchJson(
			withToken(queryUrl(query)),
			parseTelemetryEventsPage,
			"telemetry query",
			signal,
		);
	}

	private async fetchReplayPage(
		query: TelemetryQuery,
		signal: AbortSignal,
	): Promise<{ readonly page: TelemetryEventsPage; readonly limit: number }> {
		let limit = Math.min(query.limit ?? this.replayPageSize, this.replayPageSize);
		while (true) {
			try {
				const page = await this.fetchPage({ ...query, limit }, signal);
				return { page, limit };
			} catch (error) {
				if (!(error instanceof TelemetryHttpError) || error.status !== 413) throw error;
				const nextLimit = smallerReplayPageSize(limit);
				if (nextLimit === null) throw error;
				limit = nextLimit;
				this.replayPageSize = Math.min(this.replayPageSize, nextLimit);
			}
		}
	}

	private async fetchJson<T>(
		url: string,
		parse: (value: unknown) => T,
		name: string,
		signal?: AbortSignal,
	): Promise<T> {
		const response = await this.fetchImpl(url, {
			method: "GET",
			headers: { Accept: "application/json" },
			credentials: "same-origin",
			signal,
		});
		if (!response.ok) {
			throw new TelemetryHttpError(
				response.status,
				`${name} failed with HTTP ${response.status}`,
			);
		}
		let value: unknown;
		try {
			value = await response.json();
		} catch {
			throw new TelemetryProtocolError(`${name} returned invalid JSON`);
		}
		return parse(value);
	}

	private async replay(generation: number, signal: AbortSignal): Promise<void> {
		for (let pageNumber = 0; pageNumber < MAX_REPLAY_PAGES; pageNumber++) {
			const startingCursor = this.cursor;
			const { page, limit } = await this.fetchReplayPage(
				{
					after: startingCursor ?? undefined,
					limit: this.replayPageSize,
				},
				signal,
			);
			if (!this.isActive(generation, signal)) return;
			this.addEvents(page.events);
			if (page.gap) {
				this.addGap(page.gap);
				this.advanceCursor(page.gap.resume_after);
				this.notify();
				if (page.gap.earliest_available !== null) continue;
				return;
			}
			if (page.events.length > 0) {
				const highestSequence = page.events.reduce(
					(highest, event) => Math.max(highest, event.sequence),
					0,
				);
				this.advanceCursor(Math.max(highestSequence, page.next_cursor ?? 0));
				this.notify();
			}
			if (
				page.events.length < limit ||
				page.next_cursor === null ||
				page.next_cursor <= (startingCursor ?? 0)
			) {
				return;
			}
			this.advanceCursor(page.next_cursor);
		}
		throw new TelemetryProtocolError("telemetry replay exceeded page limit");
	}

	private async hydrateHistory(generation: number, signal: AbortSignal): Promise<void> {
		let before = Number.MAX_SAFE_INTEGER;
		let remaining = this.maxRecords;
		let firstPage = true;
		while (remaining > 0) {
			const requestedLimit = Math.min(this.replayPageSize, remaining);
			const { page, limit } = await this.fetchReplayPage(
				{ before, limit: requestedLimit },
				signal,
			);
			if (!this.isActive(generation, signal)) return;
			if (firstPage) {
				const highWater = pageHighWater(page);
				if (this.cursor !== null && highWater < this.cursor) this.clearRecords();
				this.replaceCursor(highWater);
				firstPage = false;
			}
			this.addEvents(page.events);
			if (page.gap) this.addGap(page.gap);
			this.notify();
			remaining -= page.events.length;
			if (page.gap || page.events.length === 0 || page.events.length < limit) return;
			const oldestSequence = page.events.reduce(
				(oldest, event) => Math.min(oldest, event.sequence),
				Number.MAX_SAFE_INTEGER,
			);
			if (oldestSequence <= 0 || oldestSequence >= before) return;
			before = oldestSequence;
		}
	}

	private async streamLoop(
		generation: number,
		controller: AbortController,
	): Promise<void> {
		let retry = 0;
		while (this.isActive(generation, controller.signal)) {
			let resumeFromGap = false;
			try {
				resumeFromGap =
					(await this.openStream(generation, controller.signal)) === "gap";
			} catch (error) {
				if (!this.isActive(generation, controller.signal)) return;
				if (aborted(error, controller.signal)) return;
			}
			if (!this.isActive(generation, controller.signal)) return;
			this.setStatus("backoff");
			const delay = this.backoffMs[Math.min(retry, this.backoffMs.length - 1)];
			retry++;
			try {
				await this.sleepImpl(delay, controller.signal);
			} catch {
				return;
			}
			if (!this.isActive(generation, controller.signal)) return;
			this.setStatus("replaying");
			try {
				if (!resumeFromGap) {
					await this.hydrateHistory(generation, controller.signal);
					if (!this.isActive(generation, controller.signal)) return;
				}
				await this.replay(generation, controller.signal);
			} catch (error) {
				if (!this.isActive(generation, controller.signal)) return;
				if (aborted(error, controller.signal)) return;
				continue;
			}
		}
	}

	private async openStream(
		generation: number,
		signal: AbortSignal,
	): Promise<"eof" | "gap"> {
		this.setStatus("connecting");
		const headers = new Headers({ Accept: "text/event-stream" });
		if (this.cursor !== null) headers.set("Last-Event-ID", String(this.cursor));
		const response = await this.fetchImpl(withToken(appUrl("/api/observe/stream")), {
			method: "GET",
			headers,
			credentials: "same-origin",
			signal,
		});
		if (!this.isActive(generation, signal)) return "eof";
		if (!response.ok) {
			throw new TelemetryProtocolError(
				`telemetry stream failed with HTTP ${response.status}`,
			);
		}
		if (
			!(response.headers.get("content-type") ?? "")
				.toLowerCase()
				.startsWith("text/event-stream")
		) {
			throw new TelemetryProtocolError("telemetry stream returned invalid content type");
		}
		if (!response.body) {
			throw new TelemetryProtocolError("telemetry stream returned no body");
		}
		this.setStatus("connected");
		for await (const frame of sseFrames(response.body)) {
			if (!this.isActive(generation, signal)) return "eof";
			if (frame.event === "telemetry") {
				const item = parseFrameJson(frame.data, parseTelemetryEvent, "telemetry event");
				if (frame.id !== undefined) {
					if (!/^(0|[1-9]\d*)$/.test(frame.id) || Number(frame.id) !== item.sequence) {
						throw new TelemetryProtocolError("telemetry SSE id does not match sequence");
					}
				}
				this.addEvents([item]);
				this.advanceCursor(item.sequence);
				this.notify();
				continue;
			}
			if (frame.event === "gap") {
				const gap = parseFrameJson(frame.data, parseTelemetryReplayGap, "telemetry gap");
				this.addGap(gap);
				this.advanceCursor(gap.resume_after);
				this.notify();
				return "gap";
			}
		}
		return "eof";
	}

	private isActive(generation: number, signal: AbortSignal): boolean {
		return generation === this.generation && !signal.aborted;
	}

	private setStatus(status: StoreStatus): void {
		if (this.status === status) return;
		this.status = status;
		this.notify();
	}

	private addEvents(events: readonly TelemetryEvent[]): void {
		for (const event of events) {
			if (this.eventSequences.has(event.sequence)) continue;
			this.eventSequences.add(event.sequence);
			this.insertRecord({ type: "event", event });
		}
	}

	private addGap(gap: TelemetryReplayGap): void {
		const key = gapKey(gap);
		if (this.gapKeys.has(key)) return;
		this.gapKeys.add(key);
		this.insertRecord({ type: "gap", gap });
	}

	private insertRecord(record: TelemetryRecord): void {
		const sequence = recordSequence(record);
		const order = recordOrder(record);
		let low = 0;
		let high = this.records.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			const candidate = this.records[middle];
			const candidateSequence = recordSequence(candidate);
			if (
				candidateSequence < sequence ||
				(candidateSequence === sequence && recordOrder(candidate) <= order)
			) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		this.records.splice(low, 0, record);
		while (this.records.length > this.maxRecords) {
			const removed = this.records.shift();
			if (!removed) break;
			if (removed.type === "event") this.eventSequences.delete(removed.event.sequence);
			else this.gapKeys.delete(gapKey(removed.gap));
		}
	}

	private advanceCursor(value: number | null | undefined): void {
		if (value === null || value === undefined) return;
		if (this.cursor !== null && value <= this.cursor) return;
		this.replaceCursor(value);
	}

	private replaceCursor(value: number): void {
		this.cursor = value;
		try {
			this.storage?.setItem(CURSOR_STORAGE_KEY, String(value));
		} catch {
			// Cursor remains usable for this page when browser storage is unavailable.
		}
	}

	private clearRecords(): void {
		this.records = [];
		this.eventSequences.clear();
		this.gapKeys.clear();
		this.coreGeneration++;
	}

	private notify(): void {
		if (this.listeners.size === 0) return;
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}

function parseFrameJson<T>(
	data: string,
	parse: (value: unknown) => T,
	name: string,
): T {
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		throw new TelemetryProtocolError(`${name} contains invalid JSON`);
	}
	return parse(value);
}

async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let event = "message";
	let id: string | undefined;
	let data: string[] = [];

	const consumeLine = (line: string): SseFrame | undefined => {
		if (line === "") {
			if (data.length === 0) {
				event = "message";
				id = undefined;
				return undefined;
			}
			const frame = { event, data: data.join("\n"), id };
			event = "message";
			id = undefined;
			data = [];
			return frame;
		}
		if (line.startsWith(":")) return undefined;
		const separator = line.indexOf(":");
		const field = separator < 0 ? line : line.slice(0, separator);
		let value = separator < 0 ? "" : line.slice(separator + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value || "message";
		else if (field === "data") data.push(value);
		else if (field === "id" && !value.includes("\u0000")) id = value;
		return undefined;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				const frame = consumeLine(line);
				if (frame) yield frame;
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0) {
			const frame = consumeLine(
				buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer,
			);
			if (frame) yield frame;
		}
		const finalFrame = consumeLine("");
		if (finalFrame) yield finalFrame;
	} finally {
		reader.releaseLock();
	}
}
