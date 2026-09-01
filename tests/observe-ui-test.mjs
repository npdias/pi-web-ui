/**
 * Observe workspace browser acceptance.
 *
 * Runs Pi UI against one local, content-free fake telemetry core. No provider
 * request or repair action is made. Ports and data roots are isolated per run.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const runRoot = mkdtempSync(join(tmpdir(), "pi-observe-ui-"));
const dataDir = join(runRoot, "data");
const workspaceDir = join(runRoot, "workspace");
const agentDir = join(runRoot, "agent");
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
const screenshotDir = process.env.OBSERVE_UI_SCREENSHOT_DIR;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
const streams = new Set();
const seen = [];
const pageLimits = [];
const detailRequests = [];
const heldDetailResponses = new Set();
let streamRequests = 0;
let activeStreams = 0;
let maxActiveStreams = 0;
let uiProcess;
let browser;
let failures = 0;
let sequence = 0;
let holdHealth = true;
let failNextSources = false;
let staleDetailAborted = false;
const heldHealthResponses = [];
const fixtureEpoch = Date.now() - 60_000;

function check(name, condition, detail = "") {
	console.log(`${condition ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failures++;
}

function source(component, overrides = {}) {
	return {
		robot_id: "robot-observe-test",
		host_id: "host-observe-test",
		component,
		instance_id: `${component}-1`,
		version: "test",
		...overrides,
	};
}

const piSource = source("pi");
const hostSource = source("host-sampler");

function event(kind, overrides = {}) {
	sequence++;
	return {
		schema_version: 1,
		event_id: `tel_observe_${sequence}`,
		sequence,
		observed_at: new Date(fixtureEpoch + sequence * 10).toISOString(),
		monotonic_ns: sequence * 1_000_000,
		kind,
		severity: "info",
		source: piSource,
		attributes: {},
		privacy_class: "operator",
		redaction: { applied: true, fields: [] },
		...overrides,
	};
}

const events = [
	event("agent.run", {
		phase: "start",
		state: "running",
		summary: "Retained run started",
		correlation: { trace_id: "trace-observe", session_id: "session-observe" },
	}),
	event("agent.turn", {
		phase: "start",
		state: "running",
		summary: "Retained Turn started",
		correlation: {
			trace_id: "trace-observe",
			turn_id: "turn-observe",
			step_id: "step-observe",
			request_id: "request-observe",
		},
	}),
	event("tool.execution", {
		phase: "start",
		state: "running",
		summary: "Retained fixture tool started",
		correlation: {
			trace_id: "trace-observe",
			turn_id: "turn-observe",
			step_id: "step-observe",
			request_id: "request-observe",
			tool_call_id: "tool-observe",
		},
		attributes: {
			tool_name: "fixture_tool",
			lifecycle_attempt_id: "tool-attempt-observe",
			input: { command: "bounded tool arguments preview" },
		},
	}),
	event("tool.execution", {
		phase: "end",
		state: "completed",
		severity: "info",
		summary: "Retained fixture tool finished",
		duration_ms: 50,
		correlation: {
			trace_id: "trace-observe",
			turn_id: "turn-observe",
			step_id: "step-observe",
			request_id: "request-observe",
			tool_call_id: "tool-observe",
		},
		attributes: {
			tool_name: "fixture_tool",
			lifecycle_attempt_id: "tool-attempt-observe",
			is_error: false,
			matched_start: true,
			output: { content: "bounded tool result preview" },
		},
		payload_ref: "payloads/sha256/inert-observe-reference",
	}),
	event("host.sample", {
		state: "observed",
		summary: "Host sampler heartbeat",
		source: hostSource,
		attributes: { load_state: "sampled" },
	}),
];

const exactArguments = `exact-args-${"x".repeat(70 * 1024)}-exact-arguments-tail`;
const exactResult = `exact-result-${"y".repeat(70 * 1024)}-exact-result-tail`;
const deepDetailPlaceholder = "__PI_OBSERVE_DEEP_DETAIL_PLACEHOLDER__";
const deepDetailJson = `${"[".repeat(20_000)}"deep-browser-leaf"${"]".repeat(20_000)}`;
const exactEvents = new Map(events.map((item) => [item.event_id, item]));
exactEvents.set(events[2].event_id, {
	...events[2],
	attributes: {
		...events[2].attributes,
		input: {
			command: exactArguments,
			"headers.authorization": "Bearer selected-detail-secret",
			deep: deepDetailPlaceholder,
		},
	},
	redaction: {
		applied: true,
		fields: ["attributes.input.headers.authorization"],
	},
});
exactEvents.set(events[3].event_id, {
	...events[3],
	attributes: {
		...events[3].attributes,
		output: {
			content: exactResult,
			token: "selected-result-secret",
		},
	},
});

let health = {
	status: "healthy",
	counters: {
		accepted: events.length,
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
	memory_tail: { size: events.length, capacity: 10_000 },
	sources: [
		{
			source: piSource,
			last_event_at: events[3].observed_at,
			last_event_age_seconds: 0.5,
			status: "healthy",
		},
		{
			source: hostSource,
			last_event_at: events[4].observed_at,
			last_event_age_seconds: 1,
			status: "healthy",
		},
	],
};

function pageFor(url) {
	const limit = Number(url.searchParams.get("limit") ?? 1_000);
	const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
	const after = Number(url.searchParams.get("after") ?? url.searchParams.get("cursor") ?? 0);
	const selected = url.searchParams.has("before")
		? events.filter((item) => item.sequence < before).slice(-limit)
		: events.filter((item) => item.sequence > after).slice(0, limit);
	return {
		events: selected,
		gap: null,
		next_cursor: selected.at(-1)?.sequence ?? (url.searchParams.has("before") ? events.at(-1)?.sequence ?? 0 : null),
	};
}

function writeSse(res, name, data, id) {
	if (id !== undefined) res.write(`id: ${id}\n`);
	res.write(`event: ${name}\n`);
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function publishTelemetry(item) {
	events.push(item);
	health = {
		...health,
		counters: { ...health.counters, accepted: events.length },
		memory_tail: { ...health.memory_tail, size: events.length },
	};
	for (const res of streams) writeSse(res, "telemetry", item, item.sequence);
}

function publishGap(gap) {
	for (const res of [...streams]) {
		writeSse(res, "gap", gap);
		res.end();
	}
}

const telemetryServer = createServer((req, res) => {
	const origin = `http://127.0.0.1:${telemetryServer.address()?.port ?? 0}`;
	const url = new URL(req.url ?? "/", origin);
	seen.push({ path: url.pathname, headers: { ...req.headers } });
	if (url.pathname === "/telemetry/events") {
		res.setHeader("Content-Type", "application/json");
		const limit = Number(url.searchParams.get("limit") ?? 100);
		pageLimits.push(limit);
		if (limit > 1) {
			res.statusCode = 413;
			res.end(JSON.stringify({ error: "fixture page too large" }));
			return;
		}
		res.end(JSON.stringify(pageFor(url)));
		return;
	}
	if (url.pathname.startsWith("/telemetry/events/")) {
		const eventId = decodeURIComponent(url.pathname.slice("/telemetry/events/".length));
		detailRequests.push(eventId);
		res.setHeader("Content-Type", "application/json");
		if (eventId === events[0].event_id) {
			heldDetailResponses.add(res);
			res.on("close", () => {
				heldDetailResponses.delete(res);
				staleDetailAborted = true;
			});
			return;
		}
		const selected = exactEvents.get(eventId);
		if (selected === undefined) {
			res.statusCode = 404;
			res.end(JSON.stringify({ error: "event not found" }));
			return;
		}
		let body = JSON.stringify({ event: selected });
		if (eventId === events[2].event_id) {
			body = body.replace(JSON.stringify(deepDetailPlaceholder), deepDetailJson);
		}
		res.end(body);
		return;
	}
	if (url.pathname === "/telemetry/health") {
		res.setHeader("Content-Type", "application/json");
		if (holdHealth) {
			heldHealthResponses.push(res);
			return;
		}
		res.end(JSON.stringify(health));
		return;
	}
	if (url.pathname === "/telemetry/sources") {
		res.setHeader("Content-Type", "application/json");
		if (failNextSources) {
			failNextSources = false;
			res.end(JSON.stringify({ sources: "fixture source health unavailable" }));
			return;
		}
		res.end(JSON.stringify({ sources: health.sources }));
		return;
	}
	if (url.pathname === "/telemetry/stream") {
		streamRequests++;
		activeStreams++;
		maxActiveStreams = Math.max(maxActiveStreams, activeStreams);
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		streams.add(res);
		res.write(": observe test stream\n\n");
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			streams.delete(res);
			activeStreams--;
		};
		res.on("close", close);
		return;
	}
	res.statusCode = 404;
	res.end(JSON.stringify({ error: "not found" }));
});

function listenEphemeral(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve(server.address().port);
		});
	});
}

async function reservePort() {
	const reservation = createServer();
	const port = await listenEphemeral(reservation);
	await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
	return port;
}

async function waitFor(checkFn, description, timeoutMs = 12_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (await checkFn()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timeout waiting for ${description}`);
}

async function dismissSetup(page) {
	const close = page.locator(".setup-modal .modal-close");
	try {
		await close.waitFor({ state: "visible", timeout: 15_000 });
		await close.click();
	} catch {
		// Configured fixture: setup modal never opens.
	}
}

async function stopUi() {
	if (!uiProcess || uiProcess.exitCode !== null) return;
	if (process.platform !== "win32") {
		try {
			process.kill(-uiProcess.pid, "SIGTERM");
		} catch {
			// Process already exited.
		}
	} else {
		uiProcess.kill("SIGTERM");
	}
	await Promise.race([
		new Promise((resolve) => uiProcess.once("exit", resolve)),
		new Promise((resolve) => setTimeout(resolve, 2_000)),
	]);
	if (uiProcess.exitCode === null) uiProcess.kill("SIGKILL");
}

try {
	assert.ok(CHROME_PATH, "Chrome executable not found; set PI_WEB_CHROME");
	const build = spawnSync(
		process.platform === "win32" ? "npm.cmd" : "npm",
		["run", "build:web"],
		{ cwd: REPO_ROOT, encoding: "utf8", env: process.env },
	);
	assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

	const upstreamPort = await listenEphemeral(telemetryServer);
	const uiPort = await reservePort();
	uiProcess = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
		cwd: REPO_ROOT,
		detached: process.platform !== "win32",
		env: {
			...process.env,
			PI_WEB_PORT: String(uiPort),
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: workspaceDir,
			PI_CODING_AGENT_DIR: agentDir,
			UA_TELEMETRY_HTTP: `http://127.0.0.1:${upstreamPort}`,
			PI_WEB_ENABLE_LEGACY_GOAL_REVIEW: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let serverLogs = "";
	uiProcess.stdout.on("data", (chunk) => { serverLogs += chunk.toString(); });
	uiProcess.stderr.on("data", (chunk) => { serverLogs += chunk.toString(); });
	const uiOrigin = `http://127.0.0.1:${uiPort}`;
	await waitFor(async () => {
		try {
			return (await fetch(`${uiOrigin}/api/health`)).ok;
		} catch {
			return false;
		}
	}, "Pi UI server", 20_000).catch((error) => {
		throw new Error(`${error.message}\n${serverLogs.slice(-4_000)}`);
	});

	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
	const pageErrors = [];
	const consoleErrors = [];
	const externalRequests = [];
	const pageRequestPaths = [];
	const adaptive413Responses = [];
	const unexpected413Responses = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("request", (request) => {
		const requestUrl = new URL(request.url());
		pageRequestPaths.push(requestUrl.pathname);
		if (requestUrl.origin !== uiOrigin) externalRequests.push(request.url());
	});
	page.on("response", (response) => {
		if (response.status() !== 413) return;
		const responseUrl = new URL(response.url());
		if (responseUrl.origin === uiOrigin && responseUrl.pathname === "/api/observe/events") {
			adaptive413Responses.push(response.url());
		} else {
			unexpected413Responses.push(response.url());
		}
	});
	await page.goto(uiOrigin, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".topbar", { timeout: 20_000 });
	await page.waitForSelector(".conn-dot.ok", { timeout: 20_000 });
	await dismissSetup(page);

	const observeTab = page.getByRole("tab", { name: /Observe/ });
	check("Observe is a manual top-level tab", await observeTab.count() === 1);
	check("Chat remains initial view", await page.getByRole("tab", { name: "Chat", exact: true }).getAttribute("aria-selected") === "true");
	check("Observe does not auto-open for retained facts", await observeTab.getAttribute("aria-selected") === "false");

	await observeTab.click();
	await page.waitForSelector(".observe-view[data-active='true']");
	await waitFor(() => activeStreams === 1, "initial Observe stream");
	await page.waitForTimeout(100);
	check("connected SSE stays Loading until core health arrives", await page.locator(".observe-tab__badge").getAttribute("data-tone") === "loading");
	holdHealth = false;
	for (const response of heldHealthResponses.splice(0)) response.end(JSON.stringify(health));
	await page.waitForSelector(".observe-trajectory-ledger__row", { timeout: 15_000 });
	check("Trajectory is default Observe subview", await page.getByRole("tab", { name: "Trajectory", exact: true }).getAttribute("aria-selected") === "true");
	const subviewTabs = ["Trajectory", "Services", "Host", "Logs", "Changes"];
	check("each Observe subtab controls a present labelled panel", await page.evaluate((labels) => labels.every((label) => {
		const tab = [...document.querySelectorAll(".observe-subnav [role='tab']")]
			.find((candidate) => candidate.textContent?.trim() === label);
		if (!(tab instanceof HTMLElement) || tab.id === "") return false;
		const panelId = tab.getAttribute("aria-controls");
		const panel = panelId === null ? null : document.getElementById(panelId);
		return panel?.getAttribute("aria-labelledby") === tab.id;
	}), subviewTabs));
	const trajectorySubtab = page.getByRole("tab", { name: "Trajectory", exact: true });
	await trajectorySubtab.focus();
	await page.keyboard.press("ArrowRight");
	const servicesSubtab = page.getByRole("tab", { name: "Services", exact: true });
	await waitFor(() => servicesSubtab.evaluate((node) => node === document.activeElement && node.getAttribute("aria-selected") === "true"), "ArrowRight Observe subtab focus");
	check("ArrowRight moves and activates next Observe subtab", await servicesSubtab.evaluate((node) => node === document.activeElement && node.getAttribute("aria-selected") === "true"));
	await page.keyboard.press("End");
	const changesSubtab = page.getByRole("tab", { name: "Changes", exact: true });
	await waitFor(() => changesSubtab.evaluate((node) => node === document.activeElement && node.getAttribute("aria-selected") === "true"), "End Observe subtab focus");
	check("End moves and activates last Observe subtab", await changesSubtab.evaluate((node) => node === document.activeElement && node.getAttribute("aria-selected") === "true"));
	await page.keyboard.press("Home");
	await waitFor(() => trajectorySubtab.evaluate((node) => node === document.activeElement && node.getAttribute("aria-selected") === "true"), "Home Observe subtab focus");
	check("Home returns to first Observe subtab", await trajectorySubtab.evaluate((node) => node === document.activeElement && node.getAttribute("aria-selected") === "true"));
	await page.keyboard.press("ArrowLeft");
	await waitFor(() => changesSubtab.evaluate((node) => node === document.activeElement && node.getAttribute("aria-selected") === "true"), "ArrowLeft Observe subtab focus");
	check("ArrowLeft wraps to last Observe subtab", await changesSubtab.evaluate((node) => node === document.activeElement && node.getAttribute("aria-selected") === "true"));
	await page.keyboard.press("Home");
	await waitFor(() => trajectorySubtab.evaluate((node) => node === document.activeElement && node.getAttribute("aria-selected") === "true"), "restored Trajectory subtab focus");
	check("wall clock is default time mode", await page.getByLabel("Time mode").inputValue() === "wall");
	check("retained replay is visible", await page.getByText("Retained fixture tool finished", { exact: true }).count() === 1);
	await page.waitForSelector(".observe-tab__badge[data-tone='healthy']");
	check("health badge uses core healthy fact", (await page.locator(".observe-tab__badge").textContent())?.includes("Healthy"));
	const openRunRow = page.locator(".observe-trajectory-ledger__row", { hasText: "Retained run started" });
	check("ledger shows live elapsed for open record", (await openRunRow.textContent())?.includes("Open · elapsed"));
	await openRunRow.click();
	check("inspector shares live elapsed evidence", (await page.getByLabel("Trajectory record details").textContent())?.includes("Live elapsed"));
	await waitFor(() => detailRequests.includes(events[0].event_id), "stale selected detail request");

	const retainedRow = page.locator(".observe-trajectory-ledger__row", { hasText: "Retained fixture tool finished" });
	await retainedRow.click();
	await page.waitForSelector(".observe-trajectory-inspector[data-open='true']");
	check("selection opens inspector", (await page.getByLabel("Trajectory record details").textContent())?.includes("Retained fixture tool finished"));
	await page.getByText("Exact event detail loaded.", { exact: true }).waitFor();
	const retainedInspectorText = await page.getByLabel("Trajectory record details").textContent();
	check("paired selection fetches exact start and end envelopes", detailRequests.includes(events[2].event_id) && detailRequests.includes(events[3].event_id), detailRequests.join(", "));
	check("selected inspector renders full arguments beyond ledger truncation", retainedInspectorText?.includes("exact-arguments-tail"));
	check("selected inspector renders full result beyond ledger truncation", retainedInspectorText?.includes("exact-result-tail"));
	check("selected inspector bounds 20k nested exact detail honestly", retainedInspectorText?.includes("[TRUNCATED: depth]"));
	check("selected detail browser sanitizer redacts known secret keys", retainedInspectorText?.includes("[REDACTED]") && !retainedInspectorText.includes("selected-detail-secret") && !retainedInspectorText.includes("selected-result-secret"));
	check("selected detail preserves upstream redaction fields", retainedInspectorText?.includes("attributes.input.headers.authorization"));
	await waitFor(() => staleDetailAborted, "stale selected detail abort");
	check("selection change aborts stale exact detail request", staleDetailAborted);
	const inspectorAfterStaleAbort = await page.getByLabel("Trajectory record details").textContent();
	check("stale selected detail cannot overwrite current inspector", inspectorAfterStaleAbort?.includes("Retained fixture tool finished") && !inspectorAfterStaleAbort.includes("Retained run started"));
	check("inspection pauses live follow", await page.getByRole("button", { name: "Jump to live" }).isEnabled());
	if (screenshotDir) {
		await page.screenshot({ path: join(screenshotDir, "observe-desktop.png"), fullPage: true });
	}

	const liveEvent = event("provider.thinking", {
		state: "streaming",
		summary: "Live retained-safe progress",
		correlation: {
			trace_id: "trace-observe",
			turn_id: "turn-observe",
			step_id: "step-observe",
			request_id: "request-observe",
		},
		attributes: { content_index: 1 },
	});
	publishTelemetry(liveEvent);
	await page.getByText("Live retained-safe progress", { exact: true }).waitFor();
	check("live SSE appends a record", await page.getByText("Live retained-safe progress", { exact: true }).count() === 1);
	check("new live record does not steal selection", (await page.getByLabel("Trajectory record details").textContent())?.includes("Retained fixture tool finished"));
	await page.getByRole("button", { name: "Jump to live" }).click();
	check("Jump to live resumes following", await page.getByRole("button", { name: "Following live" }).isDisabled());

	await page.getByLabel("Search trajectory").fill("fixture_tool");
	check("search keeps matching tool row", await retainedRow.isVisible());
	check("search hides nonmatching live row", !(await page.getByText("Live retained-safe progress", { exact: true }).isVisible()));
	await page.getByLabel("Search trajectory").fill("");

	const errorEvent = event("tool.execution", {
		phase: "end",
		state: "error",
		severity: "error",
		summary: "Injected tool error fact",
		correlation: {
			trace_id: "trace-observe",
			turn_id: "turn-observe",
			step_id: "step-observe",
			request_id: "request-observe",
			tool_call_id: "tool-error-observe",
		},
		attributes: { tool_name: "fixture_tool", is_error: true },
	});
	publishTelemetry(errorEvent);
	await page.getByText("Injected tool error fact", { exact: true }).waitFor();
	await page.waitForSelector(".observe-tab__badge[data-tone='degraded']");
	check("error fact produces explicit degraded health", (await page.locator(".observe-health-banner").textContent())?.includes("Degraded"));
	await page.getByRole("tab", { name: "Chat", exact: true }).click();
	await page.waitForTimeout(250);
	check("error fact never forces Observe navigation", await page.getByRole("tab", { name: "Chat", exact: true }).getAttribute("aria-selected") === "true");
	await waitFor(() => activeStreams === 0, "Observe stream abort on leave");
	check("leaving Observe aborts stream", activeStreams === 0);
	check("leaving Observe reports disconnected state", await page.locator(".observe-tab__badge").getAttribute("data-tone") === "disconnected");
	check("inactive Observe does not capture slash", await page.evaluate(() =>
		document.body.dispatchEvent(new KeyboardEvent("keydown", {
			key: "/",
			bubbles: true,
			cancelable: true,
		})),
	));

	const stallEvent = event("agent.stall", {
		state: "possibly_stalled",
		severity: "warning",
		summary: "Injected 180 second stall fact",
		correlation: { trace_id: "trace-observe", turn_id: "turn-observe" },
		attributes: { silence_ms: 180_000, threshold_ms: 180_000 },
	});
	publishTelemetry(stallEvent);
	health = {
		...health,
		status: "degraded",
		counters: {
			...health.counters,
			dropped: 1,
			persistence_gap: 2,
		},
	};
	failNextSources = true;
	holdHealth = true;
	await page.waitForTimeout(150);
	check("stall fact while disconnected never forces navigation", await page.getByRole("tab", { name: "Chat", exact: true }).getAttribute("aria-selected") === "true");

	await observeTab.click();
	await waitFor(() => heldHealthResponses.length > 0, "delayed re-entry health request");
	await page.getByRole("tab", { name: "Services", exact: true }).click();
	check("re-entry clears last-known source cards while fresh facts load", await page.getByText("Loading source health", { exact: true }).count() === 1 && await page.locator(".observe-source-card").count() === 0);
	await page.getByRole("tab", { name: "Trajectory", exact: true }).click();
	holdHealth = false;
	for (const response of heldHealthResponses.splice(0)) response.end(JSON.stringify(health));
	await page.getByText("Injected 180 second stall fact", { exact: true }).waitFor({ timeout: 15_000 });
	await waitFor(async () => {
		const detail = await page.locator(".observe-health-banner").textContent();
		return detail?.includes("1 dropped") && detail.includes("2 persistence gaps");
	}, "named core counter health facts");
	check("partial source failure retains named core health facts", (await page.locator(".observe-health-banner").textContent())?.includes("1 dropped event") && (await page.locator(".observe-health-banner").textContent())?.includes("2 persistence gaps"));
	await waitFor(() => activeStreams === 1, "single reconnected Observe stream");
	check("re-entry has one active stream", activeStreams === 1, `active=${activeStreams}`);
	check("store never creates duplicate active listeners", maxActiveStreams === 1, `max=${maxActiveStreams}`);
	check("reconnect used last event cursor", seen.some((item) => item.path === "/telemetry/stream" && item.headers["last-event-id"] !== undefined));

	const gap = { requested: stallEvent.sequence, earliest_available: stallEvent.sequence + 3, resume_after: stallEvent.sequence + 2 };
	const resumedEvent = event("context.changed", {
		state: "observed",
		summary: "Replayed after explicit gap",
		correlation: {
			trace_id: "trace-observe",
			turn_id: "turn-observe",
			step_id: "step-observe",
		},
		attributes: { context_hash: "fixture-context-hash" },
	});
	// Preserve exact expired interval: sequence immediately after live event is
	// intentionally unavailable; replay resumes at earliest retained evidence.
	Object.defineProperty(resumedEvent, "sequence", { value: gap.earliest_available, enumerable: true });
	Object.defineProperty(resumedEvent, "event_id", { value: `tel_observe_${gap.earliest_available}`, enumerable: true });
	sequence = gap.earliest_available;
	events.push(resumedEvent);
	publishGap(gap);
	await page.waitForSelector(".observe-tab__badge[data-tone='gap']", { timeout: 15_000 });
	check("gap state is explicit", (await page.locator(".observe-health-banner").textContent())?.includes("gap"));
	check("gap state retains named core counter facts", (await page.locator(".observe-health-banner").textContent())?.includes("1 dropped event") && (await page.locator(".observe-health-banner").textContent())?.includes("2 persistence gaps"));
	check("gap appears in ledger", await page.locator(".observe-trajectory-ledger__row[data-kind='GAP']").count() === 1);
	await page.getByText("Replayed after explicit gap", { exact: true }).waitFor({ timeout: 15_000 });
	check("stream reconnect replays earliest retained event", true);

	await page.getByRole("tab", { name: "Services", exact: true }).click();
	check("Services shows current source facts", await page.getByText("pi", { exact: true }).count() >= 1);
	await page.getByRole("tab", { name: "Host", exact: true }).click();
	check("Host shows current host source only", await page.getByText("host-sampler", { exact: true }).count() >= 1);
	await page.getByRole("tab", { name: "Logs", exact: true }).click();
	check("Logs has honest adapter empty state", (await page.locator(".observe-empty-state").textContent())?.includes("No structured log adapter"));
	check("Logs offers no repair control", await page.locator(".observe-empty-state button").count() === 0);
	await page.getByRole("tab", { name: "Changes", exact: true }).click();
	check("Changes has honest adapter empty state", (await page.locator(".observe-empty-state").textContent())?.includes("No change telemetry adapter"));
	await page.getByRole("tab", { name: "Trajectory", exact: true }).click();

	const ledger = page.getByRole("grid", { name: "Trajectory ledger" });
	await ledger.focus();
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	check("Arrow and Enter select stable ledger row", await page.locator(".observe-trajectory-ledger__row[aria-selected='true']").count() === 1);
	await page.keyboard.press("Escape");
	check("Escape closes inspection", await page.locator(".observe-trajectory-inspector[data-open='true']").count() === 0);
	await page.keyboard.press("/");
	check("slash focuses trajectory search", await page.getByLabel("Search trajectory").evaluate((node) => node === document.activeElement));
	await page.emulateMedia({ reducedMotion: "reduce" });
	check("reduced motion removes timeline transition", await page.locator(".observe-trajectory-timeline__domain").evaluate((node) => getComputedStyle(node).transitionDuration === "0s"));
	check("Observe exposes no repair or write control", await page.getByRole("button", { name: /repair|restart|abort|delete|write/i }).count() === 0);

	await page.setViewportSize({ width: 600, height: 760 });
	await ledger.focus();
	await page.keyboard.press("Enter");
	const drawer = page.getByRole("dialog", { name: "Trajectory record details" });
	await drawer.waitFor();
	const drawerBox = await drawer.boundingBox();
	check("narrow inspector is full-screen drawer", drawerBox !== null && drawerBox.x === 0 && drawerBox.y === 0 && Math.round(drawerBox.width) === 600 && Math.round(drawerBox.height) === 760, JSON.stringify(drawerBox));
	if (screenshotDir) {
		await page.screenshot({ path: join(screenshotDir, "observe-mobile.png"), fullPage: true });
	}
	await page.keyboard.press("Escape");
	check("mobile Escape closes drawer", await drawer.count() === 0);

	await page.getByRole("tab", { name: "Chat", exact: true }).click();
	events.splice(0, events.length);
	health = {
		...health,
		status: "idle",
		counters: { ...health.counters, accepted: 0 },
		memory_tail: { ...health.memory_tail, size: 0 },
		sources: [],
	};
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForSelector(".topbar");
	await dismissSetup(page);
	await page.getByRole("tab", { name: /Observe/ }).click();
	await page.waitForSelector(".observe-empty-state");
	const emptyText = await page.locator(".observe-empty-state").textContent();
	check("empty Trajectory points to local telemetry availability", emptyText?.includes("local UnifiedAgent telemetry") && emptyText.includes("UA_TELEMETRY_HTTP"));
	check("empty Trajectory offers no repair button", await page.locator(".observe-empty-state button").count() === 0);

	check("payload references remain inert across every browser request", !pageRequestPaths.some((path) => path.includes("/payload")), pageRequestPaths.filter((path) => path.includes("/payload")).join(", "));
	check("adaptive replay retries 413 pages then reuses limit 1", pageLimits[0] === 100 && pageLimits[1] === 15 && pageLimits.slice(2).includes(1), pageLimits.join(", "));
	check("all browser 413 responses belong to adaptive event pages", adaptive413Responses.length >= 2 && unexpected413Responses.length === 0, unexpected413Responses.join(", "));
	check("browser made no external/provider request", externalRequests.length === 0, externalRequests.join(", "));
	check("browser raised no page errors", pageErrors.length === 0, pageErrors.join(" | "));
	const unexpectedConsoleErrors = consoleErrors.filter(
		(message) => message !== "Failed to load resource: the server responded with a status of 413 (Payload Too Large)",
	);
	check("browser console raised no unexpected errors", unexpectedConsoleErrors.length === 0, unexpectedConsoleErrors.join(" | "));
	check("Observe connected at least twice for explicit re-entry", streamRequests >= 2, `requests=${streamRequests}`);
} catch (error) {
	console.error("Observe UI acceptance failed:", error);
	failures++;
} finally {
	if (browser) await browser.close();
	await stopUi();
	for (const res of heldHealthResponses.splice(0)) res.destroy();
	for (const res of [...heldDetailResponses]) res.destroy();
	for (const res of [...streams]) res.destroy();
	await new Promise((resolve) => telemetryServer.close(() => resolve()));
	rmSync(runRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(failures === 0 ? "\nObserve UI checks passed." : `\n${failures} Observe UI check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
