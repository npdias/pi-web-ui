import { describe, expect, it } from "vitest";
import { TelemetryStore } from "../../web/src/observe/telemetry-store.js";
import type {
	TelemetryEvent,
	TelemetryEventsPage,
} from "../../web/src/observe/telemetry-types.js";
import {
	parseTelemetryEvent,
	parseTelemetryEventResponse,
	parseTelemetryHealth,
	parseTelemetrySourcesResponse,
} from "../../web/src/observe/telemetry-types.js";

function event(sequence: number, overrides: Record<string, unknown> = {}): TelemetryEvent {
	return {
		schema_version: 1,
		event_id: `tel_${sequence}`,
		sequence,
		observed_at: "2026-08-31T10:00:00-05:00",
		monotonic_ns: sequence,
		kind: "agent.turn",
		severity: "info",
		source: {
			robot_id: "robot-01",
			host_id: "robot-01",
			component: "pi",
		},
		attributes: {},
		...overrides,
	} as TelemetryEvent;
}

function page(
	events: unknown[],
	gap: TelemetryEventsPage["gap"] = null,
	nextCursor: number | null = null,
) {
	return new Response(
		JSON.stringify({ events, gap, next_cursor: nextCursor }),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

function pendingResponse(signal?: AbortSignal | null): Promise<Response> {
	return new Promise((_resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

function sse(frames: string): Response {
	return new Response(frames, {
		status: 200,
		headers: { "Content-Type": "text/event-stream; charset=utf-8" },
	});
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition not met");
}

class MemoryStorage {
	readonly values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}
}

describe("TelemetryStore", () => {
	it("truncates core-valid long display strings without stalling later events", async () => {
		const storage = new MemoryStorage();
		const rawSummary = `prefix-${"x".repeat(70 * 1024)}-private-tail`;
		const store = new TelemetryStore({
			storage,
			fetch: async (url, init) =>
				url.includes("/events")
					? page(
							[
								event(1, { summary: rawSummary }),
								event(2, { summary: "later-event" }),
							],
							null,
							2,
						)
					: pendingResponse(init?.signal),
		});

		await store.connect();

		expect(store.snapshot().events.map((item) => item.sequence)).toEqual([1, 2]);
		expect(store.snapshot().cursor).toBe(2);
		expect(store.snapshot().events[0].summary).toMatch(/\[TRUNCATED\]$/);
		expect(store.snapshot().events[0].summary?.length).toBeLessThan(rawSummary.length);
		expect([...storage.values.values()].join("\n")).not.toContain("private-tail");
		store.disconnect();
	});

	it("preserves distinct long opaque identifiers without persisting them", async () => {
		const shared = "i".repeat(300);
		const traceShared = "t".repeat(300);
		const firstId = `${shared}A`;
		const secondId = `${shared}B`;
		const firstTrace = `${traceShared}A`;
		const secondTrace = `${traceShared}B`;
		const source = {
			robot_id: `${"r".repeat(300)}A`,
			host_id: `${"h".repeat(300)}A`,
			component: `${"c".repeat(300)}A`,
			instance_id: `${"n".repeat(300)}A`,
			version: `${"v".repeat(300)}A`,
		};
		const storage = new MemoryStorage();
		const store = new TelemetryStore({
			storage,
			fetch: async (url, init) =>
				url.includes("/events")
					? page(
							[
								event(1, {
									event_id: firstId,
									kind: `${shared}kind-A`,
									source,
									correlation: { trace_id: firstTrace },
									payload_ref: `${shared}payload-A`,
								}),
								event(2, {
									event_id: secondId,
									kind: `${shared}kind-B`,
									source,
									correlation: { trace_id: secondTrace },
									payload_ref: `${shared}payload-B`,
								}),
							],
							null,
							2,
						)
					: pendingResponse(init?.signal),
		});

		await store.connect();

		const [first, second] = store.snapshot().events;
		expect(firstId).toHaveLength(301);
		expect(firstTrace).toHaveLength(301);
		expect(first.event_id).toBe(firstId);
		expect(second.event_id).toBe(secondId);
		expect(first.event_id).not.toBe(second.event_id);
		expect(parseTelemetryEventResponse({ event: first }).event_id).toBe(firstId);
		expect(parseTelemetryEventResponse({ event: second }).event_id).toBe(secondId);
		expect(first.correlation?.trace_id).toBe(firstTrace);
		expect(second.correlation?.trace_id).toBe(secondTrace);
		expect(first.kind).toBe(`${shared}kind-A`);
		expect(first.source).toEqual(source);
		expect(first.payload_ref).toBe(`${shared}payload-A`);
		const persisted = [...storage.values.values()].join("\n");
		expect(persisted).not.toContain(firstId);
		expect(persisted).not.toContain(firstTrace);
		store.disconnect();
	});

	it("keeps long source, kind, and trace filters distinct in query URLs", async () => {
		const shared = "f".repeat(300);
		const queries: URLSearchParams[] = [];
		const store = new TelemetryStore({
			fetch: async (url) => {
				queries.push(new URL(url, "http://vite.local").searchParams);
				return page([], null, null);
			},
		});

		await store.query({
			source: `${shared}A`,
			kind: `${shared}B`,
			traceId: `${shared}C`,
		});
		await store.query({ traceId: `${shared}D` });

		expect(queries[0].get("source")).toBe(`${shared}A`);
		expect(queries[0].get("kind")).toBe(`${shared}B`);
		expect(queries[0].get("trace_id")).toBe(`${shared}C`);
		expect(queries[1].get("trace_id")).toBe(`${shared}D`);
		expect(queries[0].get("trace_id")).not.toBe(queries[1].get("trace_id"));
	});

	it("orders by sequence and deduplicates replayed events", async () => {
		const calls: string[] = [];
		const store = new TelemetryStore({
			fetch: async (url, init) => {
				calls.push(url);
				if (url.includes("/events")) {
					return page([event(3), event(1), event(2), event(2)], null, 3);
				}
				return pendingResponse(init?.signal);
			},
		});

		await store.connect();

		expect(store.snapshot().events.map((item) => item.sequence)).toEqual([1, 2, 3]);
		expect(
			store.snapshot().records.map((record) =>
				record.type === "event" ? record.event.sequence : `gap:${record.gap.resume_after}`,
			),
		).toEqual([1, 2, 3]);
		expect(store.snapshot().cursor).toBe(3);
		expect(calls[0]).toBe(
			`/api/observe/events?before=${Number.MAX_SAFE_INTEGER}&limit=1000`,
		);
		store.disconnect();
	});

	it("keeps an explicit gap while reverse hydration advances to newest retained data", async () => {
		const urls: string[] = [];
		const storage = new MemoryStorage();
		const store = new TelemetryStore({
			storage,
			fetch: async (url, init) => {
				urls.push(url);
				if (
					url ===
					`/api/observe/events?before=${Number.MAX_SAFE_INTEGER}&limit=1000`
				) {
					return page(
						[event(3)],
						{ requested: 0, earliest_available: 3, resume_after: 2 },
						3,
					);
				}
				if (url === "/api/observe/events?after=3&limit=1000") {
					return page([], null, null);
				}
				return pendingResponse(init?.signal);
			},
		});

		await store.connect();

		expect(urls.slice(0, 2)).toEqual([
			`/api/observe/events?before=${Number.MAX_SAFE_INTEGER}&limit=1000`,
			"/api/observe/events?after=3&limit=1000",
		]);
		expect(
			store.snapshot().records.map((record) =>
				record.type === "event" ? record.event.sequence : `gap:${record.gap.resume_after}`,
			),
		).toEqual(["gap:2", 3]);
		expect(store.snapshot().cursor).toBe(3);
		expect([...storage.values.values()]).toContain("3");
		store.disconnect();
	});

	it("reconnects with the latest event sequence after backoff", async () => {
		const calls: Array<{ url: string; lastEventId?: string }> = [];
		const delays: number[] = [];
		let streams = 0;
		const store = new TelemetryStore({
			backoffMs: [1_000, 2_000],
			sleep: async (delay) => {
				delays.push(delay);
			},
			fetch: async (url, init) => {
				calls.push({
					url,
					lastEventId: new Headers(init?.headers).get("Last-Event-ID") ?? undefined,
				});
				if (url.includes("before=")) {
					return streams === 0
						? page([event(2)], null, 2)
						: page([event(2), event(3)], null, 3);
				}
				if (url.includes("/events")) return page([], null, null);
				streams++;
				if (streams === 1) {
					return sse(
						`id: 3\nevent: telemetry\ndata: ${JSON.stringify(event(3))}\n\n`,
					);
				}
				return pendingResponse(init?.signal);
			},
		});

		await store.connect();
		await waitFor(() => streams === 2);

		const streamCalls = calls.filter((call) => call.url.endsWith("/stream"));
		expect(streamCalls.map((call) => call.lastEventId)).toEqual(["2", "3"]);
		expect(delays[0]).toBe(1_000);
		expect(store.snapshot().events.map((item) => item.sequence)).toEqual([2, 3]);
		store.disconnect();
	});

	it("processes telemetry before an SSE gap then resumes at the lossless cursor", async () => {
		const calls: Array<{ url: string; lastEventId?: string }> = [];
		let streamCount = 0;
		const store = new TelemetryStore({
			sleep: async () => {},
			fetch: async (url, init) => {
				calls.push({
					url,
					lastEventId: new Headers(init?.headers).get("Last-Event-ID") ?? undefined,
				});
				if (url === "/api/observe/events?after=0&limit=1000") {
					return page([], null, null);
				}
				if (url === "/api/observe/events?after=5&limit=1000") {
					return page([event(6)], null, 6);
				}
				if (url.includes("/events")) return page([], null, null);
				streamCount++;
				if (streamCount === 1) {
					return sse(
						`id: 4\nevent: telemetry\ndata: ${JSON.stringify(event(4))}\n\n` +
							'event: gap\ndata: {"requested":4,"earliest_available":6,"resume_after":5}\n\n',
					);
				}
				return pendingResponse(init?.signal);
			},
		});

		await store.connect();
		await waitFor(() => store.snapshot().events.some((item) => item.sequence === 6));

		expect(
			store.snapshot().records.map((record) =>
				record.type === "event" ? record.event.sequence : `gap:${record.gap.resume_after}`,
			),
		).toEqual([4, "gap:5", 6]);
		expect(calls.some((call) => call.url === "/api/observe/events?after=5&limit=1000")).toBe(
			true,
		);
		store.disconnect();
	});

	it("bounds loaded records while older telemetry stays available through query", async () => {
		let queryCount = 0;
		const store = new TelemetryStore({
			maxRecords: 3,
			fetch: async (url, init) => {
				if (url.includes("/events")) {
					queryCount++;
					return queryCount === 1
						? page([event(1), event(2), event(3), event(4), event(5)], null, 5)
						: page([event(1)], null, 1);
				}
				return pendingResponse(init?.signal);
			},
		});

		await store.connect();
		expect(store.snapshot().events.map((item) => item.sequence)).toEqual([3, 4, 5]);
		const older = await store.query({ before: 2, limit: 1 });
		expect(older.events.map((item) => item.sequence)).toEqual([1]);
		expect(store.snapshot().events.map((item) => item.sequence)).toEqual([3, 4, 5]);
		store.disconnect();
	});

	it("persists cursor and bounded UI preferences but never event payloads", async () => {
		const storage = new MemoryStorage();
		const fetcher = async (url: string, init?: RequestInit) =>
			url.includes("/events")
				? page(
						[
							event(1, {
								summary: "payload-that-must-not-persist",
								attributes: { private_value: "never-write-this" },
							}),
						],
						null,
						1,
					)
				: pendingResponse(init?.signal ?? undefined);
		const store = new TelemetryStore({
			storage,
			fetch: fetcher,
		});

		await store.connect();
		store.setPreferences({
			followLive: false,
			timeMode: "sequence",
			foldTurns: true,
			foldCalls: false,
		});

		expect(storage.values.size).toBe(2);
		const persisted = [...storage.values.values()].join("\n");
		expect(persisted).toContain('"timeMode":"sequence"');
		expect(persisted).not.toContain("payload-that-must-not-persist");
		expect(persisted).not.toContain("never-write-this");
		expect(persisted).not.toContain("tel_1");

		const restored = new TelemetryStore({ storage, fetch: fetcher });
		expect(restored.snapshot().cursor).toBe(1);
		expect(restored.snapshot().preferences).toEqual({
			followLive: false,
			timeMode: "sequence",
			foldTurns: true,
			foldCalls: false,
		});
		store.disconnect();
	});

	it("rebuilds a bounded retained view before resuming a persisted cursor", async () => {
		const storage = new MemoryStorage();
		const seed = new TelemetryStore({
			storage,
			fetch: async (url, init) =>
				url.includes("/events")
					? page([event(3)], null, 3)
					: pendingResponse(init?.signal),
		});
		await seed.connect();
		seed.disconnect();

		const urls: string[] = [];
		const refreshed = new TelemetryStore({
			storage,
			fetch: async (url, init) => {
				urls.push(url);
				if (
					url ===
					`/api/observe/events?before=${Number.MAX_SAFE_INTEGER}&limit=1000`
				) {
					return page([event(1), event(2), event(3)], null, 3);
				}
				if (url === "/api/observe/events?after=3&limit=1000") {
					return page([], null, null);
				}
				return pendingResponse(init?.signal);
			},
		});

		await refreshed.connect();

		expect(urls.slice(0, 2)).toEqual([
			`/api/observe/events?before=${Number.MAX_SAFE_INTEGER}&limit=1000`,
			"/api/observe/events?after=3&limit=1000",
		]);
		expect(refreshed.snapshot().events.map((item) => item.sequence)).toEqual([1, 2, 3]);
		refreshed.disconnect();
	});

	it("resets a persisted cursor to a restarted core high-water before streaming", async () => {
		const storage = new MemoryStorage();
		storage.setItem("pi-web-ui.observe.cursor.v1", "100");
		const calls: Array<{ url: string; lastEventId?: string }> = [];
		const store = new TelemetryStore({
			storage,
			maxRecords: 3,
			fetch: async (url, init) => {
				calls.push({
					url,
					lastEventId: new Headers(init?.headers).get("Last-Event-ID") ?? undefined,
				});
				if (url.includes("before=")) return page([event(1), event(2), event(3)], null, 3);
				if (url.includes("after=3")) return page([], null, null);
				if (url.includes("/stream")) {
					return sse(`id: 4\nevent: telemetry\ndata: ${JSON.stringify(event(4))}\n\n`);
				}
				return page([], null, null);
			},
		});

		await store.connect();
		await waitFor(() => store.snapshot().events.some((item) => item.sequence === 4));

		expect(store.snapshot().cursor).toBe(4);
		expect(storage.getItem("pi-web-ui.observe.cursor.v1")).toBe("4");
		expect(calls.find((call) => call.url.includes("/stream"))?.lastEventId).toBe("3");
		store.disconnect();
	});

	it("hydrates only the newest retained records before replay", async () => {
		const urls: string[] = [];
		let returnedEvents = 0;
		const allEvents = Array.from({ length: 3_000 }, (_, index) => event(index + 1));
		const store = new TelemetryStore({
			maxRecords: 3,
			fetch: async (url, init) => {
				urls.push(url);
				if (url.includes("before=")) {
					returnedEvents += 3;
					return page(allEvents.slice(-3), null, 3_000);
				}
				if (url.includes("after=3000")) return page([], null, null);
				if (url.includes("after=0")) {
					returnedEvents += 1_000;
					return page(allEvents.slice(0, 1_000), null, 1_000);
				}
				if (url.includes("after=1000")) {
					returnedEvents += 1_000;
					return page(allEvents.slice(1_000, 2_000), null, 2_000);
				}
				if (url.includes("after=2000")) {
					returnedEvents += 1_000;
					return page(allEvents.slice(2_000), null, 3_000);
				}
				return pendingResponse(init?.signal);
			},
		});

		await store.connect();

		expect(store.snapshot().events.map((item) => item.sequence)).toEqual([
			2_998,
			2_999,
			3_000,
		]);
		expect(returnedEvents).toBe(3);
		expect(urls.filter((url) => url.includes("/events"))).toHaveLength(2);
		store.disconnect();
	});

	it("authenticates JSON and SSE fetches through Vite-relative paths", async () => {
		const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		const authStorage = new MemoryStorage();
		authStorage.setItem("pi-web-ui:token", "dev secret");
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: authStorage,
		});
		const calls: Array<{ url: string; credentials?: RequestInit["credentials"] }> = [];
		const store = new TelemetryStore({
			storage: new MemoryStorage(),
			fetch: async (url, init) => {
				calls.push({ url, credentials: init?.credentials });
				if (url.includes("/events")) return page([], null, null);
				return pendingResponse(init?.signal);
			},
		});

		try {
			await store.connect();
			await waitFor(() => calls.some((call) => call.url.includes("/stream")));

			expect(calls.map((call) => call.url)).toEqual([
				`/api/observe/events?before=${Number.MAX_SAFE_INTEGER}&limit=1000&token=dev%20secret`,
				"/api/observe/events?after=0&limit=1000&token=dev%20secret",
				"/api/observe/stream?token=dev%20secret",
			]);
			expect(calls.every((call) => call.credentials === "same-origin")).toBe(true);
		} finally {
			store.disconnect();
			if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
			else delete (globalThis as { localStorage?: unknown }).localStorage;
		}
	});

	it("redacts secret-key attributes at the browser boundary", async () => {
		const store = new TelemetryStore({
			fetch: async (url, init) =>
				url.includes("/events")
					? page(
							[
								{
									...event(1),
									attributes: {
										authorization: "Bearer secret",
										apiKey: "secret-key",
										nested: {
											cookie: "session=secret",
											token: "generic-secret",
											authToken: "auth-secret",
											token_count: 12,
										},
									},
									unexpected_private_field: "drop-me",
								},
							],
							null,
							1,
						)
					: pendingResponse(init?.signal),
		});

		await store.connect();

		const [item] = store.snapshot().events;
		expect(item.attributes).toEqual({
			authorization: "[REDACTED]",
			apiKey: "[REDACTED]",
			nested: {
				cookie: "[REDACTED]",
				token: "[REDACTED]",
				authToken: "[REDACTED]",
				token_count: 12,
			},
		});
		expect("unexpected_private_field" in item).toBe(false);
		store.disconnect();
	});

	it("ignores late work from an aborted connection generation", async () => {
		let resolveFirst: (response: Response) => void = () => {
			throw new Error("first response was not initialized");
		};
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		let queryCount = 0;
		const store = new TelemetryStore({
			fetch: async (url, init) => {
				if (url.includes("/events")) {
					queryCount++;
					if (queryCount === 1) return firstResponse;
					return page([event(9)], null, 9);
				}
				return pendingResponse(init?.signal);
			},
		});

		const staleConnect = store.connect();
		await waitFor(() => queryCount === 1);
		const currentConnect = store.connect();
		await currentConnect;
		resolveFirst(page([event(1)], null, 1));
		await staleConnect;

		expect(store.snapshot().events.map((item) => item.sequence)).toEqual([9]);
		store.disconnect();
	});

	it("validates exact health and source response shapes", () => {
		const source = {
			source: event(1).source,
			last_event_at: "2026-08-31T10:00:00-05:00",
			last_event_age_seconds: 0.25,
			status: "healthy",
		};
		expect(parseTelemetrySourcesResponse({ sources: [source] })).toEqual([source]);
		expect(
			parseTelemetryHealth({
				status: "healthy",
				counters: {
					accepted: 1,
					rejected: 0,
					persistence_gap: 0,
					dropped: 0,
					torn_lines: 0,
					stale_sources: 0,
					retention_runs: 1,
					retention_deleted_segments: 0,
					retention_deleted_bytes: 0,
					retention_failures: 0,
				},
				memory_tail: { size: 1, capacity: 1000 },
				sources: [source],
			}),
		).toMatchObject({
			status: "healthy",
			memory_tail: { size: 1, capacity: 1000 },
			sources: [source],
		});
		expect(() => parseTelemetrySourcesResponse({ sources: [{ ...source, status: "ok" }] })).toThrow(
			/status/,
		);
		expect(() =>
			parseTelemetryHealth({
				status: "healthy",
				counters: { accepted: 1 },
				memory_tail: { size: 1, capacity: 1000 },
				sources: [source],
			}),
		).toThrow(/counter/);
		expect(
			parseTelemetryEvent({
				...event(1),
				phase: "",
				state: "",
				summary: "",
			}).summary,
		).toBe("");
		expect(
			parseTelemetryEvent({
				...event(1),
				monotonic_ns: Number.MAX_SAFE_INTEGER + 1,
			}).monotonic_ns,
		).toBe(Number.MAX_SAFE_INTEGER + 1);
	});
});
