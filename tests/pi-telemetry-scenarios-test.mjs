import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "telemetry");
const FIXTURE_NAMES = [
	"normal",
	"model-stall",
	"long-tool",
	"tool-error",
	"cancelled",
];
const FORBIDDEN_FIXTURE_KEYS = new Set([
	"args",
	"apiKey",
	"authorization",
	"content",
	"cookie",
	"credential",
	"headers",
	"messages",
	"payload",
	"prompt",
	"raw",
	"result",
	"secret",
	"systemPrompt",
	"token",
	"toolResults",
]);
const EXPECTATION_KEYS = new Set([
	"attributes",
	"duration_ms",
	"kind",
	"parent_id",
	"phase",
	"severity",
	"state",
	"tool_call_id",
	"trace_id",
	"turn_id",
	"step_id",
	"request_id",
]);
const EXPECTATION_KINDS = new Set([
	"agent.run",
	"agent.stall",
	"agent.turn",
	"tool.execution",
]);
const EXPECTATION_PHASES = new Set(["start", "end", "observation"]);
const EXPECTATION_SEVERITIES = new Set(["debug", "info", "warning", "error", "critical"]);
const EXPECTATION_STATES = new Set([
	"running",
	"completed",
	"error",
	"cancelled",
	"possibly_stalled",
]);
const EXPECTATION_ATTRIBUTES = new Set([
	"is_error",
	"matched_start",
	"silence_ms",
	"threshold_ms",
	"tool_name",
	"will_retry",
]);
const EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"tool_execution_start",
	"tool_execution_end",
]);
const STOP_REASONS = new Set([
	"stop",
	"aborted",
	"error",
	"length",
	"deferred",
	"toolUse",
	"pending",
]);

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoForbiddenFixtureData(value, location) {
	if (Array.isArray(value)) {
		value.forEach((item, index) =>
			assertNoForbiddenFixtureData(item, `${location}[${index}]`),
		);
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, field] of Object.entries(value)) {
		assert.ok(!FORBIDDEN_FIXTURE_KEYS.has(key), `${location} contains forbidden ${key}`);
		assertNoForbiddenFixtureData(field, `${location}.${key}`);
	}
}

function validateEvent(event, location) {
	assert.ok(isRecord(event), `${location}.event must be an object`);
	assert.ok(EVENT_TYPES.has(event.type), `${location}.event.type is unsupported`);
	const keys = Object.keys(event);
	switch (event.type) {
		case "agent_start":
		case "turn_start":
			assert.deepEqual(keys, ["type"], `${location}.event has unexpected fields`);
			break;
		case "agent_end":
			assert.deepEqual(
				keys.sort(),
				["stopReason", "type", "willRetry"],
				`${location}.event has unexpected fields`,
			);
			assert.ok(STOP_REASONS.has(event.stopReason), `${location}.stopReason is invalid`);
			assert.equal(typeof event.willRetry, "boolean", `${location}.willRetry is invalid`);
			break;
		case "turn_end":
			assert.deepEqual(
				keys.sort(),
				["stopReason", "type"],
				`${location}.event has unexpected fields`,
			);
			assert.ok(STOP_REASONS.has(event.stopReason), `${location}.stopReason is invalid`);
			break;
		case "tool_execution_start":
			assert.deepEqual(
				keys.sort(),
				["toolCallId", "toolName", "type"],
				`${location}.event has unexpected fields`,
			);
			assert.equal(typeof event.toolCallId, "string", `${location}.toolCallId is invalid`);
			assert.equal(typeof event.toolName, "string", `${location}.toolName is invalid`);
			break;
		case "tool_execution_end":
			assert.deepEqual(
				keys.sort(),
				["isError", "toolCallId", "toolName", "type"],
				`${location}.event has unexpected fields`,
			);
			assert.equal(typeof event.toolCallId, "string", `${location}.toolCallId is invalid`);
			assert.equal(typeof event.toolName, "string", `${location}.toolName is invalid`);
			assert.equal(typeof event.isError, "boolean", `${location}.isError is invalid`);
			break;
	}
}

function validateExpectation(expectation, location) {
	assert.ok(isRecord(expectation), `${location} must be an object`);
	for (const key of Object.keys(expectation)) {
		assert.ok(EXPECTATION_KEYS.has(key), `${location} contains unknown ${key}`);
	}
	for (const key of ["kind", "phase", "severity", "state", "parent_id"]) {
		assert.equal(typeof expectation[key], "string", `${location}.${key} is required`);
		assert.ok(expectation[key].length > 0, `${location}.${key} is empty`);
	}
	assert.ok(EXPECTATION_KINDS.has(expectation.kind), `${location}.kind is invalid`);
	assert.ok(EXPECTATION_PHASES.has(expectation.phase), `${location}.phase is invalid`);
	assert.ok(EXPECTATION_SEVERITIES.has(expectation.severity), `${location}.severity is invalid`);
	assert.ok(EXPECTATION_STATES.has(expectation.state), `${location}.state is invalid`);
	for (const key of [
		"parent_id",
		"tool_call_id",
		"trace_id",
		"turn_id",
		"step_id",
		"request_id",
	]) {
		if (!Object.hasOwn(expectation, key)) continue;
		assert.equal(typeof expectation[key], "string", `${location}.${key} is invalid`);
		assert.ok(expectation[key].length > 0, `${location}.${key} is empty`);
	}
	if (Object.hasOwn(expectation, "duration_ms")) {
		assert.equal(typeof expectation.duration_ms, "number", `${location}.duration_ms is invalid`);
		assert.ok(Number.isFinite(expectation.duration_ms), `${location}.duration_ms is invalid`);
		assert.ok(expectation.duration_ms >= 0, `${location}.duration_ms is negative`);
	}
	if (Object.hasOwn(expectation, "attributes")) {
		assert.ok(isRecord(expectation.attributes), `${location}.attributes must be an object`);
		for (const [key, value] of Object.entries(expectation.attributes)) {
			assert.ok(EXPECTATION_ATTRIBUTES.has(key), `${location} contains unknown attribute ${key}`);
			if (key === "tool_name") {
				assert.equal(typeof value, "string", `${location}.attributes.${key} is invalid`);
			} else if (key.endsWith("_ms")) {
				assert.equal(typeof value, "number", `${location}.attributes.${key} is invalid`);
				assert.ok(Number.isFinite(value) && value >= 0, `${location}.attributes.${key} is invalid`);
			} else {
				assert.equal(typeof value, "boolean", `${location}.attributes.${key} is invalid`);
			}
		}
	}
}

function parseFixtureFile(path, fixtureName) {
	const raw = readFileSync(path, "utf8");
	assert.ok(raw.length > 0, `${fixtureName} fixture is empty`);
	const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
	assert.ok(lines.every((line) => line.trim().length > 0), `${fixtureName} has blank lines`);
	const steps = lines.map((line, index) => {
		const location = `${basename(path)}:${index + 1}`;
		let step;
		try {
			step = JSON.parse(line);
		} catch (error) {
			throw new Error(`${location} malformed JSON: ${error.message}`);
		}
		assertNoForbiddenFixtureData(step, location);
		assert.ok(isRecord(step), `${location} must be an object`);
		assert.deepEqual(
			Object.keys(step).sort(),
			["at_ms", "expect", "fixture", step.event ? "event" : "observe"].sort(),
			`${location} has malformed step fields`,
		);
		assert.equal(step.fixture, fixtureName, `${location} fixture name mismatch`);
		assert.equal(typeof step.at_ms, "number", `${location}.at_ms is invalid`);
		assert.ok(Number.isFinite(step.at_ms) && step.at_ms >= 0, `${location}.at_ms is invalid`);
		assert.ok(Number.isSafeInteger(step.at_ms), `${location}.at_ms must be an integer`);
		assert.ok(Array.isArray(step.expect), `${location}.expect must be an array`);
		step.expect.forEach((item, expectationIndex) =>
			validateExpectation(item, `${location}.expect[${expectationIndex}]`),
		);
		if (step.event) validateEvent(step.event, location);
		else {
			assert.deepEqual(step.observe, { stall_threshold_ms: 180_000 }, `${location}.observe is invalid`);
		}
		return step;
	});
	for (let index = 1; index < steps.length; index++) {
		assert.ok(
			steps[index].at_ms >= steps[index - 1].at_ms,
			`${fixtureName} timestamps move backwards`,
		);
	}
	return { name: fixtureName, steps, raw };
}

function loadFixtures(directory, expectedNames = FIXTURE_NAMES) {
	const files = readdirSync(directory)
		.filter((name) => name.endsWith(".jsonl"))
		.sort();
	const expectedFiles = expectedNames.map((name) => `${name}.jsonl`).sort();
	assert.deepEqual(files, expectedFiles, "fixture filenames must map one-to-one to scenario names");
	const fixtures = files.map((file) => {
		const name = file.slice(0, -".jsonl".length);
		return parseFixtureFile(join(directory, file), name);
	});
	assert.equal(new Set(fixtures.map((fixture) => fixture.name)).size, fixtures.length);
	return fixtures;
}

function proveLoaderRejectsMalformedFixtures() {
	const root = mkdtempSync(join(tmpdir(), "pi-telemetry-fixture-loader-"));
	try {
		const malformedJson = join(root, "malformed-json");
		mkdirSync(malformedJson);
		writeFileSync(join(malformedJson, "broken.jsonl"), "{\n");
		assert.throws(
			() => loadFixtures(malformedJson, ["broken"]),
			/malformed JSON/,
			"loader accepted malformed JSONL",
		);

		const malformedExpectation = join(root, "malformed-expectation");
		mkdirSync(malformedExpectation);
		writeFileSync(
			join(malformedExpectation, "broken.jsonl"),
			`${JSON.stringify({
				fixture: "broken",
				at_ms: 0,
				event: { type: "agent_start" },
				expect: [{ kind: "agent.run", phase: "start", severity: "info", parent_id: "session-1" }],
			})}\n`,
		);
		assert.throws(
			() => loadFixtures(malformedExpectation, ["broken"]),
			/\.state is required/,
			"loader accepted malformed expectations",
		);

		const invalidExpectationEnum = join(root, "invalid-expectation-enum");
		mkdirSync(invalidExpectationEnum);
		writeFileSync(
			join(invalidExpectationEnum, "broken.jsonl"),
			`${JSON.stringify({
				fixture: "broken",
				at_ms: 0,
				event: { type: "agent_start" },
				expect: [{
					kind: "made.up",
					phase: "start",
					severity: "info",
					state: "running",
					parent_id: "session-1",
				}],
			})}\n`,
		);
		assert.throws(
			() => loadFixtures(invalidExpectationEnum, ["broken"]),
			/\.kind is invalid/,
			"loader accepted invalid expectation enums",
		);

		const unsafeExpectationAttribute = join(root, "unsafe-expectation-attribute");
		mkdirSync(unsafeExpectationAttribute);
		writeFileSync(
			join(unsafeExpectationAttribute, "broken.jsonl"),
			`${JSON.stringify({
				fixture: "broken",
				at_ms: 0,
				event: { type: "agent_start" },
				expect: [{
					kind: "agent.run",
					phase: "start",
					severity: "info",
					state: "running",
					parent_id: "session-1",
					attributes: { authorization: "private" },
				}],
			})}\n`,
		);
		assert.throws(
			() => loadFixtures(unsafeExpectationAttribute, ["broken"]),
			/forbidden authorization|unknown attribute authorization/,
			"loader accepted unsafe expectation attributes",
		);

		const mismatchedName = join(root, "mismatched-name");
		mkdirSync(mismatchedName);
		writeFileSync(
			join(mismatchedName, "alpha.jsonl"),
			`${JSON.stringify({
				fixture: "beta",
				at_ms: 0,
				event: { type: "agent_start" },
				expect: [{
					kind: "agent.run",
					phase: "start",
					severity: "info",
					state: "running",
					parent_id: "session-1",
				}],
			})}\n`,
		);
		assert.throws(
			() => loadFixtures(mismatchedName, ["alpha"]),
			/fixture name mismatch/,
			"loader accepted file-to-fixture name drift",
		);

		const missingFile = join(root, "missing-file");
		mkdirSync(missingFile);
		assert.throws(
			() => loadFixtures(missingFile, ["alpha"]),
			/fixture filenames must map one-to-one/,
			"loader accepted missing scenario fixture",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function buildServer() {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npm, ["run", "build:server"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.status !== 0) {
		throw new Error(`server build failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	}
}

function assistantMessage(stopReason, timestamp) {
	return {
		role: "assistant",
		content: [],
		api: "fixture-api",
		provider: "fixture-provider",
		model: "fixture-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

function sdkEvent(event, timestamp) {
	switch (event.type) {
		case "agent_start":
		case "turn_start":
			return { type: event.type };
		case "agent_end":
			return {
				type: event.type,
				messages: [assistantMessage(event.stopReason, timestamp)],
				willRetry: event.willRetry,
			};
		case "turn_end":
			return {
				type: event.type,
				message: assistantMessage(event.stopReason, timestamp),
				toolResults: [],
			};
		case "tool_execution_start":
			return { ...event, args: { privateFixtureArgument: "DO_NOT_SERIALIZE" } };
		case "tool_execution_end":
			return {
				...event,
				result: { privateFixtureResult: "DO_NOT_SERIALIZE" },
			};
		default:
			throw new Error(`unsupported fixture event ${event.type}`);
	}
}

function pickActual(record, expectation) {
	const actual = {};
	for (const key of Object.keys(expectation)) {
		switch (key) {
			case "parent_id":
			case "tool_call_id":
			case "trace_id":
			case "turn_id":
			case "step_id":
			case "request_id":
				actual[key] = record.correlation?.[key];
				break;
			case "attributes": {
				const attributes = {};
				for (const attribute of Object.keys(expectation.attributes)) {
					attributes[attribute] = record.attributes?.[attribute];
				}
				actual.attributes = attributes;
				break;
			}
			default:
				actual[key] = record[key];
		}
	}
	return actual;
}

async function waitFor(check, description, timeoutMs = 5_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const value = check();
		if (value) return value;
		await sleep(10);
	}
	throw new Error(`timeout waiting for ${description}`);
}

async function startQueueBoundary(TelemetrySocketClient) {
	const root = mkdtempSync(join(tmpdir(), "pi-telemetry-scenarios-queue-"));
	const socketPath = join(root, "telemetry.sock");
	const received = [];
	let sequence = 0;
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				received.push(JSON.parse(line));
				sequence++;
				socket.write(`${JSON.stringify({
					accepted: true,
					event_id: `scenario-${sequence}`,
					sequence,
					error: null,
				})}\n`);
			}
		});
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	const client = new TelemetrySocketClient({ socketPath });
	return {
		client,
		received,
		async close() {
			client.dispose();
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
			rmSync(root, { recursive: true, force: true });
		},
	};
}

async function runScenario(fixture, PiEventMapper, queue) {
	const clock = { wall: 1_700_000_000_000, mono: 0 };
	const mapper = new PiEventMapper({
		source: { host_id: "fixture-host", component: "pi", version: "0.84.4" },
		sessionId: "session-1",
		conversationId: `conversation-${fixture.name}`,
		idNamespace: fixture.name,
		wallNow: () => clock.wall,
		monotonicNow: () => clock.mono,
	});
	const records = [];
	for (const [index, step] of fixture.steps.entries()) {
		clock.mono = step.at_ms;
		clock.wall = 1_700_000_000_000 + step.at_ms;
		const mapped = step.event
			? mapper.map(sdkEvent(step.event, clock.wall))
			: mapper.observeStall(step.observe.stall_threshold_ms);
		assert.equal(
			mapped.length,
			step.expect.length,
			`${fixture.name} step ${index + 1} emitted ${mapped.length}, expected ${step.expect.length}`,
		);
		mapped.forEach((record, recordIndex) => {
			assert.deepEqual(
				pickActual(record, step.expect[recordIndex]),
				step.expect[recordIndex],
				`${fixture.name} step ${index + 1} record ${recordIndex + 1}`,
			);
			assert.equal(record.privacy_class, "operator");
			const serialized = JSON.stringify(record);
			assert.ok(!serialized.includes("DO_NOT_SERIALIZE"), `${fixture.name} leaked tool payload`);
			assert.ok(!serialized.includes("headers"), `${fixture.name} leaked provider headers`);
			queue.client.emit(record);
			records.push(record);
		});
	}
	mapper.dispose();
	return records;
}

const fixtures = loadFixtures(FIXTURE_DIR);
proveLoaderRejectsMalformedFixtures();
buildServer();
const [{ PiEventMapper }, { TelemetrySocketClient }] = await Promise.all([
	import(pathToFileURL(join(REPO_ROOT, "dist", "server", "telemetry", "pi-event-mapper.js"))),
	import(pathToFileURL(join(REPO_ROOT, "dist", "server", "telemetry", "client.js"))),
]);
const queue = await startQueueBoundary(TelemetrySocketClient);
let exitCode = 0;
try {
	const results = new Map();
	for (const fixture of fixtures) {
		const records = await runScenario(fixture, PiEventMapper, queue);
		results.set(fixture.name, records);
		console.log(`PASS ${fixture.name}: ${records.length} normalized records`);
	}

	const normal = results.get("normal");
	assert.deepEqual(
		normal.map((record) => `${record.kind}:${record.phase}:${record.state}`),
		[
			"agent.run:start:running",
			"agent.turn:start:running",
			"tool.execution:start:running",
			"tool.execution:end:completed",
			"agent.turn:end:completed",
			"agent.run:end:completed",
		],
		"normal lifecycle lost causal order",
	);

	const stalled = results.get("model-stall");
	assert.equal(stalled.at(-1).kind, "agent.stall");
	assert.equal(stalled.at(-1).duration_ms, 180_000);
	assert.ok(stalled.every((record) => record.phase !== "end"), "stall synthesized an end record");
	assert.ok(stalled.every((record) => record.state !== "completed"), "stall synthesized completion");
	assert.ok(stalled.every((record) => record.state !== "cancelled"), "stall synthesized abort");

	const longTool = results.get("long-tool");
	const longToolEnd = longTool.find(
		(record) => record.kind === "tool.execution" && record.phase === "end",
	);
	assert.equal(longToolEnd.duration_ms, 240_000, "long tool lost duration across observation");
	assert.equal(longToolEnd.correlation.parent_id, "long-tool:request:1");

	const toolError = results.get("tool-error");
	const failedTool = toolError.find(
		(record) => record.kind === "tool.execution" && record.phase === "end",
	);
	assert.equal(failedTool.state, "error");
	assert.equal(failedTool.severity, "error");
	assert.equal(failedTool.attributes.is_error, true);

	const cancelled = results.get("cancelled");
	const cancelledEnds = cancelled.filter((record) => record.phase === "end");
	assert.deepEqual(cancelledEnds.map((record) => record.state), ["cancelled", "cancelled"]);
	assert.ok(cancelled.every((record) => record.state !== "completed"));

	const emittedCount = [...results.values()].reduce((count, records) => count + records.length, 0);
	await waitFor(
		() => queue.client.health().accepted === emittedCount,
		`${emittedCount} queue acknowledgements`,
	);
	assert.equal(queue.received.length, emittedCount);
	assert.deepEqual(queue.client.health(), {
		state: "connected",
		queued: 0,
		accepted: emittedCount,
		rejected: 0,
		errors: 0,
		gaps: 0,
	});
	console.log(`PASS integrated queue boundary: ${emittedCount}/${emittedCount} accepted`);
	console.log(
		"PASS fixture loader rejects malformed JSONL, expectations, unsafe attributes, and name drift",
	);
} catch (error) {
	exitCode = 1;
	console.error(`FAIL ${error.stack ?? error}`);
} finally {
	await queue.close();
}
process.exitCode = exitCode;
