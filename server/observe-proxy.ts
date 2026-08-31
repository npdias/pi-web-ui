import { once, type EventEmitter } from "node:events";
import type { Request, Response } from "express";
import express from "express";

const DEFAULT_OBSERVE_UPSTREAM = "http://127.0.0.1:8765";
const QUERY_LENGTH_LIMIT = 2_048;
const LAST_EVENT_ID_LENGTH_LIMIT = 64;
const JSON_RESPONSE_BYTE_LIMIT = 16 * 1024 * 1024;
const MAX_CONCURRENT_UPSTREAM_REQUESTS = 16;
const HEADER_TIMEOUT_MS = 5_000;
const JSON_TIMEOUT_MS = 10_000;
const SSE_IDLE_TIMEOUT_MS = 35_000;
const MAX_QUERY_LIMIT = 1_000;

const EVENT_QUERY_KEYS = new Set([
	"after",
	"before",
	"cursor",
	"limit",
	"source",
	"kind",
	"severity",
	"trace_id",
]);
const STREAM_QUERY_KEYS = new Set([
	"after",
	"cursor",
	"source",
	"kind",
	"severity",
	"trace_id",
]);
const SEVERITIES = new Set(["debug", "info", "warning", "error", "critical"]);
const INTEGER_QUERY_KEYS = new Set(["after", "before", "cursor", "limit"]);
const FILTER_QUERY_KEYS = new Set(["source", "kind", "severity", "trace_id"]);

class ObserveProxyError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** @internal Exported so abort/listener cleanup stays regression-tested. */
export async function waitForObserveDrain(
	emitter: EventEmitter,
	signal: AbortSignal,
): Promise<void> {
	await once(emitter, "drain", { signal });
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.startsWith("[") && hostname.endsWith("]")
		? hostname.slice(1, -1)
		: hostname;
	if (normalized === "localhost" || normalized === "::1") return true;
	const octets = normalized.split(".");
	return (
		octets.length === 4 &&
		octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
		Number(octets[0]) === 127
	);
}

export function resolveObserveUpstream(raw?: string): URL {
	const value = raw?.trim() || DEFAULT_OBSERVE_UPSTREAM;
	let upstream: URL;
	try {
		upstream = new URL(value);
	} catch {
		throw new Error("UA_TELEMETRY_HTTP must be a valid URL");
	}
	if (
		upstream.protocol !== "http:" ||
		!isLoopbackHostname(upstream.hostname) ||
		upstream.username ||
		upstream.password ||
		upstream.pathname !== "/" ||
		upstream.search ||
		upstream.hash
	) {
		throw new Error("UA_TELEMETRY_HTTP must be a loopback HTTP origin");
	}
	return upstream;
}

function requestSearchParams(req: Request): URLSearchParams {
	const queryIndex = req.originalUrl.indexOf("?");
	if (queryIndex < 0) return new URLSearchParams();
	const rawQuery = req.originalUrl.slice(queryIndex + 1);
	if (rawQuery.length > QUERY_LENGTH_LIMIT) {
		throw new ObserveProxyError(400, "query string is too long");
	}
	return new URLSearchParams(rawQuery);
}

function validUnsignedInteger(value: string): boolean {
	if (!/^(0|[1-9]\d*)$/.test(value)) return false;
	return Number.isSafeInteger(Number(value));
}

function validatedQuery(req: Request, allowed: ReadonlySet<string>): URLSearchParams {
	const input = requestSearchParams(req);
	const output = new URLSearchParams();
	const seen = new Set<string>();
	for (const [name, value] of input) {
		// PI_WEB_TOKEN auth middleware consumes this browser-only query value.
		// Never forward it to telemetry core or reject Vite-relative requests for it.
		if (name === "token") continue;
		if (!allowed.has(name)) {
			throw new ObserveProxyError(400, "unsupported query parameter");
		}
		if (seen.has(name)) {
			throw new ObserveProxyError(400, `${name} must occur once`);
		}
		seen.add(name);
		if (INTEGER_QUERY_KEYS.has(name)) {
			if (!validUnsignedInteger(value)) {
				throw new ObserveProxyError(400, `${name} must be a non-negative integer`);
			}
			if (name === "limit") {
				const limit = Number(value);
				if (limit < 1 || limit > MAX_QUERY_LIMIT) {
					throw new ObserveProxyError(
						400,
						`limit must be between 1 and ${MAX_QUERY_LIMIT}`,
					);
				}
			}
		} else if (FILTER_QUERY_KEYS.has(name)) {
			if (value.length === 0) {
				throw new ObserveProxyError(400, `${name} is invalid`);
			}
			if (name === "severity" && !SEVERITIES.has(value)) {
				throw new ObserveProxyError(400, "severity is invalid");
			}
		}
		output.append(name, value);
	}
	if (output.has("after") && output.has("cursor")) {
		throw new ObserveProxyError(400, "use either after or cursor");
	}
	return output;
}

function validatedLastEventId(req: Request, query: URLSearchParams): string | undefined {
	const raw = req.headers["last-event-id"];
	if (raw === undefined) return undefined;
	if (
		Array.isArray(raw) ||
		raw.length === 0 ||
		raw.length > LAST_EVENT_ID_LENGTH_LIMIT ||
		!validUnsignedInteger(raw)
	) {
		throw new ObserveProxyError(400, "Last-Event-ID must be a non-negative integer");
	}
	if (query.has("after") || query.has("cursor")) {
		throw new ObserveProxyError(400, "use either Last-Event-ID or query cursor");
	}
	return raw;
}

function validatedEventId(value: string): string {
	if (value.trim().length === 0) {
		throw new ObserveProxyError(400, "event id is invalid");
	}
	return value;
}

function telemetryUrl(upstream: URL, path: string, query: URLSearchParams): URL {
	const target = new URL(path, upstream);
	target.search = query.toString();
	return target;
}

function attachDownstreamAbort(
	req: Request,
	res: Response,
	controller: AbortController,
): () => void {
	const abort = () => controller.abort();
	const abortIfOpen = () => {
		if (!res.writableEnded) controller.abort();
	};
	req.once("aborted", abort);
	res.once("close", abortIfOpen);
	return () => {
		req.off("aborted", abort);
		res.off("close", abortIfOpen);
	};
}

async function fetchUpstream(
	target: URL,
	headers: Record<string, string>,
	controller: AbortController,
): Promise<globalThis.Response> {
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, HEADER_TIMEOUT_MS);
	try {
		const response = await fetch(target, {
			method: "GET",
			headers,
			redirect: "manual",
			signal: controller.signal,
		});
		if (response.status >= 300 && response.status < 400) {
			throw new ObserveProxyError(502, "telemetry upstream redirect rejected");
		}
		return response;
	} catch (error) {
		if (timedOut) {
			throw new ObserveProxyError(504, "telemetry upstream timed out");
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function readBoundedJson(
	response: globalThis.Response,
	controller: AbortController,
): Promise<Buffer> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > JSON_RESPONSE_BYTE_LIMIT) {
		controller.abort();
		throw new ObserveProxyError(413, "telemetry upstream response is too large");
	}
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, JSON_TIMEOUT_MS);
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = Buffer.from(value);
			total += chunk.byteLength;
			if (total > JSON_RESPONSE_BYTE_LIMIT) {
				controller.abort();
				throw new ObserveProxyError(413, "telemetry upstream response is too large");
			}
			chunks.push(chunk);
		}
		return Buffer.concat(chunks, total);
	} catch (error) {
		if (timedOut) {
			throw new ObserveProxyError(504, "telemetry upstream timed out");
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function writeSse(
	response: globalThis.Response,
	res: Response,
	controller: AbortController,
): Promise<void> {
	if (!response.body) {
		throw new ObserveProxyError(502, "telemetry upstream stream is empty");
	}
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().startsWith("text/event-stream")) {
		throw new ObserveProxyError(502, "telemetry upstream returned an invalid stream");
	}
	res.status(200);
	res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	res.flushHeaders();

	const reader = response.body.getReader();
	let idleTimeout: ReturnType<typeof setTimeout> | undefined;
	const armIdleTimeout = () => {
		if (idleTimeout) clearTimeout(idleTimeout);
		idleTimeout = setTimeout(() => controller.abort(), SSE_IDLE_TIMEOUT_MS);
	};
	armIdleTimeout();
	try {
		while (!controller.signal.aborted) {
			const { done, value } = await reader.read();
			if (done) break;
			armIdleTimeout();
			if (!res.write(Buffer.from(value))) {
				await waitForObserveDrain(res, controller.signal);
			}
		}
		if (!res.writableEnded && !res.destroyed) res.end();
	} finally {
		if (idleTimeout) clearTimeout(idleTimeout);
	}
}

function sendError(res: Response, error: unknown): void {
	if (res.headersSent || res.writableEnded || res.destroyed) {
		if (!res.destroyed) res.destroy();
		return;
	}
	if (error instanceof ObserveProxyError) {
		res.status(error.status).json({ error: error.message });
		return;
	}
	res.status(502).json({ error: "telemetry upstream unavailable" });
}

export function createObserveProxyRouter() {
	const router = express.Router();
	let activeUpstreamRequests = 0;
	let upstream: URL | undefined;
	try {
		upstream = resolveObserveUpstream(process.env.UA_TELEMETRY_HTTP);
	} catch {
		// Invalid optional config must not stop Pi UI or agent work. Observe fails closed.
	}

	router.use((req, res, next) => {
		if (req.method !== "GET") {
			res.setHeader("Allow", "GET");
			res.status(405).json({ error: "method not allowed" });
			return;
		}
		next();
	});

	router.use((_req, res, next) => {
		if (activeUpstreamRequests >= MAX_CONCURRENT_UPSTREAM_REQUESTS) {
			res.status(503).json({ error: "observe proxy busy" });
			return;
		}
		activeUpstreamRequests++;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			activeUpstreamRequests--;
		};
		res.once("finish", release);
		res.once("close", release);
		next();
	});

	const proxyJson =
		(path: (req: Request) => string, allowed: ReadonlySet<string>) =>
		async (req: Request, res: Response) => {
			if (!upstream) {
				res.status(503).json({ error: "telemetry upstream unavailable" });
				return;
			}
			const controller = new AbortController();
			const detachAbort = attachDownstreamAbort(req, res, controller);
			try {
				const query = validatedQuery(req, allowed);
				const response = await fetchUpstream(
					telemetryUrl(upstream, path(req), query),
					{ Accept: "application/json" },
					controller,
				);
				const body = await readBoundedJson(response, controller);
				if (controller.signal.aborted && !body.length) return;
				res.status(response.status);
				res.setHeader("Content-Type", "application/json; charset=utf-8");
				res.setHeader("Cache-Control", "no-store");
				res.end(body);
			} catch (error) {
				sendError(res, error);
			} finally {
				detachAbort();
			}
		};

	router.get("/events", proxyJson(() => "/telemetry/events", EVENT_QUERY_KEYS));
	router.get(
		"/events/:eventId",
		proxyJson(
			(req) => `/telemetry/events/${encodeURIComponent(validatedEventId(req.params.eventId))}`,
			new Set(),
		),
	);
	router.get("/sources", proxyJson(() => "/telemetry/sources", new Set()));
	router.get("/health", proxyJson(() => "/telemetry/health", new Set()));
	router.get("/stream", async (req, res) => {
		if (!upstream) {
			res.status(503).json({ error: "telemetry upstream unavailable" });
			return;
		}
		const controller = new AbortController();
		const detachAbort = attachDownstreamAbort(req, res, controller);
		try {
			const query = validatedQuery(req, STREAM_QUERY_KEYS);
			const lastEventId = validatedLastEventId(req, query);
			const headers: Record<string, string> = { Accept: "text/event-stream" };
			if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;
			const response = await fetchUpstream(
				telemetryUrl(upstream, "/telemetry/stream", query),
				headers,
				controller,
			);
			if (response.status !== 200) {
				const body = await readBoundedJson(response, controller);
				res.status(response.status);
				res.setHeader("Content-Type", "application/json; charset=utf-8");
				res.setHeader("Cache-Control", "no-store");
				res.end(body);
				return;
			}
			await writeSse(response, res, controller);
		} catch (error) {
			sendError(res, error);
		} finally {
			detachAbort();
		}
	});

	router.use((_req, res) => {
		res.status(404).json({ error: "not found" });
	});
	return router;
}
