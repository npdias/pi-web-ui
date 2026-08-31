import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer as createUnixServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORT = 8976;
const base = mkdtempSync(join(tmpdir(), "pi-web-telemetry-"));
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
const projectDir = join(base, "project-a");
const socketPath = join(base, "telemetry.sock");
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });

const records = [];
const sockets = new Set();
let connectionCount = 0;
let acknowledgementMode = "valid";
const telemetryServer = createUnixServer((socket) => {
	connectionCount++;
	sockets.add(socket);
	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk) => {
		buffered += chunk;
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			if (!line) continue;
			const record = JSON.parse(line);
			records.push(record);
			if (acknowledgementMode === "none") continue;
			if (acknowledgementMode === "malformed-once") {
				acknowledgementMode = "valid";
				socket.write("{\"accepted\":true}\n");
				continue;
			}
			socket.write(`${JSON.stringify({
				accepted: true,
				event_id: `fixture-${records.length}`,
				sequence: records.length,
				error: null,
			})}\n`);
		}
	});
	socket.on("close", () => sockets.delete(socket));
});

function waitFor(predicate, description, timeoutMs = 15_000) {
	const started = Date.now();
	return (async () => {
		while (Date.now() - started < timeoutMs) {
			const value = await predicate();
			if (value) return value;
			await sleep(25);
		}
		throw new Error(`timeout waiting for ${description}`);
	})();
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

function normalFixture(session) {
	const started = assistantMessage(
		[{ type: "thinking", thinking: "provider fixture thought" }],
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
		toolCallId: "fixture-tool-1",
		toolName: "bash",
		content: [{ type: "text", text: "SUPER_SECRET_RESULT" }],
		isError: false,
		timestamp: 1_002,
	};
	session._emit({ type: "agent_start" });
	session._emit({ type: "turn_start" });
	session._emit({
		type: "message_update",
		message: started,
		assistantMessageEvent: {
			type: "thinking_end",
			contentIndex: 0,
			content: "provider fixture thought",
			partial: started,
		},
	});
	session._emit({
		type: "tool_execution_start",
		toolCallId: "fixture-tool-1",
		toolName: "bash",
		args: { command: "SUPER_SECRET_ARG" },
	});
	session._emit({
		type: "tool_execution_end",
		toolCallId: "fixture-tool-1",
		toolName: "bash",
		result: { content: toolResult.content, details: {} },
		isError: false,
	});
	session._emit({ type: "turn_end", message: finished, toolResults: [toolResult] });
	session._emit({ type: "agent_end", messages: [finished], willRetry: false });
}

function emitRunStart(session) {
	session._emit({ type: "agent_start" });
	session._emit({ type: "turn_start" });
}

function emitTool(session, toolCallId, toolName = "fixture_tool") {
	session._emit({
		type: "tool_execution_start",
		toolCallId,
		toolName,
		args: { secret: "DO_NOT_EXPORT" },
	});
	session._emit({
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: { content: [{ type: "text", text: "DO_NOT_EXPORT_RESULT" }] },
		isError: false,
	});
}

class WireClient {
	constructor(ws) {
		this.ws = ws;
		this.messages = [];
		this.state = null;
		this.renderedMessages = [];
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.messages.push(message);
			if (message.type === "snapshot") {
				this.state = message.state;
				this.renderedMessages = message.state.messages ?? [];
			} else if (
				message.type === "snapshot_delta" &&
				this.state?.rev === message.baseRev &&
				this.state?.conversationId === message.conversationId
			) {
				this.state = { ...this.state, ...message.state };
				this.renderedMessages = [...this.renderedMessages, ...message.appended];
			}
		});
	}

	send(message) {
		this.ws.send(JSON.stringify(message));
	}

	waitFor(type, predicate = () => true) {
		return waitFor(
			() => this.messages.find((message) => message.type === type && predicate(message)),
			type,
		);
	}
}

async function runNoEnvChild() {
	let childModule;
	let childWs;
	let childExitCode = 0;
	try {
		await new Promise((resolve, reject) => {
			telemetryServer.once("error", reject);
			telemetryServer.listen(socketPath, resolve);
		});
		process.env.PI_WEB_PORT = String(PORT);
		process.env.PI_WEB_DATA_DIR = dataDir;
		process.env.PI_WEB_CWD = projectDir;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.UA_TELEMETRY_SOCKET;
		delete process.env.UA_ROBOT_ID;
		delete process.env.UA_AGENT_INSTANCE_ID;

		childModule = await import(
			`${pathToFileURL(join(REPO_ROOT, "dist/server/index.js")).href}?no-env=${randomUUID()}`
		);
		if (!childModule.service || !childModule.closeServer) {
			throw new Error("server lifecycle exports missing in no-env fixture");
		}
		if (childModule.telemetryClient !== undefined) {
			throw new Error("telemetry client was built without UA_TELEMETRY_SOCKET");
		}
		await waitFor(async () => {
			try {
				return (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok;
			} catch {
				return false;
			}
		}, "no-env server health");
		childWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			childWs.once("open", resolve);
			childWs.once("error", reject);
		});
		const client = new WireClient(childWs);
		const clientId = "pi-telemetry-no-env";
		client.send({ type: "hello", clientId });
		await client.waitFor("ready");
		await client.waitFor("snapshot");
		const session = childModule.service.get(clientId)?.session;
		if (!session) throw new Error("no-env session missing");
		normalFixture(session);
		await client.waitFor(
			"tool_status",
			(message) => message.toolCallId === "fixture-tool-1",
		);
		await sleep(300);
		if (connectionCount !== 0 || records.length !== 0) {
			throw new Error("no-env fixture attempted telemetry socket IO");
		}
		console.log("PASS no env keeps session projection and makes no socket attempt");
	} catch (error) {
		childExitCode = 1;
		console.error(`FAIL no-env ${error.stack ?? error}`);
	} finally {
		childWs?.terminate();
		if (childModule?.closeServer) await childModule.closeServer();
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => telemetryServer.close(resolve));
		rmSync(base, { recursive: true, force: true });
	}
	return childExitCode;
}

if (process.argv.includes("--no-env-child")) {
	process.exit(await runNoEnvChild());
}

let appModule;
let ws;
let exitCode = 0;
try {
	const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
	const build = spawnSync(npmCommand, ["run", "build:server"], {
		cwd: REPO_ROOT,
		env: { ...process.env },
		encoding: "utf8",
		timeout: 30_000,
	});
	if (build.status !== 0) {
		throw new Error(
			`fixture server build failed with status ${build.status}\n${build.stdout ?? ""}${build.stderr ?? ""}`,
		);
	}
	const noEnv = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--no-env-child"], {
		cwd: REPO_ROOT,
		env: { ...process.env },
		encoding: "utf8",
		timeout: 30_000,
	});
	if (noEnv.stdout) process.stdout.write(noEnv.stdout);
	if (noEnv.stderr) process.stderr.write(noEnv.stderr);
	if (noEnv.status !== 0) {
		throw new Error(`no-env child failed with status ${noEnv.status}`);
	}
	await new Promise((resolve, reject) => {
		telemetryServer.once("error", reject);
		telemetryServer.listen(socketPath, resolve);
	});
	process.env.PI_WEB_PORT = String(PORT);
	process.env.PI_WEB_DATA_DIR = dataDir;
	process.env.PI_WEB_CWD = projectDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.UA_TELEMETRY_SOCKET = socketPath;
	delete process.env.UA_ROBOT_ID;
	process.env.UA_AGENT_INSTANCE_ID = "fixture-agent-instance";

	appModule = await import(
		`${pathToFileURL(join(REPO_ROOT, "dist/server/index.js")).href}?fixture=${randomUUID()}`
	);
	if (!appModule.service || !appModule.closeServer) {
		throw new Error("server telemetry integration/test lifecycle exports are missing");
	}

	await waitFor(
		async () => {
			try {
				return (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok;
			} catch {
				return false;
			}
		},
		"server health",
	);

	ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const client = new WireClient(ws);
	const clientId = "pi-telemetry-fixture";
	client.send({ type: "hello", clientId });
	await client.waitFor("ready");
	const initial = await client.waitFor("snapshot");
	const session = appModule.service.get(clientId)?.session;
	if (!session) throw new Error("fixture session missing");

	normalFixture(session);

	await waitFor(
		() => records.filter((record) => record.kind !== "context.changed").length >= 7,
		"ordered telemetry records",
	);
	const ordered = records
		.filter((record) => record.kind !== "context.changed")
		.map((record) => `${record.kind}:${record.phase}`);
	const expected = [
		"agent.run:start",
		"agent.turn:start",
		"provider.thinking:end",
		"tool.execution:start",
		"tool.execution:end",
		"agent.turn:end",
		"agent.run:end",
	];
	if (JSON.stringify(ordered) !== JSON.stringify(expected)) {
		throw new Error(`telemetry order mismatch: ${JSON.stringify(ordered)}`);
	}

	const run = records.find((record) => record.kind === "agent.run" && record.phase === "start");
	if (
		run?.source?.host_id !== hostname() ||
		run?.source?.robot_id !== hostname() ||
		run?.source?.instance_id !== "fixture-agent-instance" ||
		typeof run?.correlation?.conversation_id !== "string" ||
		typeof run?.correlation?.session_id !== "string" ||
		run?.attributes?.project_cwd !== projectDir ||
		run?.attributes?.project_name !== "project-a"
	) {
		throw new Error(`conversation metadata mismatch: ${JSON.stringify(run)}`);
	}
	const wireRecords = JSON.stringify(records);
	if (wireRecords.includes("SUPER_SECRET_ARG") || wireRecords.includes("SUPER_SECRET_RESULT")) {
		throw new Error("tool arguments/results leaked into telemetry");
	}

	await client.waitFor(
		"tool_status",
		(message) => message.toolCallId === "fixture-tool-1" && message.isError === false,
	);
	client.send({ type: "get_state" });
	const snapshotsBefore = client.messages.filter((message) => message.type === "snapshot").length;
	const final = await waitFor(
		() => {
			const snapshots = client.messages.filter((message) => message.type === "snapshot");
			return snapshots.length > snapshotsBefore ? snapshots.at(-1) : undefined;
		},
		"post-fixture snapshot",
	);
	if (
		final.state.conversationId !== initial.state.conversationId ||
		JSON.stringify(final.state.messages) !== JSON.stringify(initial.state.messages)
	) {
		throw new Error("fixture changed existing WebSocket snapshot state");
	}

	const projectB = join(base, "project-b");
	mkdirSync(projectB, { recursive: true });
	const clientSession = appModule.service.get(clientId);
	if (!clientSession) throw new Error("client session disappeared");
	const backgroundSession = clientSession.session;
	const backgroundUiConversationId = client.state.conversationId;
	const backgroundRecordOffset = records.length;
	emitRunStart(backgroundSession);
	backgroundSession._isAgentRunActive = true;
	client.send({ type: "set_cwd", path: projectB });
	await waitFor(
		() => client.state?.cwd === projectB && client.state?.conversationId !== backgroundUiConversationId,
		"project switch snapshot",
	);
	let foregroundSession = clientSession.session;
	emitRunStart(foregroundSession);
	emitTool(backgroundSession, "background-tool");
	emitTool(foregroundSession, "foreground-tool");
	const backgroundTool = await waitFor(
		() => records.find((record, index) =>
			index >= backgroundRecordOffset &&
			record.kind === "tool.execution" &&
			record.phase === "end" &&
			record.correlation?.tool_call_id === "background-tool"),
		"background telemetry",
	);
	const foregroundTool = await waitFor(
		() => records.find((record) =>
			record.kind === "tool.execution" &&
			record.phase === "end" &&
			record.correlation?.tool_call_id === "foreground-tool"),
		"foreground telemetry",
	);
	if (
		backgroundTool.correlation.conversation_id === foregroundTool.correlation.conversation_id ||
		backgroundTool.correlation.session_id === foregroundTool.correlation.session_id ||
		backgroundTool.correlation.trace_id === foregroundTool.correlation.trace_id
	) {
		throw new Error("conversation run/correlation IDs were shared");
	}
	if (
		backgroundTool.attributes.project_cwd !== projectDir ||
		backgroundTool.attributes.ui_conversation_id !== backgroundUiConversationId ||
		foregroundTool.attributes.project_cwd !== projectB ||
		foregroundTool.attributes.ui_conversation_id !== client.state.conversationId
	) {
		throw new Error("project switch crossed conversation metadata");
	}
	console.log("PASS project switch keeps background mapper ownership");

	backgroundSession._isAgentRunActive = false;
	clientSession.removeConversation(backgroundUiConversationId);
	const recordsBeforeDisposedEvent = records.length;
	const connectionsBeforeDisposedEvent = connectionCount;
	emitTool(backgroundSession, "disposed-tool");
	await sleep(350);
	if (
		records.length !== recordsBeforeDisposedEvent ||
		connectionCount !== connectionsBeforeDisposedEvent
	) {
		throw new Error("disposed conversation emitted or reconnected telemetry");
	}
	console.log("PASS disposed conversation ignores later fixture events");

	const foregroundUiConversationId = client.state.conversationId;
	let foregroundConversation = clientSession.convs.get(foregroundUiConversationId);
	if (!foregroundConversation?.telemetryMapper) {
		throw new Error("foreground telemetry mapper missing");
	}
	const telemetryClient = appModule.telemetryClient;
	if (!telemetryClient) throw new Error("server-scoped telemetry client missing");
	const preResetConversationId = foregroundTool.correlation.conversation_id;
	await clientSession.forceResetConversation(foregroundConversation, "fixture force reset");
	foregroundSession = clientSession.session;
	foregroundConversation = clientSession.convs.get(foregroundUiConversationId);
	if (!foregroundConversation?.telemetryMapper) {
		throw new Error("replacement runtime telemetry mapper missing");
	}
	emitRunStart(foregroundSession);
	emitTool(foregroundSession, "reset-runtime-tool");
	const resetRuntimeTool = await waitFor(
		() => records.find((record) =>
			record.kind === "tool.execution" &&
			record.phase === "end" &&
			record.correlation?.tool_call_id === "reset-runtime-tool"),
		"replacement runtime telemetry",
	);
	if (resetRuntimeTool.correlation.conversation_id === preResetConversationId) {
		throw new Error("replacement runtime reused prior mapper correlation state");
	}
	console.log("PASS force-reset runtime receives a fresh mapper");
	const originalGetAllTools = foregroundSession.getAllTools;
	let streamingContextReads = 0;
	foregroundSession.getAllTools = function () {
		streamingContextReads++;
		return originalGetAllTools.call(this);
	};
	const streamingMessage = assistantMessage(
		[{ type: "text", text: "fixture delta" }],
		"pending",
		2_000,
	);
	foregroundSession._emit({
		type: "message_update",
		message: streamingMessage,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "fixture delta",
			partial: streamingMessage,
		},
	});
	foregroundSession.getAllTools = originalGetAllTools;
	if (streamingContextReads !== 0) {
		throw new Error(`streaming delta rebuilt telemetry context ${streamingContextReads} time(s)`);
	}
	console.log("PASS streaming deltas skip prompt/tool context hashing");

	const originalMap = foregroundConversation.telemetryMapper.map;
	const recordsBeforeMappingError = records.length;
	const healthBeforeMappingError = telemetryClient.health();
	foregroundConversation.telemetryMapper.map = () => {
		throw new Error("fixture mapping failure");
	};
	emitTool(foregroundSession, "mapping-error-tool");
	await client.waitFor(
		"tool_status",
		(message) => message.toolCallId === "mapping-error-tool",
	);
	foregroundConversation.telemetryMapper.map = originalMap;
	if (records.length !== recordsBeforeMappingError) {
		throw new Error("mapping failure leaked partial telemetry");
	}
	const healthAfterMappingError = telemetryClient.health();
	if (
		healthAfterMappingError.errors <= healthBeforeMappingError.errors ||
		healthAfterMappingError.gaps <= healthBeforeMappingError.gaps
	) {
		throw new Error("mapping failure did not increment telemetry error/gap health");
	}
	console.log("PASS mapper failure leaves UI projection intact");

	const originalEmit = telemetryClient.emit;
	const healthBeforeEnqueueError = telemetryClient.health();
	telemetryClient.emit = () => {
		throw new Error("fixture enqueue failure");
	};
	emitTool(foregroundSession, "enqueue-error-tool");
	await client.waitFor(
		"tool_status",
		(message) => message.toolCallId === "enqueue-error-tool",
	);
	telemetryClient.emit = originalEmit;
	const healthAfterEnqueueError = telemetryClient.health();
	if (
		healthAfterEnqueueError.errors <= healthBeforeEnqueueError.errors ||
		healthAfterEnqueueError.gaps <= healthBeforeEnqueueError.gaps
	) {
		throw new Error("enqueue failure did not increment telemetry error/gap health");
	}
	console.log("PASS enqueue failure leaves UI projection intact");

	await waitFor(() => telemetryClient.health().queued === 0, "telemetry queue drain");
	acknowledgementMode = "malformed-once";
	const errorsBeforeMalformedAck = telemetryClient.health().errors;
	emitTool(foregroundSession, "malformed-ack-tool");
	await client.waitFor(
		"tool_status",
		(message) => message.toolCallId === "malformed-ack-tool",
	);
	await waitFor(
		() => telemetryClient.health().errors > errorsBeforeMalformedAck,
		"malformed ACK failure",
	);
	await waitFor(() => telemetryClient.health().queued === 0, "malformed ACK recovery");
	console.log("PASS malformed ACK reconnect leaves UI projection intact");

	for (const socket of [...sockets]) socket.destroy();
	await new Promise((resolve) => telemetryServer.close(resolve));
	rmSync(socketPath, { force: true });
	await waitFor(
		() => telemetryClient.health().state === "disconnected",
		"telemetry disconnect",
	);
	const errorsBeforeUnavailable = telemetryClient.health().errors;
	emitTool(foregroundSession, "unavailable-socket-tool");
	await client.waitFor(
		"tool_status",
		(message) => message.toolCallId === "unavailable-socket-tool",
	);
	await waitFor(
		() => telemetryClient.health().errors > errorsBeforeUnavailable,
		"unavailable socket failure",
	);
	await new Promise((resolve, reject) => {
		telemetryServer.once("error", reject);
		telemetryServer.listen(socketPath, resolve);
	});
	await waitFor(() => telemetryClient.health().queued === 0, "unavailable socket recovery");
	console.log("PASS unavailable socket leaves UI projection intact");

	acknowledgementMode = "none";
	for (const socket of [...sockets]) socket.destroy();
	await waitFor(
		() => telemetryClient.health().state === "disconnected",
		"overflow fixture disconnect",
	);
	const gapsBeforeOverflow = telemetryClient.health().gaps;
	for (let index = 0; index < 1_105; index++) {
		emitTool(foregroundSession, `overflow-tool-${index}`);
	}
	await client.waitFor(
		"tool_status",
		(message) => message.toolCallId === "overflow-tool-1104",
	);
	await waitFor(
		() => telemetryClient.health().gaps > gapsBeforeOverflow,
		"telemetry queue overflow",
	);
	const overflowHealth = telemetryClient.health();
	if (overflowHealth.queued !== 1_000) {
		throw new Error(`overflow queue was not bounded: ${JSON.stringify(overflowHealth)}`);
	}
	console.log("PASS queue overflow stays bounded and leaves UI projection intact");

	const agentServiceModule = await import(
		pathToFileURL(join(REPO_ROOT, "dist/server/agent-service.js")).href
	);
	const originalCreate = agentServiceModule.ClientSession.create;
	let releasePendingCreate;
	const pendingCreateGate = new Promise((resolve) => {
		releasePendingCreate = resolve;
	});
	agentServiceModule.ClientSession.create = async function (...args) {
		await pendingCreateGate;
		return originalCreate.apply(this, args);
	};
	const pendingAttach = appModule.service.attach("pending-shutdown-client", () => {});
	await waitFor(
		() => appModule.service.pending.has("pending-shutdown-client"),
		"pending client creation",
	);
	const firstClose = appModule.closeServer();
	const secondClose = appModule.closeServer();
	if (firstClose !== secondClose || !appModule.service.isQuiesced()) {
		releasePendingCreate();
		throw new Error("server shutdown did not memoize cleanup and close admission");
	}
	let closeSettled = false;
	void firstClose.finally(() => {
		closeSettled = true;
	});
	await sleep(100);
	const closedBeforePendingCreate = closeSettled;
	releasePendingCreate();
	const pendingClientSession = await pendingAttach;
	await Promise.race([
		firstClose,
		sleep(1_000).then(() => {
			throw new Error("server shutdown hung with an attached WebSocket");
		}),
	]);
	agentServiceModule.ClientSession.create = originalCreate;
	if (closedBeforePendingCreate || pendingClientSession.disposed !== true) {
		throw new Error("shutdown did not await and dispose pending client creation");
	}
	if (telemetryClient.health().state !== "disposed") {
		throw new Error("shared telemetry client was not disposed during server shutdown");
	}
	console.log("PASS shutdown stops conversations then disposes shared telemetry client");

	console.log("PASS normal zero-token telemetry fixture");
	console.log(`PASS robot default source reference available: ${hostname().length > 0}`);
} catch (error) {
	exitCode = 1;
	console.error(`FAIL ${error.stack ?? error}`);
} finally {
	ws?.close();
	if (appModule?.closeServer) await appModule.closeServer();
	for (const socket of sockets) socket.destroy();
	await new Promise((resolve) => telemetryServer.close(resolve));
	rmSync(base, { recursive: true, force: true });
}

process.exit(exitCode);
