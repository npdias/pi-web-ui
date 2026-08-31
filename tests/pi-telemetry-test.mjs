import { randomUUID } from "node:crypto";
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

function assistantMessage(content, stopReason, timestamp) {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
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

function emitFixture(session, toolCallId) {
	const thinking = assistantMessage(
		[{ type: "thinking", thinking: "fixture thought" }],
		"pending",
		1_000,
	);
	const finished = assistantMessage(
		[{ type: "text", text: "fixture answer" }],
		"stop",
		1_001,
	);
	const toolResult = {
		role: "toolResult",
		toolCallId,
		toolName: "fixture_tool",
		content: [{ type: "text", text: "PRIVATE_TOOL_RESULT" }],
		isError: false,
		timestamp: 1_002,
	};
	session._emit({ type: "agent_start" });
	session._emit({ type: "turn_start" });
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
	session._emit({
		type: "tool_execution_start",
		toolCallId,
		toolName: "fixture_tool",
		args: { secret: "PRIVATE_TOOL_ARGUMENT" },
	});
	session._emit({
		type: "tool_execution_end",
		toolCallId,
		toolName: "fixture_tool",
		result: { content: toolResult.content, details: {} },
		isError: false,
	});
	session._emit({ type: "turn_end", message: finished, toolResults: [toolResult] });
	session._emit({ type: "agent_end", messages: [finished], willRetry: false });
}

function recordHasTool(record, sourceToolCallId) {
	const id = record.correlation?.tool_call_id;
	return id === sourceToolCallId || id?.endsWith(`:tool:${sourceToolCallId}`);
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

if (process.argv.includes("--no-env-child")) {
	process.exit(await runNoEnvChild());
}

const fixture = fixtureDirs("pi-web-telemetry-");
const projectB = join(fixture.base, "project-b");
const socketPath = join(fixture.base, "telemetry.sock");
mkdirSync(projectB, { recursive: true });

const records = [];
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

	const normalOffset = records.length;
	emitFixture(client.session, "normal-tool");
	await wire.next("tool_status", (message) => message.toolCallId === "normal-tool");
	await waitFor(
		() => records.slice(normalOffset).filter((record) => record.kind !== "context.changed").length >= 7,
		"ordered telemetry records",
	);
	const normalRecords = records
		.slice(normalOffset)
		.filter((record) => record.kind !== "context.changed")
		.slice(0, 7);
	const order = normalRecords.map((record) => `${record.kind}:${record.phase}`);
	const expectedOrder = [
		"agent.run:start",
		"agent.turn:start",
		"provider.thinking:end",
		"tool.execution:start",
		"tool.execution:end",
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
	const serializedNormal = JSON.stringify(normalRecords);
	if (
		serializedNormal.includes("PRIVATE_TOOL_ARGUMENT") ||
		serializedNormal.includes("PRIVATE_TOOL_RESULT")
	) {
		throw new Error("telemetry exposed tool payload content");
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
	console.log("PASS rejected extension bind disposes stale mapper");

	const mapper = firstConversation.telemetryMapper;
	const originalMap = mapper.map.bind(mapper);
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
	mapper.map = originalMap;
	const originalEmit = appModule.telemetryClient.emit.bind(appModule.telemetryClient);
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
	appModule.telemetryClient.emit = originalEmit;
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
	console.log("PASS mapper, enqueue, and malformed-ACK failures preserve UI projection");

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
	if (
		!firstRecord ||
		!secondRecord ||
		firstRecord.attributes?.project_cwd !== fixture.projectDir ||
		secondRecord.attributes?.project_cwd !== projectB ||
		firstRecord.correlation.session_id === secondRecord.correlation.session_id
	) {
		throw new Error("conversation metadata crossed during project switch");
	}
	const activeBeforeReset = client.activeId;
	const resetOffset = records.length;
	await client.forceResetConversation(firstConversation, "fixture reset");
	if (client.activeId !== activeBeforeReset || firstConversation.session !== firstConversation.runtime.session) {
		throw new Error("background force reset changed active conversation or target session");
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
	console.log("PASS background conversation and force reset retain target mapper metadata");

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
	if (
		postEditRecord.correlation.conversation_id !==
			editConversation.telemetryConversationId ||
		postEditRecord.correlation.session_id !== editConversation.session.sessionId ||
		!postEditRecord.correlation.trace_id?.includes(editConversation.session.sessionId) ||
		postEditRecord.correlation.trace_id === oldTraceId ||
		postEditRecord.correlation.tool_call_id === secondRecord.correlation.tool_call_id
	) {
		throw new Error("edit fork reused concrete-session correlation namespace");
	}
	console.log("PASS edit fork creates fresh concrete-session namespace");

	const removedSession = firstConversation.session;
	const removedMapper = firstConversation.telemetryMapper;
	client.removeConversation(firstConversation.id);
	const removedOffset = records.length;
	emitFixture(removedSession, "removed-conversation-tool");
	await sleep(100);
	if (
		records.length !== removedOffset ||
		removedMapper.map({ type: "agent_start" }).length !== 0
	) {
		throw new Error("removed conversation mapper still emitted telemetry");
	}
	console.log("PASS conversation removal disposes mapper and subscription");

	const shutdownMapper = editConversation.telemetryMapper;
	for (const socket of [...telemetrySockets]) socket.destroy();
	await new Promise((resolve) => telemetryServer.close(resolve));
	client.session._emit({
		type: "tool_execution_end",
		toolCallId: "unavailable-socket-tool",
		toolName: "fixture_tool",
		result: { content: [], details: {} },
		isError: false,
	});
	await wire.next("tool_status", (message) => message.toolCallId === "unavailable-socket-tool");
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
	console.log("PASS unavailable socket is isolated and shutdown disposes telemetry");
	console.log("PASS normal zero-token telemetry fixture");
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
