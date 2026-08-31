import { appUrl } from "../base-url.js";
import { withToken } from "../auth-token.js";
import {
	TelemetryProtocolError,
	parseTelemetryEvent,
	parseTelemetryEventsPage,
	parseTelemetryReplayGap,
	type TelemetryEvent,
	type TelemetryEventsPage,
	type TelemetryReplayGap,
	type TelemetrySeverity,
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
const REPLAY_PAGE_SIZE = 1_000;
const MAX_REPLAY_PAGES = 100_000;
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
	if (query.limit !== undefined && (query.limit < 1 || query.limit > REPLAY_PAGE_SIZE)) {
		throw new Error(`limit must be between 1 and ${REPLAY_PAGE_SIZE}`);
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
	private generation = 0;
	private controller: AbortController | undefined;

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
			status: this.status,
			preferences: { ...this.preferences },
		};
	}

	private async fetchPage(
		query: TelemetryQuery,
		signal?: AbortSignal,
	): Promise<TelemetryEventsPage> {
		const response = await this.fetchImpl(withToken(queryUrl(query)), {
			method: "GET",
			headers: { Accept: "application/json" },
			credentials: "same-origin",
			signal,
		});
		if (!response.ok) {
			throw new TelemetryProtocolError(
				`telemetry query failed with HTTP ${response.status}`,
			);
		}
		let value: unknown;
		try {
			value = await response.json();
		} catch {
			throw new TelemetryProtocolError("telemetry query returned invalid JSON");
		}
		return parseTelemetryEventsPage(value);
	}

	private async replay(generation: number, signal: AbortSignal): Promise<void> {
		for (let pageNumber = 0; pageNumber < MAX_REPLAY_PAGES; pageNumber++) {
			const startingCursor = this.cursor;
			const page = await this.fetchPage(
				{
					after: startingCursor ?? undefined,
					limit: REPLAY_PAGE_SIZE,
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
				page.events.length < REPLAY_PAGE_SIZE ||
				page.next_cursor === null ||
				page.next_cursor === startingCursor
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
			const limit = Math.min(REPLAY_PAGE_SIZE, remaining);
			const page = await this.fetchPage({ before, limit }, signal);
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
