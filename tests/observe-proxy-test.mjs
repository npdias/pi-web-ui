import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UI_PORT = 8968;
const UPSTREAM_PORT = 8969;
const UI_ORIGIN = `http://127.0.0.1:${UI_PORT}`;
const UPSTREAM_ORIGIN = `http://127.0.0.1:${UPSTREAM_PORT}`;
const UI_TOKEN = "vite-dev-token";

const tempDir = mkdtempSync(join(tmpdir(), "pi-observe-proxy-test-"));
const seen = [];
let holdNextStream = false;
let heldStreamClosedResolve;
let holdHealth = false;
const heldHealthResponses = [];

const telemetryEvent = {
	schema_version: 1,
	event_id: "tel_8",
	sequence: 8,
	observed_at: "2026-08-31T10:00:00-05:00",
	monotonic_ns: 8,
	kind: "tool.execution",
	severity: "warning",
	source: {
		robot_id: "robot-01",
		host_id: "robot-01",
		component: "pi",
	},
};

const upstream = createServer((req, res) => {
	seen.push({ method: req.method, url: req.url, headers: { ...req.headers } });
	const url = new URL(req.url ?? "/", UPSTREAM_ORIGIN);
	if (url.pathname === "/telemetry/stream") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Upstream-Secret": "must-not-cross",
		});
		if (holdNextStream) {
			holdNextStream = false;
			res.write(": heartbeat\n\n");
			res.on("close", () => heldStreamClosedResolve?.());
			return;
		}
		res.end(
			`id: 8\nevent: telemetry\ndata: ${JSON.stringify(telemetryEvent)}\n\n`,
		);
		return;
	}

	res.setHeader("Content-Type", "application/json");
	res.setHeader("X-Upstream-Secret", "must-not-cross");
	if (url.pathname === "/telemetry/events") {
		if (url.searchParams.get("kind") === "oversize") {
			res.setHeader("Content-Length", String(16 * 1024 * 1024 + 1));
			res.end("{}");
			return;
		}
		res.end(
			JSON.stringify({ events: [telemetryEvent], gap: null, next_cursor: 8 }),
		);
		return;
	}
	if (url.pathname === "/telemetry/events/tel_8") {
		res.end(JSON.stringify({ event: telemetryEvent }));
		return;
	}
	if (url.pathname === "/telemetry/sources") {
		res.end(
			JSON.stringify({
				sources: [
					{
						source: telemetryEvent.source,
						last_event_at: telemetryEvent.observed_at,
						last_event_age_seconds: 0,
						status: "healthy",
					},
				],
			}),
		);
		return;
	}
	if (url.pathname === "/telemetry/health") {
		if (holdHealth) {
			heldHealthResponses.push(res);
			return;
		}
		res.end(
			JSON.stringify({
				status: "healthy",
				counters: { accepted: 1, rejected: 0, persistence_gap: 0, dropped: 0 },
				memory_tail: { size: 1, capacity: 1000 },
				sources: [],
			}),
		);
		return;
	}
	res.statusCode = 404;
	res.end(JSON.stringify({ error: "not found" }));
});

function listen(server, port) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function waitFor(check, message) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(message);
}

function waitForExit(child) {
	return new Promise((resolve) => child.once("exit", resolve));
}

async function waitForUi() {
	for (let attempt = 0; attempt < 80; attempt++) {
		try {
			const response = await fetch(`${UI_ORIGIN}/api/health`);
			if (response.ok) return;
		} catch {
			// Server has not bound yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("pi-web-ui did not become ready");
}

function authenticatedUiUrl(path) {
	const url = new URL(path, UI_ORIGIN);
	url.searchParams.set("token", UI_TOKEN);
	return url;
}

function assertNoBrowserHeaders(headers) {
	for (const name of [
		"authorization",
		"cookie",
		"origin",
		"x-forwarded-for",
		"x-forwarded-host",
		"x-pi-token",
		"x-observe-target",
	]) {
		assert.equal(headers[name], undefined, `${name} leaked upstream`);
	}
}

function resolveWithTs(expression) {
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			`import { resolveObserveUpstream } from "./server/observe-proxy.ts"; ${expression}`,
		],
		{ cwd: process.cwd(), encoding: "utf8" },
	);
	return result;
}

function probeAbortableDrain() {
	return spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			'import { EventEmitter } from "node:events"; ' +
				'import { waitForObserveDrain } from "./server/observe-proxy.ts"; ' +
				"const emitter = new EventEmitter(); " +
				"const controller = new AbortController(); " +
				"const pending = waitForObserveDrain(emitter, controller.signal); " +
				"controller.abort(); " +
				"try { await pending; process.exitCode = 2; } " +
				'catch (error) { console.log(`${error.name}:${emitter.listenerCount("drain")}`); }',
		],
		{ cwd: process.cwd(), encoding: "utf8" },
	);
}

async function abortHeldStream() {
	holdNextStream = true;
	const closed = new Promise((resolve) => {
		heldStreamClosedResolve = resolve;
	});
	await new Promise((resolve, reject) => {
		const req = httpRequest(authenticatedUiUrl("/api/observe/stream"), (res) => {
			res.once("data", () => {
				res.destroy();
				resolve();
			});
		});
		req.once("error", reject);
		req.end();
	});
	await Promise.race([
		closed,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("upstream SSE was not aborted")), 2_000),
		),
	]);
	heldStreamClosedResolve = undefined;
}

let child;
try {
	const defaultResolution = resolveWithTs(
		'console.log(resolveObserveUpstream(undefined).href)',
	);
	assert.equal(defaultResolution.status, 0, defaultResolution.stderr);
	assert.equal(defaultResolution.stdout.trim(), "http://127.0.0.1:8765/");
	for (const invalid of [
		"https://127.0.0.1:8765",
		"http://192.0.2.10:8765",
		"http://user:pass@127.0.0.1:8765",
		"http://127.0.0.1:8765/prefix",
	]) {
		const result = resolveWithTs(
			`try { resolveObserveUpstream(${JSON.stringify(invalid)}); process.exitCode = 2; } catch { console.log("rejected"); }`,
		);
		assert.equal(result.status, 0, `${invalid}: ${result.stderr}`);
		assert.equal(result.stdout.trim(), "rejected");
	}
	const drainAbort = probeAbortableDrain();
	assert.equal(drainAbort.status, 0, drainAbort.stderr);
	assert.equal(drainAbort.stdout.trim(), "AbortError:0");

	await listen(upstream, UPSTREAM_PORT);
	child = spawn(
		process.execPath,
		["--import", "tsx", "server/index.ts"],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				PI_WEB_PORT: String(UI_PORT),
				PI_WEB_DATA_DIR: tempDir,
				PI_WEB_CWD: process.cwd(),
				PI_CODING_AGENT_DIR: join(tempDir, "agent"),
				PI_WEB_TOKEN: UI_TOKEN,
				UA_TELEMETRY_HTTP: UPSTREAM_ORIGIN,
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	await waitForUi();

	const eventQuery =
		"after=7&limit=100&source=pi&kind=tool.execution&severity=warning&trace_id=trace_1";
	const eventsResponse = await fetch(authenticatedUiUrl(`/api/observe/events?${eventQuery}`), {
		headers: {
			Authorization: "Bearer browser-secret",
			Cookie: "pi_web_token=browser-secret",
			Origin: "https://attacker.invalid",
			"X-Forwarded-For": "203.0.113.1",
			"X-Forwarded-Host": "attacker.invalid",
			"X-PI-Token": "browser-secret",
			"X-Observe-Target": "http://attacker.invalid",
		},
	});
	assert.equal(eventsResponse.status, 200);
	assert.deepEqual(await eventsResponse.json(), {
		events: [telemetryEvent],
		gap: null,
		next_cursor: 8,
	});
	assert.equal(eventsResponse.headers.get("x-upstream-secret"), null);
	const eventRequest = seen.at(-1);
	assert.equal(eventRequest.method, "GET");
	assert.equal(eventRequest.url, `/telemetry/events?${eventQuery}`);
	assertNoBrowserHeaders(eventRequest.headers);

	for (const [path, expected] of [
		["/api/observe/health", "healthy"],
		["/api/observe/sources", "sources"],
		["/api/observe/events/tel_8", "event"],
	]) {
		const response = await fetch(authenticatedUiUrl(path));
		assert.equal(response.status, 200, path);
		const body = await response.json();
		assert.ok(expected in body || body.status === expected, path);
	}

	for (const path of [
		"/api/observe/events?target=http://attacker.invalid",
		"/api/observe/events?after=1&after=2",
		"/api/observe/events?after=-1",
		"/api/observe/events?after=1.5",
		"/api/observe/events?limit=0",
		"/api/observe/events?limit=1001",
		"/api/observe/events?severity=fatal",
		`/api/observe/events?source=${"x".repeat(257)}`,
		"/api/observe/health?after=1",
		`/api/observe/events/${"x".repeat(257)}`,
	]) {
		const before = seen.length;
		const response = await fetch(authenticatedUiUrl(path));
		assert.equal(response.status, 400, path);
		assert.equal(seen.length, before, `${path} reached upstream`);
	}

	const oversized = await fetch(authenticatedUiUrl("/api/observe/events?kind=oversize"));
	assert.equal(oversized.status, 413);

	holdHealth = true;
	const occupied = Array.from({ length: 16 }, () =>
		fetch(authenticatedUiUrl("/api/observe/health")),
	);
	await waitFor(
		() => heldHealthResponses.length === 16,
		"proxy did not establish bounded upstream requests",
	);
	const beforeOverflow = seen.length;
	const overflow = await Promise.race([
		fetch(authenticatedUiUrl("/api/observe/health")),
		new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), 1_000)),
	]);
	assert.equal(overflow.status, 503);
	assert.equal(seen.length, beforeOverflow, "overflow request reached upstream");
	holdHealth = false;
	for (const response of heldHealthResponses.splice(0)) {
		response.end(
			JSON.stringify({
				status: "healthy",
				counters: {},
				memory_tail: { size: 0, capacity: 1000 },
				sources: [],
			}),
		);
	}
	await Promise.all(occupied);

	for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
		const before = seen.length;
		const response = await fetch(authenticatedUiUrl("/api/observe/events"), { method });
		assert.equal(response.status, 405, method);
		assert.equal(response.headers.get("allow"), "GET", method);
		assert.equal(seen.length, before, `${method} reached upstream`);
	}

	const streamResponse = await fetch(authenticatedUiUrl("/api/observe/stream?source=pi"), {
		headers: {
			"Last-Event-ID": "7",
			Authorization: "Bearer browser-secret",
			Cookie: "pi_web_token=browser-secret",
			Origin: "https://attacker.invalid",
			"X-Forwarded-For": "203.0.113.1",
		},
	});
	assert.equal(streamResponse.status, 200);
	assert.match(streamResponse.headers.get("content-type") ?? "", /^text\/event-stream/);
	assert.equal(streamResponse.headers.get("x-upstream-secret"), null);
	assert.match(await streamResponse.text(), /event: telemetry/);
	const streamRequest = seen.at(-1);
	assert.equal(streamRequest.url, "/telemetry/stream?source=pi");
	assert.equal(streamRequest.headers["last-event-id"], "7");
	assertNoBrowserHeaders(streamRequest.headers);

	for (const header of ["-1", "1.5", "x".repeat(65)]) {
		const before = seen.length;
		const response = await fetch(authenticatedUiUrl("/api/observe/stream"), {
			headers: { "Last-Event-ID": header },
		});
		assert.equal(response.status, 400, header);
		assert.equal(seen.length, before, `${header} reached upstream`);
	}
	const conflictingCursorCount = seen.length;
	const conflictingCursor = await fetch(authenticatedUiUrl("/api/observe/stream?after=1"), {
		headers: { "Last-Event-ID": "1" },
	});
	assert.equal(conflictingCursor.status, 400);
	assert.equal(seen.length, conflictingCursorCount);

	await abortHeldStream();

	child.kill("SIGTERM");
	await Promise.race([
		waitForExit(child),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`pi-web-ui did not exit: ${stderr}`)), 5_000),
		),
	]);
	child = undefined;
	console.log("observe proxy: passed");
} finally {
	if (child && child.exitCode === null) {
		child.kill("SIGTERM");
		await Promise.race([
			waitForExit(child),
			new Promise((resolve) => setTimeout(resolve, 1_000)),
		]);
	}
	await new Promise((resolve) => upstream.close(() => resolve()));
	rmSync(tempDir, { recursive: true, force: true });
}
