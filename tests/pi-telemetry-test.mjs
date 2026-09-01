import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createUnixServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORT = 8976;

function fixtureDirs(prefix) {
	const base = mkdtempSync(join(tmpdir(), prefix));
	const dataDir = join(base, "data");
	const agentDir = join(base, "agent");
	const projectDir = join(base, "project-a");
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	return { base, dataDir, agentDir, projectDir };
}

async function waitFor(check, description, timeoutMs = 8_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const value = await check();
		if (value) return value;
		await sleep(20);
	}
	throw new Error(`timeout waiting for ${description}`);
}

function captureStallTimer(client) {
	if (client.stallTimer) clearInterval(client.stallTimer);
	client.stallTimer = null;
	const originalSetInterval = globalThis.setInterval;
	let callback;
	globalThis.setInterval = (fn) => {
		callback = fn;
		return { unref() {} };
	};
	try {
		client.startStallTimer();
	} finally {
		globalThis.setInterval = originalSetInterval;
	}
	if (typeof callback !== "function") throw new Error("stall timer callback was not installed");
	client.stallTimer = null;
	return callback;
}

function forceStreaming(session) {
	const ownDescriptor = Object.getOwnPropertyDescriptor(session, "isStreaming");
	Object.defineProperty(session, "isStreaming", {
		configurable: true,
		get: () => true,
	});
	return () => {
		if (ownDescriptor) Object.defineProperty(session, "isStreaming", ownDescriptor);
		else delete session.isStreaming;
	};
}

function tickAt(callback, nowMs) {
	const originalDateNow = Date.now;
	Date.now = () => nowMs;
	try {
		callback();
	} finally {
		Date.now = originalDateNow;
	}
}

function assistantMessage(content, stopReason, timestamp, usageOverrides = {}) {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "fixture-provider",
		model: "fixture-model",
		usage: {
			input: usageOverrides.input ?? 0,
			output: usageOverrides.output ?? 0,
			cacheRead: usageOverrides.cacheRead ?? 0,
			cacheWrite: usageOverrides.cacheWrite ?? 0,
			...(usageOverrides.reasoning === undefined
				? {}
				: { reasoning: usageOverrides.reasoning }),
			totalTokens: usageOverrides.totalTokens ?? 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

function emitFixture(session, toolCallId) {
	const thinking = assistantMessage(
		[{ type: "thinking", thinking: "fixture thought" }],
		"pending",
		1_000,
	);
	const toolUse = assistantMessage(
		[
			{ type: "thinking", thinking: "fixture thought" },
			{ type: "text", text: "checking fixture" },
			{ type: "toolCall", id: toolCallId, name: "fixture_tool", arguments: { path: "README.md" } },
		],
		"toolUse",
		1_001,
		{ input: 5, output: 3, cacheRead: 1, cacheWrite: 0, reasoning: 2, totalTokens: 9 },
	);
	const toolResult = {
		role: "toolResult",
		toolCallId,
		toolName: "fixture_tool",
		content: [{ type: "text", text: "fixture tool output" }],
		details: { line_count: 4 },
		isError: false,
		timestamp: 1_002,
	};
	const finished = assistantMessage(
		[{ type: "text", text: "fixture final response" }],
		"stop",
		1_003,
		{ input: 11, output: 7, cacheRead: 3, cacheWrite: 2, reasoning: 4, totalTokens: 23 },
	);
	session._emit({ type: "agent_start" });
	session._emit({ type: "turn_start" });
	session._emit({
		type: "message_end",
		message: { role: "user", content: "inspect fixture status", timestamp: 999 },
	});
	session._emit({ type: "message_start", message: assistantMessage([], "pending", 1_000) });
	session._emit({
		type: "message_update",
		message: thinking,
		assistantMessageEvent: {
			type: "thinking_end",
			contentIndex: 0,
			content: "fixture thought",
			partial: thinking,
		},
	});
	session._emit({ type: "message_end", message: toolUse });
	session._emit({
		type: "tool_execution_start",
		toolCallId,
		toolName: "fixture_tool",
		args: { path: "README.md" },
	});
	session._emit({
		type: "tool_execution_end",
		toolCallId,
		toolName: "fixture_tool",
		result: { content: toolResult.content, details: toolResult.details },
		isError: false,
	});
	session._emit({ type: "message_end", message: toolResult });
	session._emit({ type: "turn_end", message: toolUse, toolResults: [toolResult] });
	session._emit({ type: "turn_start" });
	session._emit({ type: "message_start", message: assistantMessage([], "pending", 1_003) });
	session._emit({ type: "message_end", message: finished });
	session._emit({ type: "turn_end", message: finished, toolResults: [] });
	session._emit({ type: "agent_end", messages: [finished], willRetry: false });
}

function recordHasTool(record, sourceToolCallId) {
	const id = record.correlation?.tool_call_id;
	return id === sourceToolCallId || id?.endsWith(`:tool:${sourceToolCallId}`);
}

function sha256Json(value) {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function lifecycleSpanKey(record) {
	if (record.kind === "tool.execution") return `tool:${record.correlation?.tool_call_id}`;
	if (record.kind === "agent.turn") return `turn:${record.correlation?.turn_id}`;
	if (record.kind === "agent.run") return `run:${record.correlation?.trace_id}`;
	return null;
}

class WireClient {
	constructor(ws) {
		this.ws = ws;
		this.messages = [];
		this.state = null;
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.messages.push(message);
			if (message.type === "snapshot") this.state = message.state;
			else if (
				message.type === "snapshot_delta" &&
				this.state?.rev === message.baseRev
			) {
				this.state = {
					...this.state,
					...message.state,
					messages: [...(this.state.messages ?? []), ...message.appended],
				};
			}
		});
	}

	send(message) {
		this.ws.send(JSON.stringify(message));
	}

	async next(type, predicate = () => true) {
		return waitFor(() => {
			const index = this.messages.findIndex(
				(message) => message.type === type && predicate(message),
			);
			if (index < 0) return undefined;
			return this.messages.splice(index, 1)[0];
		}, type);
	}
}

async function runNoEnvChild() {
	const fixture = fixtureDirs("pi-web-telemetry-no-env-");
	let appModule;
	let exitCode = 0;
	try {
		delete process.env.UA_TELEMETRY_SOCKET;
		delete process.env.UA_ROBOT_ID;
		delete process.env.UA_AGENT_INSTANCE_ID;
		process.env.PI_WEB_PORT = String(PORT - 1);
		process.env.PI_WEB_DATA_DIR = fixture.dataDir;
		process.env.PI_WEB_CWD = fixture.projectDir;
		process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
		appModule = await import(
			`${pathToFileURL(join(REPO_ROOT, "dist/server/index.js")).href}?no-env=${randomUUID()}`
		);
		if (!("telemetryClient" in appModule) || !("service" in appModule)) {
			throw new Error("server telemetry lifecycle exports are missing");
		}
		if (appModule.telemetryClient !== undefined) {
			throw new Error("missing telemetry env created a socket client");
		}
		const projected = [];
		const client = await appModule.service.attach("no-env-fixture", (message) => {
			projected.push(message);
		});
		const conversation = client.convs.get(client.activeId);
		if (!conversation || conversation.telemetryMapper !== undefined) {
			throw new Error("missing telemetry env created a conversation mapper");
		}
		client.session._emit({
			type: "tool_execution_end",
			toolCallId: "no-env-tool",
			toolName: "fixture_tool",
			result: { content: [], details: {} },
			isError: false,
		});
		await waitFor(
			() => projected.some((message) =>
				message.type === "tool_status" && message.toolCallId === "no-env-tool"),
			"no-env UI projection",
		);
		const stallTick = captureStallTimer(client);
		const restoreStreaming = forceStreaming(client.session);
		try {
			const beforeNoticeCount = projected.filter((message) => message.type === "notice").length;
			const conversation = client.convs.get(client.activeId);
			conversation.lastSdkEventAt = 1_000;
			tickAt(stallTick, 181_000);
			await waitFor(
				() => projected.filter((message) => message.type === "notice").length === beforeNoticeCount + 1,
				"no-env stall warning",
			);
			if (!projected.some((message) =>
				message.type === "notice" &&
				message.level === "warning" &&
				message.text.includes("3 分钟"))) {
				throw new Error("no-env stall warning changed or was not emitted");
			}
		} finally {
			restoreStreaming();
		}
		console.log("PASS no env preserves stall warning without telemetry mapper");
		console.log("PASS no env preserves baseline projection without telemetry objects");
	} catch (error) {
		exitCode = 1;
		console.error(`FAIL no-env ${error.stack ?? error}`);
	} finally {
		if (appModule?.closeServer) await appModule.closeServer();
		rmSync(fixture.base, { recursive: true, force: true });
	}
	return exitCode;
}

async function runSystemdQuitChild() {
	delete process.env.UA_TELEMETRY_SOCKET;
	const appModule = await import(
		`${pathToFileURL(join(REPO_ROOT, "dist/server/index.js")).href}?systemd-quit=${randomUUID()}`
	);
	Object.defineProperty(process, "platform", { value: "linux" });
	appModule.service.disposeAll = () => new Promise(() => {});
	appModule.service.onQuit();
	await new Promise(() => {});
}

if (process.argv.includes("--no-env-child")) {
	process.exit(await runNoEnvChild());
}
if (process.argv.includes("--systemd-quit-child")) {
	await runSystemdQuitChild();
}

const fixture = fixtureDirs("pi-web-telemetry-");
const projectB = join(fixture.base, "project-b");
const socketPath = join(fixture.base, "telemetry.sock");
mkdirSync(projectB, { recursive: true });

const records = [];
const telemetryLines = [];
const telemetrySockets = new Set();
let connectionCount = 0;
let acknowledgementMode = "valid";
let acknowledgementSequence = 0;
const telemetryServer = createUnixServer((socket) => {
	connectionCount++;
	telemetrySockets.add(socket);
	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("error", () => {
		// Malformed-ACK recovery intentionally closes a socket mid-write.
	});
	socket.on("data", (chunk) => {
		buffered += chunk;
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			if (!line) continue;
			telemetryLines.push(line);
			records.push(JSON.parse(line));
			if (acknowledgementMode === "malformed-once") {
				acknowledgementMode = "valid";
				socket.write('{"accepted":true}\n');
				continue;
			}
			acknowledgementSequence++;
			socket.write(`${JSON.stringify({
				accepted: true,
				event_id: `fixture-${acknowledgementSequence}`,
				sequence: acknowledgementSequence,
				error: null,
			})}\n`);
		}
	});
	socket.on("close", () => telemetrySockets.delete(socket));
});

let appModule;
let ws;
let exitCode = 0;
try {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const build = spawnSync(npm, ["run", "build:server"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 30_000,
	});
	if (build.status !== 0) {
		throw new Error(`server build failed\n${build.stdout ?? ""}${build.stderr ?? ""}`);
	}
	const noEnv = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--no-env-child"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 30_000,
	});
	if (noEnv.stdout) process.stdout.write(noEnv.stdout);
	if (noEnv.stderr) process.stderr.write(noEnv.stderr);
	if (noEnv.status !== 0) throw new Error("no-env fixture failed");
	const systemdFixture = fixtureDirs("pi-web-telemetry-systemd-quit-");
	const systemdEnv = {
		...process.env,
		INVOCATION_ID: "fixture-systemd",
		PI_WEB_PORT: String(PORT - 2),
		PI_WEB_DATA_DIR: systemdFixture.dataDir,
		PI_WEB_CWD: systemdFixture.projectDir,
		PI_CODING_AGENT_DIR: systemdFixture.agentDir,
	};
	delete systemdEnv.UA_TELEMETRY_SOCKET;
	const systemdQuit = spawnSync(
		process.execPath,
		[fileURLToPath(import.meta.url), "--systemd-quit-child"],
		{
			cwd: REPO_ROOT,
			env: systemdEnv,
			encoding: "utf8",
			timeout: 2_000,
			killSignal: "SIGKILL",
		},
	);
	rmSync(systemdFixture.base, { recursive: true, force: true });
	if (systemdQuit.status !== 3) {
		throw new Error(
			`systemd quit waited for cleanup instead of exiting 3: status=${systemdQuit.status} signal=${systemdQuit.signal}`,
		);
	}
	console.log("PASS no-env systemd quit preserves immediate exit code 3");

	await new Promise((resolve, reject) => {
		telemetryServer.once("error", reject);
		telemetryServer.listen(socketPath, resolve);
	});
	process.env.PI_WEB_PORT = String(PORT);
	process.env.PI_WEB_DATA_DIR = fixture.dataDir;
	process.env.PI_WEB_CWD = fixture.projectDir;
	process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
	process.env.UA_TELEMETRY_SOCKET = socketPath;
	process.env.UA_ROBOT_ID = "fixture-robot";
	process.env.UA_AGENT_INSTANCE_ID = "fixture-agent";

	appModule = await import(
		`${pathToFileURL(join(REPO_ROOT, "dist/server/index.js")).href}?fixture=${randomUUID()}`
	);
	if (!appModule.telemetryClient || !appModule.service || !appModule.closeServer) {
		throw new Error("server telemetry wiring exports are missing");
	}
	await waitFor(async () => {
		try {
			return (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok;
		} catch {
			return false;
		}
	}, "server health");

	ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const wire = new WireClient(ws);
	wire.send({ type: "hello", clientId: "pi-telemetry-fixture" });
	await wire.next("ready");
	const initialSnapshot = await wire.next("snapshot");
	const client = appModule.service.get("pi-telemetry-fixture");
	if (!client) throw new Error("fixture client session missing");
	const firstConversation = client.convs.get(client.activeId);
	if (!firstConversation?.telemetryMapper) {
		throw new Error("initial conversation mapper missing");
	}

	const originalSystemPrompt = client.session.agent.state.systemPrompt;
	const originalActiveTools = client.session.agent.state.tools;
	const promptSentinelA = "PRIVATE_CONTEXT_PROMPT_SENTINEL_A";
	const promptSentinelB = "PRIVATE_CONTEXT_PROMPT_SENTINEL_B";
	const schemaSentinelA = "PRIVATE_CONTEXT_SCHEMA_SENTINEL_A";
	const schemaSentinelB = "PRIVATE_CONTEXT_SCHEMA_SENTINEL_B";
	const alphaToolName = "private_alpha_context_tool";
	const zetaToolName = "private_zeta_context_tool";
	const renamedToolName = "private_omega_context_tool";
	const alphaSchema = { type: "object" };
	const schemaA = {
		properties: { marker: { const: schemaSentinelA, type: "string" } },
		type: "object",
	};
	const schemaB = {
		properties: { marker: { const: schemaSentinelB, type: "string" } },
		type: "object",
	};
	const tool = (name, parameters) => ({
		name,
		label: name,
		description: "context fixture",
		parameters,
		execute: async () => ({ content: [], details: {} }),
	});
	const alphaTool = tool(alphaToolName, alphaSchema);
	const zetaTool = tool(zetaToolName, schemaA);
	const contextFinished = assistantMessage([{ type: "text", text: "context" }], "stop", 999);
	const contextOffset = records.length;
	const contextLineOffset = telemetryLines.length;
	client.session.agent.state.systemPrompt = promptSentinelA;
	client.session.agent.state.tools = [zetaTool, alphaTool];
	client.session._emit({ type: "agent_start" });
	client.session._emit({ type: "turn_start" });
	client.session._emit({ type: "turn_end", message: contextFinished, toolResults: [] });
	client.session.agent.state.tools = [alphaTool, zetaTool];
	client.session._emit({ type: "turn_start" });
	client.session._emit({ type: "turn_end", message: contextFinished, toolResults: [] });
	client.session.agent.state.systemPrompt = promptSentinelB;
	client.session._emit({ type: "turn_start" });
	client.session._emit({ type: "turn_end", message: contextFinished, toolResults: [] });
	client.session.agent.state.tools = [tool(renamedToolName, schemaA), alphaTool];
	client.session._emit({ type: "turn_start" });
	client.session._emit({ type: "turn_end", message: contextFinished, toolResults: [] });
	client.session.agent.state.tools = [tool(renamedToolName, schemaB), alphaTool];
	client.session._emit({ type: "turn_start" });
	client.session._emit({ type: "turn_end", message: contextFinished, toolResults: [] });
	client.session._emit({ type: "agent_end", messages: [contextFinished], willRetry: false });
	client.session.agent.state.systemPrompt = originalSystemPrompt;
	client.session.agent.state.tools = originalActiveTools;
	await waitFor(
		() => records.slice(contextOffset).filter((record) => record.kind === "context.changed").length === 4,
		"effective context telemetry",
	);
	const contextSlice = records.slice(contextOffset);
	const contextRecords = contextSlice.filter((record) => record.kind === "context.changed");
	const initialToolHash = sha256Json([
		{ name: alphaToolName, schema: alphaSchema },
		{ name: zetaToolName, schema: schemaA },
	]);
	const renamedToolHash = sha256Json([
		{ name: alphaToolName, schema: alphaSchema },
		{ name: renamedToolName, schema: schemaA },
	]);
	const changedSchemaHash = sha256Json([
		{ name: alphaToolName, schema: alphaSchema },
		{ name: renamedToolName, schema: schemaB },
	]);
	if (
		contextRecords[0].attributes?.system_prompt_hash !== sha256Json(promptSentinelA) ||
		contextRecords[0].attributes?.tool_schema_hash !== initialToolHash ||
		contextRecords[1].attributes?.system_prompt_hash !== sha256Json(promptSentinelB) ||
		contextRecords[1].attributes?.tool_schema_hash !== initialToolHash ||
		contextRecords[2].attributes?.tool_schema_hash !== renamedToolHash ||
		contextRecords[3].attributes?.tool_schema_hash !== changedSchemaHash
	) {
		throw new Error("effective prompt/tool context hashes did not change or suppress correctly");
	}
	if (
		!contextRecords[0].correlation?.trace_id ||
		contextRecords[0].correlation.parent_id !== contextRecords[0].correlation.trace_id ||
		!contextRecords[1].correlation?.turn_id ||
		!contextRecords[1].correlation?.step_id ||
		!contextRecords[1].correlation?.request_id ||
		contextRecords[1].correlation.parent_id !== contextRecords[1].correlation.request_id
	) {
		throw new Error("context telemetry did not use current run/turn/request correlation");
	}
	for (const record of contextRecords) {
		if (
			!/^sha256:[0-9a-f]{64}$/.test(record.attributes?.system_prompt_hash ?? "") ||
			!/^sha256:[0-9a-f]{64}$/.test(record.attributes?.tool_schema_hash ?? "")
		) {
			throw new Error("context telemetry emitted a non-hash context attribute");
		}
		const index = contextSlice.indexOf(record);
		if (
			index < 0 ||
			!contextSlice[index + 1] ||
			contextSlice[index + 1].phase !== "start" ||
			(contextSlice[index + 1].kind !== "agent.run" && contextSlice[index + 1].kind !== "agent.turn")
		) {
			throw new Error("context telemetry did not precede its lifecycle start");
		}
	}
	const serializedContext = telemetryLines.slice(contextLineOffset).join("\n");
	for (const rawValue of [
		promptSentinelA,
		promptSentinelB,
		schemaSentinelA,
		schemaSentinelB,
		alphaToolName,
		zetaToolName,
		renamedToolName,
	]) {
		if (serializedContext.includes(rawValue)) {
			throw new Error("context telemetry exposed raw prompt or tool schema data");
		}
	}
	console.log("PASS effective prompt and sorted active tools emit only changed context hashes");

	const captureFailureOffset = records.length;
	const captureFailureLineOffset = telemetryLines.length;
	const captureFailureHealth = appModule.telemetryClient.health();
	const captureErrorSentinel = "PRIVATE_CONTEXT_CAPTURE_ERROR";
	Object.defineProperty(client.session, "systemPrompt", {
		configurable: true,
		get() {
			throw new Error(captureErrorSentinel);
		},
	});
	try {
		client.session._emit({ type: "agent_start" });
		client.session._emit({ type: "agent_end", messages: [contextFinished], willRetry: false });
	} finally {
		delete client.session.systemPrompt;
	}
	await waitFor(
		() => records.slice(captureFailureOffset).some((record) =>
			record.kind === "agent.run" && record.phase === "end"),
		"lifecycle telemetry after context capture failure",
	);
	const afterCaptureFailure = appModule.telemetryClient.health();
	if (
		afterCaptureFailure.errors !== captureFailureHealth.errors + 1 ||
		afterCaptureFailure.gaps !== captureFailureHealth.gaps ||
		records.slice(captureFailureOffset).some((record) => record.kind === "context.changed") ||
		telemetryLines.slice(captureFailureLineOffset).join("\n").includes(captureErrorSentinel)
	) {
		throw new Error("context capture failure blocked lifecycle mapping or leaked error text");
	}
	console.log("PASS context capture failure preserves content-free lifecycle telemetry");

	const normalOffset = records.length;
	emitFixture(client.session, "normal-tool");
	await wire.next("tool_status", (message) => message.toolCallId === "normal-tool");
	await waitFor(
		() => records.slice(normalOffset).filter((record) => record.kind !== "context.changed").length >= 15,
		"ordered telemetry records",
	);
	const normalRecords = records
		.slice(normalOffset)
		.filter((record) => record.kind !== "context.changed")
		.slice(0, 15);
	const normalContextRecord = records
		.slice(normalOffset)
		.find((record) => record.kind === "context.changed");
	if (!normalContextRecord) {
		throw new Error("normal production lifecycle omitted context telemetry");
	}
	const order = normalRecords.map((record) => `${record.kind}:${record.phase}`);
	const expectedOrder = [
		"agent.run:start",
		"agent.turn:start",
		"user.message:observation",
		"model.response:start",
		"provider.thinking:end",
		"model.response:end",
		"tool.execution:start",
		"tool.execution:end",
		"tool.result:observation",
		"agent.turn:end",
		"agent.turn:start",
		"model.response:start",
		"model.response:end",
		"agent.turn:end",
		"agent.run:end",
	];
	if (JSON.stringify(order) !== JSON.stringify(expectedOrder)) {
		throw new Error(`telemetry order mismatch: ${JSON.stringify(order)}`);
	}
	const initialSessionId = client.session.sessionId;
	if (normalRecords.some((record) =>
		record.correlation?.session_id !== initialSessionId ||
		record.correlation?.conversation_id !== firstConversation.telemetryConversationId ||
		record.attributes?.project_cwd !== fixture.projectDir ||
		record.source.robot_id !== "fixture-robot" ||
		record.source.instance_id !== "fixture-agent")) {
		throw new Error("normal telemetry metadata mismatch");
	}
	const userRecord = normalRecords.find((record) => record.kind === "user.message");
	const modelRecords = normalRecords.filter((record) => record.kind === "model.response");
	const finalModel = modelRecords.find((record) => record.phase === "end" && record.state === "completed");
	const toolStartRecord = normalRecords.find(
		(record) => record.kind === "tool.execution" && record.phase === "start",
	);
	const toolEndRecord = normalRecords.find(
		(record) => record.kind === "tool.execution" && record.phase === "end",
	);
	const toolResultRecord = normalRecords.find((record) => record.kind === "tool.result");
	const thinkingRecord = normalRecords.find((record) => record.kind === "provider.thinking");
	if (
		userRecord?.attributes.input_detail !== "inspect fixture status" ||
		JSON.stringify(toolStartRecord?.attributes.input) !== JSON.stringify({ path: "README.md" }) ||
		toolEndRecord?.attributes.output?.details?.line_count !== 4 ||
		toolResultRecord?.attributes.output?.details?.line_count !== 4 ||
		finalModel?.attributes.output_detail !== "fixture final response" ||
		finalModel?.attributes.input_tokens !== 11 ||
		finalModel?.attributes.output_tokens !== 7 ||
		finalModel?.attributes.total_tokens !== 23 ||
		thinkingRecord?.attributes.content !== "fixture thought" ||
		modelRecords.some((record) => JSON.stringify(record).includes("fixture thought"))
	) {
		throw new Error("normal telemetry content, token, or thinking separation mismatch");
	}
	wire.send({ type: "get_state" });
	const projectedSnapshot = await wire.next("snapshot");
	if (
		projectedSnapshot.state.conversationId !== initialSnapshot.state.conversationId ||
		JSON.stringify(projectedSnapshot.state.messages) !==
			JSON.stringify(initialSnapshot.state.messages)
	) {
		throw new Error("telemetry changed WebSocket snapshot projection");
	}
	console.log("PASS ordered records preserve metadata, privacy, and UI snapshot");

	const stallTick = captureStallTimer(client);
	const restoreStreaming = forceStreaming(firstConversation.session);
	const originalInterruptRun = client.interruptRun;
	let stallAbortCalls = 0;
	client.interruptRun = async () => {
		stallAbortCalls++;
	};
	try {
		const stallOffset = records.length;
		firstConversation.session._emit({ type: "agent_start" });
		firstConversation.session._emit({ type: "turn_start" });
		const turnStart = await waitFor(
			() => records.slice(stallOffset).find((record) =>
				record.kind === "agent.turn" && record.phase === "start"),
			"stall fixture turn start",
		);
		const firstEventAt = turnStart.attributes.source_timestamp_ms;
		firstConversation.lastSdkEventAt = firstEventAt;
		const noticeOffset = wire.messages.length;
		tickAt(stallTick, firstEventAt + 180_000);
		const firstStall = await waitFor(
			() => records.slice(stallOffset).find((record) => record.kind === "agent.stall"),
			"first integrated stall record",
		);
		const firstNotice = await waitFor(
			() => wire.messages.slice(noticeOffset).find((message) =>
				message.type === "notice" && message.level === "warning"),
			"first integrated stall warning",
		);
		if (
			firstStall.phase !== "observation" ||
			firstStall.state !== "possibly_stalled" ||
			firstStall.severity !== "warning" ||
			firstStall.duration_ms !== 180_000 ||
			firstStall.attributes?.silence_ms !== 180_000 ||
			firstStall.attributes?.threshold_ms !== 180_000 ||
			!firstNotice.text.includes("3 分钟") ||
			stallAbortCalls !== 0 ||
			records.slice(stallOffset).some((record) =>
				record.phase === "end" || record.state === "completed" || record.state === "cancelled")
		) {
			throw new Error("integrated stall changed warning, timing, or lifecycle state");
		}

		const afterFirstStallCount = records.filter((record) => record.kind === "agent.stall").length;
		const afterFirstNoticeCount = wire.messages.filter((message) =>
			message.type === "notice" && message.level === "warning").length;
		tickAt(stallTick, firstEventAt + 180_001);
		await sleep(30);
		if (
			records.filter((record) => record.kind === "agent.stall").length !== afterFirstStallCount ||
			wire.messages.filter((message) =>
				message.type === "notice" && message.level === "warning").length !== afterFirstNoticeCount
		) {
			throw new Error("same silence episode emitted duplicate stall output");
		}

		const secondEpisodeOffset = records.length;
		const secondEventAt = firstEventAt + 180_002;
		tickAt(
			() => firstConversation.session._emit({
				type: "tool_execution_update",
				toolCallId: "stall-activity-tool",
				toolName: "fixture_tool",
				args: { privateActivityArgument: "PRIVATE_ACTIVITY_PAYLOAD" },
				partialResult: { privateActivityResult: "PRIVATE_ACTIVITY_PAYLOAD" },
			}),
			secondEventAt,
		);
		if (
			records.length !== secondEpisodeOffset ||
			JSON.stringify(records.slice(secondEpisodeOffset)).includes("PRIVATE_ACTIVITY_PAYLOAD")
		) {
			throw new Error("unmapped activity emitted or leaked telemetry payload");
		}
		tickAt(stallTick, secondEventAt + 180_000);
		const secondStall = await waitFor(
			() => records.slice(secondEpisodeOffset).find((record) => record.kind === "agent.stall"),
			"second integrated stall record",
		);
		if (
			JSON.stringify(secondStall).includes("PRIVATE_ACTIVITY_PAYLOAD") ||
			stallAbortCalls !== 0
		) {
			throw new Error("activity leaked payload or stall observation aborted Pi work");
		}

		const activityMapper = firstConversation.telemetryMapper;
		const originalNoteActivity = activityMapper.noteActivity;
		activityMapper.noteActivity = () => {
			throw new Error("fixture activity failure");
		};
		const beforeActivityFailure = appModule.telemetryClient.health();
		const activityFailureOffset = records.length;
		firstConversation.session._emit({
			type: "tool_execution_end",
			toolCallId: "activity-failure-tool",
			toolName: "fixture_tool",
			result: { content: [], details: {} },
			isError: false,
		});
		await wire.next("tool_status", (message) => message.toolCallId === "activity-failure-tool");
		await waitFor(
			() => records.slice(activityFailureOffset).some((record) =>
				record.kind === "tool.execution" &&
				record.correlation?.tool_call_id?.endsWith(":tool:activity-failure-tool")),
			"mapping after activity failure",
		);
		const afterActivityFailure = appModule.telemetryClient.health();
		activityMapper.noteActivity = originalNoteActivity;
		if (
			afterActivityFailure.errors !== beforeActivityFailure.errors + 1 ||
			afterActivityFailure.gaps !== beforeActivityFailure.gaps ||
			stallAbortCalls !== 0
		) {
			throw new Error("activity failure blocked work or was not accounted");
		}

		const mapper = firstConversation.telemetryMapper;
		firstConversation.telemetryMapper = undefined;
		firstConversation.stallNoticed = false;
		firstConversation.lastSdkEventAt = secondEventAt + 1;
		const mapperlessNoticeOffset = wire.messages.length;
		const mapperlessRecordOffset = records.length;
		tickAt(stallTick, secondEventAt + 180_001);
		await waitFor(
			() => wire.messages.slice(mapperlessNoticeOffset).some((message) =>
				message.type === "notice" && message.level === "warning"),
			"mapperless stall warning",
		);
		firstConversation.telemetryMapper = mapper;
		if (records.length !== mapperlessRecordOffset || stallAbortCalls !== 0) {
			throw new Error("mapperless stall changed telemetry or aborted work");
		}
		console.log(
			"PASS stall timer tracks unmapped activity, isolates failure, and emits one observation per episode",
		);
	} finally {
		client.interruptRun = originalInterruptRun;
		restoreStreaming();
	}

	const rejectedBindMapper = firstConversation.telemetryMapper;
	const originalBindExtensions = firstConversation.session.bindExtensions.bind(
		firstConversation.session,
	);
	firstConversation.session.bindExtensions = async () => {
		throw new Error("fixture extension bind failure");
	};
	let bindRejected = false;
	try {
		await client.bindSession(firstConversation);
	} catch {
		bindRejected = true;
	}
	firstConversation.session.bindExtensions = originalBindExtensions;
	if (
		!bindRejected ||
		firstConversation.telemetryMapper !== undefined ||
		rejectedBindMapper.map({ type: "agent_start" }).length !== 0
	) {
		throw new Error("rejected extension bind retained stale telemetry mapper");
	}
	await client.bindSession(firstConversation);
	const reboundOffset = records.length;
	firstConversation.session._emit({ type: "agent_start" });
	firstConversation.session._emit({
		type: "agent_end",
		messages: [contextFinished],
		willRetry: false,
	});
	const reboundContext = await waitFor(
		() => records.slice(reboundOffset).find((record) => record.kind === "context.changed"),
		"context telemetry after mapper replacement",
	);
	if (
		reboundContext.attributes?.system_prompt_hash !== normalContextRecord.attributes?.system_prompt_hash ||
		reboundContext.attributes?.tool_schema_hash !== normalContextRecord.attributes?.tool_schema_hash ||
		reboundContext.correlation?.session_id !== firstConversation.session.sessionId ||
		reboundContext.correlation?.trace_id === normalContextRecord.correlation?.trace_id
	) {
		throw new Error("mapper replacement suppressed context or reused run correlation");
	}
	console.log("PASS rejected extension bind disposes stale mapper");

	const telemetryConfig = client.telemetry;
	const telemetrySource = telemetryConfig.source;
	const beforeConstructionFailure = appModule.telemetryClient.health();
	Object.defineProperty(telemetryConfig, "source", {
		configurable: true,
		get() {
			throw new Error("fixture mapper construction failure");
		},
	});
	await client.bindSession(firstConversation);
	Object.defineProperty(telemetryConfig, "source", {
		configurable: true,
		writable: true,
		value: telemetrySource,
	});
	const afterConstructionFailure = appModule.telemetryClient.health();
	if (
		firstConversation.telemetryMapper !== undefined ||
		afterConstructionFailure.errors !== beforeConstructionFailure.errors + 1 ||
		afterConstructionFailure.gaps !== beforeConstructionFailure.gaps
	) {
		throw new Error("mapper construction failure was not accounted");
	}
	await client.bindSession(firstConversation);
	const disposalFailureMapper = firstConversation.telemetryMapper;
	const originalDisposeMapper = disposalFailureMapper.dispose.bind(disposalFailureMapper);
	const beforeDisposalFailure = appModule.telemetryClient.health();
	disposalFailureMapper.dispose = () => {
		throw new Error("fixture mapper disposal failure");
	};
	await client.bindSession(firstConversation);
	disposalFailureMapper.dispose = originalDisposeMapper;
	const afterDisposalFailure = appModule.telemetryClient.health();
	if (
		afterDisposalFailure.errors !== beforeDisposalFailure.errors + 1 ||
		afterDisposalFailure.gaps !== beforeDisposalFailure.gaps
	) {
		throw new Error("mapper disposal failure was not accounted");
	}
	console.log("PASS mapper construction and disposal failures update health");

	const mapper = firstConversation.telemetryMapper;
	const originalMap = mapper.map.bind(mapper);
	const beforeMappingFailure = appModule.telemetryClient.health();
	mapper.map = () => {
		throw new Error("fixture mapper failure");
	};
	client.session._emit({
		type: "tool_execution_end",
		toolCallId: "mapper-failure-tool",
		toolName: "fixture_tool",
		result: { content: [], details: {} },
		isError: false,
	});
	await wire.next("tool_status", (message) => message.toolCallId === "mapper-failure-tool");
	const afterMappingFailure = appModule.telemetryClient.health();
	if (
		afterMappingFailure.errors !== beforeMappingFailure.errors + 1 ||
		afterMappingFailure.gaps !== beforeMappingFailure.gaps + 1
	) {
		throw new Error("mapping failure was not accounted");
	}
	mapper.map = originalMap;
	const originalEmit = appModule.telemetryClient.emit.bind(appModule.telemetryClient);
	const beforeEnqueueFailure = appModule.telemetryClient.health();
	appModule.telemetryClient.emit = () => {
		throw new Error("fixture enqueue failure");
	};
	client.session._emit({
		type: "tool_execution_end",
		toolCallId: "enqueue-failure-tool",
		toolName: "fixture_tool",
		result: { content: [], details: {} },
		isError: false,
	});
	await wire.next("tool_status", (message) => message.toolCallId === "enqueue-failure-tool");
	const afterEnqueueFailure = appModule.telemetryClient.health();
	if (
		afterEnqueueFailure.errors !== beforeEnqueueFailure.errors + 1 ||
		afterEnqueueFailure.gaps !== beforeEnqueueFailure.gaps + 1
	) {
		throw new Error("enqueue failure was not accounted");
	}
	appModule.telemetryClient.emit = originalEmit;
	const originalRecordFailure = appModule.telemetryClient.recordFailure.bind(
		appModule.telemetryClient,
	);
	appModule.telemetryClient.recordFailure = () => {
		throw new Error("fixture health callback failure");
	};
	mapper.map = () => {
		throw new Error("fixture mapper failure with broken health callback");
	};
	client.session._emit({
		type: "tool_execution_end",
		toolCallId: "health-callback-failure-tool",
		toolName: "fixture_tool",
		result: { content: [], details: {} },
		isError: false,
	});
	await wire.next(
		"tool_status",
		(message) => message.toolCallId === "health-callback-failure-tool",
	);
	mapper.map = originalMap;
	appModule.telemetryClient.recordFailure = originalRecordFailure;
	acknowledgementMode = "malformed-once";
	const malformedConnections = connectionCount;
	emitFixture(client.session, "malformed-ack-tool");
	await wire.next("tool_status", (message) => message.toolCallId === "malformed-ack-tool");
	await waitFor(
		() => connectionCount > malformedConnections &&
			appModule.telemetryClient.health().errors > 0 &&
			records.some((record) => recordHasTool(record, "malformed-ack-tool")),
		"malformed ACK recovery",
	);
	console.log("PASS mapper, enqueue, health callback, and malformed-ACK failures preserve UI");

	firstConversation.listed = true;
	firstConversation.promptedSinceActive = true;
	const firstConversationId = firstConversation.telemetryConversationId;
	await client.setCwd(projectB);
	const secondConversation = client.convs.get(client.activeId);
	if (!secondConversation || secondConversation === firstConversation) {
		throw new Error("project switch did not create second conversation");
	}
	const crossOffset = records.length;
	emitFixture(firstConversation.session, "cross-conversation-tool");
	emitFixture(secondConversation.session, "cross-conversation-tool");
	await waitFor(
		() => records.slice(crossOffset).filter((record) =>
			record.kind === "tool.execution" &&
			record.phase === "end" &&
			recordHasTool(record, "cross-conversation-tool")).length >= 2,
		"two-conversation telemetry",
	);
	const crossRecords = records.slice(crossOffset).filter((record) =>
		record.kind === "tool.execution" &&
		record.phase === "end" &&
		recordHasTool(record, "cross-conversation-tool"));
	const firstRecord = crossRecords.find((record) =>
		record.correlation?.conversation_id === firstConversationId);
	const secondRecord = crossRecords.find((record) =>
		record.correlation?.conversation_id === secondConversation.telemetryConversationId);
	const secondContextBeforeEdit = records.slice(crossOffset).find((record) =>
		record.kind === "context.changed" &&
		record.correlation?.conversation_id === secondConversation.telemetryConversationId);
	if (
		!firstRecord ||
		!secondRecord ||
		!secondContextBeforeEdit ||
		firstRecord.attributes?.project_cwd !== fixture.projectDir ||
		secondRecord.attributes?.project_cwd !== projectB ||
		firstRecord.correlation.session_id === secondRecord.correlation.session_id
	) {
		throw new Error("conversation metadata crossed during project switch");
	}
	const activeBeforeReset = client.activeId;
	const forcedResetReason = "PRIVATE_FORCED_RESET_REASON";
	const resetOffset = records.length;
	firstConversation.session._emit({ type: "agent_start" });
	firstConversation.session._emit({ type: "turn_start" });
	for (const [toolCallId, toolName] of [["reset-tool-1", "read"], ["reset-tool-2", "bash"]]) {
		firstConversation.session._emit({
			type: "tool_execution_start",
			toolCallId,
			toolName,
			args: { path: "README.md" },
		});
	}
	await waitFor(
		() => records.slice(resetOffset).filter((record) => record.phase === "start").length === 4,
		"open force-reset telemetry spans",
	);
	await client.forceResetConversation(firstConversation, forcedResetReason);
	await waitFor(
		() => records.slice(resetOffset).some((record) =>
			record.kind === "agent.run" &&
			record.phase === "end" &&
			record.attributes?.cause_class === "forced_reset"),
		"forced-reset terminal telemetry",
	);
	if (client.activeId !== activeBeforeReset || firstConversation.session !== firstConversation.runtime.session) {
		throw new Error("background force reset changed active conversation or target session");
	}
	const forcedResetRecords = records.slice(resetOffset);
	const forcedResetTerminals = forcedResetRecords.filter((record) =>
		record.phase === "end" && record.attributes?.cause_class === "forced_reset");
	if (
		JSON.stringify(forcedResetTerminals.map((record) => `${record.kind}:${record.state}`)) !==
			JSON.stringify([
				"tool.execution:cancelled",
				"tool.execution:cancelled",
				"agent.turn:cancelled",
				"agent.run:aborted",
			]) ||
		JSON.stringify(forcedResetRecords).includes(forcedResetReason)
	) {
		throw new Error("forced reset did not emit ordered content-free terminals");
	}
	const openSpans = new Set();
	for (const record of forcedResetRecords) {
		const key = lifecycleSpanKey(record);
		if (!key) continue;
		if (record.phase === "start") openSpans.add(key);
		else if (record.phase === "end") openSpans.delete(key);
	}
	if (openSpans.size !== 0) {
		throw new Error(`forced reset left normalized spans open: ${JSON.stringify([...openSpans])}`);
	}
	emitFixture(firstConversation.session, "background-reset-tool");
	await waitFor(
		() => records.slice(resetOffset).some((record) =>
			record.kind === "tool.execution" &&
			record.phase === "end" &&
			recordHasTool(record, "background-reset-tool") &&
			record.correlation?.conversation_id === firstConversationId),
		"background force-reset telemetry",
	);
	console.log("PASS force reset closes open spans before background runtime replacement");

	const editConversation = secondConversation;
	const editTimestamp = 4_000;
	const editMessage = {
		role: "user",
		content: [{ type: "text", text: "edit fixture original" }],
		timestamp: editTimestamp,
	};
	editConversation.session.sessionManager.appendMessage(editMessage);
	editConversation.session.agent.state.messages.push(editMessage);
	const editAnswer = assistantMessage(
		[{ type: "text", text: "edit fixture answer" }],
		"stop",
		editTimestamp + 1,
	);
	editConversation.session.sessionManager.appendMessage(editAnswer);
	editConversation.session.agent.state.messages.push(editAnswer);
	const oldEditSessionId = editConversation.session.sessionId;
	const oldEditMapper = editConversation.telemetryMapper;
	const oldTraceId = secondRecord.correlation.trace_id;
	const originalPrompt = client.prompt;
	client.prompt = async () => {};
	try {
		await client.editMessage(`u-${editTimestamp}-1`, "edit fixture replacement");
	} finally {
		client.prompt = originalPrompt;
	}
	if (
		editConversation.session.sessionId === oldEditSessionId ||
		editConversation.telemetryMapper === oldEditMapper ||
		oldEditMapper.map({ type: "agent_start" }).length !== 0
	) {
		throw new Error("edit fork did not replace and dispose mapper");
	}
	const editOffset = records.length;
	emitFixture(editConversation.session, "cross-conversation-tool");
	const postEditRecord = await waitFor(
		() => records.slice(editOffset).find((record) =>
			record.kind === "tool.execution" &&
			record.phase === "end" &&
			recordHasTool(record, "cross-conversation-tool")),
		"post-edit telemetry",
	);
	const postEditContext = records
		.slice(editOffset)
		.find((record) => record.kind === "context.changed");
	if (
		!postEditContext ||
		postEditContext.attributes?.system_prompt_hash !==
			secondContextBeforeEdit.attributes?.system_prompt_hash ||
		postEditContext.attributes?.tool_schema_hash !==
			secondContextBeforeEdit.attributes?.tool_schema_hash ||
		postEditContext.correlation?.session_id !== editConversation.session.sessionId ||
		postEditContext.correlation?.trace_id === secondContextBeforeEdit.correlation?.trace_id ||
		postEditRecord.correlation.conversation_id !==
			editConversation.telemetryConversationId ||
		postEditRecord.correlation.session_id !== editConversation.session.sessionId ||
		!postEditRecord.correlation.trace_id?.includes(editConversation.session.sessionId) ||
		postEditRecord.correlation.trace_id === oldTraceId ||
		postEditRecord.correlation.tool_call_id === secondRecord.correlation.tool_call_id
	) {
		throw new Error("edit fork reused concrete-session correlation namespace");
	}
	console.log("PASS mapper and concrete-session replacement re-emit hashed context");

	await waitFor(
		() => appModule.telemetryClient.health().queued === 0,
		"telemetry queue drain before connector isolation",
	);
	for (const socket of [...telemetrySockets]) socket.destroy();
	await new Promise((resolve) => telemetryServer.close(resolve));
	await waitFor(
		() => appModule.telemetryClient.health().state === "disconnected",
		"telemetry disconnect before connector isolation",
	);
	let unavailableConnectAttempts = 0;
	appModule.telemetryClient.connectSocket = () => {
		unavailableConnectAttempts++;
		throw new Error("fixture unavailable telemetry socket");
	};
	const removedSession = firstConversation.session;
	const removedMapper = firstConversation.telemetryMapper;
	const beforeRemovedEvent = appModule.telemetryClient.health();
	client.removeConversation(firstConversation.id);
	const removedOffset = records.length;
	emitFixture(removedSession, "removed-conversation-tool");
	await Promise.resolve();
	const afterRemovedEvent = appModule.telemetryClient.health();
	if (
		records.length !== removedOffset ||
		removedMapper.map({ type: "agent_start" }).length !== 0 ||
		afterRemovedEvent.queued !== 0 ||
		afterRemovedEvent.errors !== beforeRemovedEvent.errors ||
		unavailableConnectAttempts !== 0 ||
		appModule.telemetryClient.reconnectTimer !== null
	) {
		throw new Error("removed conversation scheduled telemetry or reconnect work");
	}
	console.log("PASS mapper disposal prevents later records and reconnect scheduling");

	const shutdownMapper = editConversation.telemetryMapper;
	const saturationMessageOffset = wire.messages.length;
	const gapsBeforeSaturation = appModule.telemetryClient.health().gaps;
	for (let index = 0; index < 1_001; index++) {
		client.session._emit({
			type: "tool_execution_end",
			toolCallId: `saturation-tool-${index}`,
			toolName: "fixture_tool",
			result: { content: [], details: {} },
			isError: false,
		});
	}
	await waitFor(
		() => wire.messages.slice(saturationMessageOffset).filter((message) =>
			message.type === "tool_status" &&
			message.toolCallId?.startsWith("saturation-tool-")).length === 1_001,
		"all saturated telemetry UI projections",
	);
	const saturatedHealth = appModule.telemetryClient.health();
	if (
		saturatedHealth.queued !== 1_000 ||
		saturatedHealth.gaps !== gapsBeforeSaturation + 1 ||
		unavailableConnectAttempts < 1
	) {
		throw new Error(
			`integrated queue bound mismatch: ${JSON.stringify(saturatedHealth)}`,
		);
	}
	console.log("PASS integrated unavailable queue caps at 1000 while all UI events project");
	ws.close();
	await new Promise((resolve) => ws.once("close", resolve));
	await appModule.closeServer();
	if (
		appModule.telemetryClient.health().state !== "disposed" ||
		editConversation.telemetryMapper !== undefined ||
		shutdownMapper.map({ type: "agent_start" }).length !== 0
	) {
		throw new Error("server shutdown did not dispose conversation and shared telemetry");
	}
	console.log("PASS shutdown disposes saturated shared telemetry client");
	console.log("PASS normal telemetry content fixture");
} catch (error) {
	exitCode = 1;
	console.error(`FAIL ${error.stack ?? error}`);
} finally {
	ws?.terminate();
	if (appModule?.closeServer) await appModule.closeServer();
	for (const socket of telemetrySockets) socket.destroy();
	if (telemetryServer.listening) {
		await new Promise((resolve) => telemetryServer.close(resolve));
	}
	rmSync(fixture.base, { recursive: true, force: true });
}

process.exit(exitCode);
