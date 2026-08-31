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
	const clientSession = appModule.service.get(clientId);
	if (!clientSession) throw new Error("client session disappeared");
	const preEditSession = clientSession.session;
	const preEditSessionId = preEditSession.sessionId;
	const preEditSessionFile = preEditSession.sessionFile;
	const preEditTelemetryConversationId = run.correlation.conversation_id;
	const editTimestamp = 2_500;
	const editableMessage = {
		role: "user",
		content: [{ type: "text", text: "original fixture question" }],
		timestamp: editTimestamp,
	};
	const editableEntryId = preEditSession.sessionManager.appendMessage(editableMessage);
	preEditSession.agent.state.messages.push(editableMessage);
	const editableAnswer = assistantMessage(
		[{ type: "text", text: "original fixture answer" }],
		"stop",
		editTimestamp + 1,
	);
	preEditSession.sessionManager.appendMessage(editableAnswer);
	preEditSession.agent.state.messages.push(editableAnswer);
	const resolvedEditableEntryId = clientSession.resolveUserMessageEntryId(`u-${editTimestamp}-1`);
	if (resolvedEditableEntryId !== editableEntryId) {
		throw new Error(`edit fixture entry mismatch: ${editableEntryId} vs ${resolvedEditableEntryId}`);
	}
	await clientSession.editMessage(`u-${editTimestamp}-1`, "edited fixture question");
	await sleep(50);
	const postEditSession = clientSession.session;
	if (postEditSession === preEditSession || postEditSession.sessionId === preEditSessionId) {
		throw new Error(`edit fixture did not replace Pi session identity: ${JSON.stringify({
			sameObject: postEditSession === preEditSession,
			oldSessionId: preEditSessionId,
			newSessionId: postEditSession.sessionId,
			notices: client.messages.filter((message) => message.type === "notice").slice(-3),
		})}`);
	}
	emitTool(postEditSession, "post-edit-tool");
	const postEditRecord = await waitFor(
		() => records.find((record) =>
			record.kind === "tool.execution" &&
			record.phase === "end" &&
			record.correlation?.tool_call_id === "post-edit-tool"),
		"post-edit telemetry",
	);
	const postEditRecordCount = records.filter(
		(record) => record.correlation?.tool_call_id === "post-edit-tool",
	).length;
	emitTool(preEditSession, "stale-edit-session-tool");
	await sleep(100);
	if (
		postEditRecord.correlation.session_id !== postEditSession.sessionId ||
		postEditRecord.correlation.conversation_id !== preEditTelemetryConversationId ||
		postEditRecordCount !== 2 ||
		records.some((record) => record.correlation?.tool_call_id === "stale-edit-session-tool")
	) {
		throw new Error(
			`edit session binding mismatch: ${JSON.stringify({
				oldSessionId: preEditSessionId,
				newSessionId: postEditSession.sessionId,
				recordSessionId: postEditRecord.correlation.session_id,
				postEditRecordCount,
			})}`,
		);
	}
	console.log("PASS edit rebinds telemetry once to new Pi session identity");
	if (!preEditSessionFile) throw new Error("persisted edit fixture path missing");
	async function assertSdkSessionReplacement(label, replaceSession) {
		const runtime = clientSession.runtime;
		const oldSession = clientSession.session;
		const oldSessionId = oldSession.sessionId;
		const telemetryConversationId = postEditRecord.correlation.conversation_id;
		await replaceSession(runtime);
		const newSession = runtime.session;
		if (newSession === oldSession || newSession.sessionId === oldSessionId) {
			throw new Error(`${label} did not replace SDK session identity`);
		}
		const toolCallId = `sdk-${label}-tool`;
		emitTool(newSession, toolCallId);
		const replacementRecord = await waitFor(
			() => records.find((record) =>
				record.kind === "tool.execution" &&
				record.phase === "end" &&
				record.correlation?.tool_call_id === toolCallId),
			`${label} replacement telemetry`,
			750,
		);
		emitTool(oldSession, `stale-${label}-tool`);
		await sleep(50);
		if (
			replacementRecord.correlation.session_id !== newSession.sessionId ||
			replacementRecord.correlation.conversation_id !== telemetryConversationId ||
			records.filter((record) => record.correlation?.tool_call_id === toolCallId).length !== 2 ||
			records.some((record) => record.correlation?.tool_call_id === `stale-${label}-tool`)
		) {
			throw new Error(`${label} replacement binding mismatch`);
		}
	}
	await assertSdkSessionReplacement("new-session", (runtime) => runtime.newSession());
	await assertSdkSessionReplacement("switch-session", (runtime) =>
		runtime.switchSession(preEditSessionFile),
	);
	console.log("PASS SDK new/switch session replacements rebind exactly once");
	const navigationClient = await appModule.service.attach("navigation-race-fixture", () => {});
	const originalNavigationFactory = navigationClient.makeRuntimeFactory;
	let releaseFirstNavigation;
	let markFirstNavigationReady;
	let staleNavigationRuntimeDisposals = 0;
	const firstNavigationGate = new Promise((resolve) => {
		releaseFirstNavigation = resolve;
	});
	const firstNavigationReady = new Promise((resolve) => {
		markFirstNavigationReady = resolve;
	});
	navigationClient.makeRuntimeFactory = function (terminals) {
		const createRuntime = originalNavigationFactory.call(this, terminals);
		return async (options) => {
			const result = await createRuntime(options);
			const originalDispose = result.session.dispose.bind(result.session);
			result.session.dispose = () => {
				staleNavigationRuntimeDisposals++;
				return originalDispose();
			};
			markFirstNavigationReady();
			await firstNavigationGate;
			return result;
		};
	};
	const firstNavigationCwd = join(base, "navigation-first");
	const secondNavigationCwd = join(base, "navigation-second");
	mkdirSync(firstNavigationCwd, { recursive: true });
	mkdirSync(secondNavigationCwd, { recursive: true });
	const firstNavigation = navigationClient.setCwd(firstNavigationCwd);
	await firstNavigationReady;
	navigationClient.makeRuntimeFactory = originalNavigationFactory;
	await navigationClient.setCwd(secondNavigationCwd);
	releaseFirstNavigation();
	await firstNavigation;
	if (
		navigationClient.cwd !== secondNavigationCwd ||
		navigationClient.session.sessionManager.getCwd() !== secondNavigationCwd ||
		[...navigationClient.convs.values()].some((conv) => conv.cwd === firstNavigationCwd) ||
		staleNavigationRuntimeDisposals !== 1
	) {
		throw new Error("slower navigation runtime overwrote newer workspace");
	}
	console.log("PASS slower navigation runtime cannot overwrite newer request");

	const projectB = join(base, "project-b");
	mkdirSync(projectB, { recursive: true });
	let backgroundSession = clientSession.session;
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
	const editRaceForegroundId = clientSession.activeId;
	const editRaceConversation = clientSession.convs.get(editRaceForegroundId);
	if (!editRaceConversation) throw new Error("edit race foreground conversation missing");
	const editRaceTimestamp = 3_300;
	const editRaceMessage = {
		role: "user",
		content: [{ type: "text", text: "edit race original" }],
		timestamp: editRaceTimestamp,
	};
	editRaceConversation.session.sessionManager.appendMessage(editRaceMessage);
	editRaceConversation.session.agent.state.messages.push(editRaceMessage);
	const editRaceAnswer = assistantMessage(
		[{ type: "text", text: "edit race answer" }],
		"stop",
		editRaceTimestamp + 1,
	);
	editRaceConversation.session.sessionManager.appendMessage(editRaceAnswer);
	editRaceConversation.session.agent.state.messages.push(editRaceAnswer);
	editRaceConversation.listed = true;
	editRaceConversation.promptedSinceActive = true;
	const editRaceRuntime = editRaceConversation.runtime;
	const originalEditRaceFork = editRaceRuntime.fork.bind(editRaceRuntime);
	let releaseEditRaceFork;
	let markEditRaceForkReady;
	const editRaceForkGate = new Promise((resolve) => {
		releaseEditRaceFork = resolve;
	});
	const editRaceForkReady = new Promise((resolve) => {
		markEditRaceForkReady = resolve;
	});
	editRaceRuntime.fork = async (...args) => {
		const result = await originalEditRaceFork(...args);
		markEditRaceForkReady();
		await editRaceForkGate;
		return result;
	};
	const originalClientPrompt = clientSession.prompt;
	const editRacePromptTargets = [];
	clientSession.prompt = async function () {
		editRacePromptTargets.push(this.activeId);
	};
	const editRace = clientSession.editMessage(
		`u-${editRaceTimestamp}-1`,
		"edit race replacement",
	);
	await editRaceForkReady;
	await clientSession.switchConversation(backgroundUiConversationId);
	releaseEditRaceFork();
	await editRace;
	clientSession.prompt = originalClientPrompt;
	editRaceRuntime.fork = originalEditRaceFork;
	if (
		clientSession.activeId !== backgroundUiConversationId ||
		editRacePromptTargets.length !== 0
	) {
		throw new Error(`edit resumed against wrong active conversation: ${editRacePromptTargets}`);
	}
	await clientSession.switchConversation(editRaceForegroundId);
	foregroundSession = clientSession.session;
	console.log("PASS edit cannot resume prompt against a different active conversation");
	const backgroundConversation = clientSession.convs.get(backgroundUiConversationId);
	if (!backgroundConversation) throw new Error("background conversation missing");
	const activeIdBeforeBackgroundReset = clientSession.activeId;
	const activeSessionBeforeBackgroundReset = clientSession.session;
	await clientSession.forceResetConversation(
		backgroundConversation,
		"fixture background force reset",
	);
	if (
		clientSession.activeId !== activeIdBeforeBackgroundReset ||
		clientSession.session !== activeSessionBeforeBackgroundReset
	) {
		throw new Error("background force reset changed active conversation");
	}
	backgroundSession = backgroundConversation.session;
	emitTool(backgroundSession, "background-reset-tool");
	const backgroundResetTool = await waitFor(
		() => records.find((record) =>
			record.kind === "tool.execution" &&
			record.phase === "end" &&
			record.correlation?.tool_call_id === "background-reset-tool"),
		"background force-reset telemetry",
		750,
	);
	if (
		backgroundResetTool.correlation.session_id !== backgroundSession.sessionId ||
		backgroundResetTool.correlation.conversation_id !== backgroundTool.correlation.conversation_id ||
		backgroundResetTool.attributes.project_cwd !== projectDir
	) {
		throw new Error("background force-reset telemetry metadata mismatch");
	}
	console.log("PASS background force reset binds target without changing active conversation");

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
	const preResetMapper = foregroundConversation.telemetryMapper;
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
	if (
		foregroundConversation.telemetryMapper === preResetMapper ||
		resetRuntimeTool.correlation.conversation_id !== preResetConversationId ||
		resetRuntimeTool.correlation.session_id !== foregroundSession.sessionId
	) {
		throw new Error("replacement runtime mapper/session metadata mismatch");
	}
	console.log("PASS force-reset runtime receives fresh mapper with stable conversation metadata");
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

	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const lateRuntimeScenarios = [];
	async function prepareLateRuntimeScenario(name, startOperation) {
		const scenarioClientId = `late-runtime-${name}`;
		const scenarioClient = await appModule.service.attach(scenarioClientId, () => {});
		const baselineConversationCount = scenarioClient.convs.size;
		const originalMakeRuntimeFactory = scenarioClient.makeRuntimeFactory;
		let releaseRuntime;
		let markRuntimeReady;
		const runtimeGate = new Promise((resolve) => {
			releaseRuntime = resolve;
		});
		const runtimeReady = new Promise((resolve) => {
			markRuntimeReady = resolve;
		});
		const scenario = {
			name,
			clientId: scenarioClientId,
			client: scenarioClient,
			baselineConversationCount,
			createdSession: null,
			subscribeCalls: 0,
			release: () => releaseRuntime(),
			operation: null,
		};
		scenarioClient.makeRuntimeFactory = function (terminals) {
			const createRuntime = originalMakeRuntimeFactory.call(this, terminals);
			return async (options) => {
				const result = await createRuntime(options);
				scenario.createdSession = result.session;
				const originalSubscribe = result.session.subscribe.bind(result.session);
				result.session.subscribe = (listener) => {
					scenario.subscribeCalls++;
					return originalSubscribe(listener);
				};
				markRuntimeReady();
				await runtimeGate;
				return result;
			};
		};
		scenario.operation = Promise.resolve().then(() => startOperation(scenarioClient));
		await Promise.race([
			runtimeReady,
			scenario.operation.then(() => {
				throw new Error(`${name} settled before runtime gate`);
			}),
			sleep(3_000).then(() => {
				throw new Error(`${name} did not reach runtime gate`);
			}),
		]);
		scenarioClient.makeRuntimeFactory = originalMakeRuntimeFactory;
		lateRuntimeScenarios.push(scenario);
	}

	await prepareLateRuntimeScenario("new-chat", async (scenarioClient) => {
		scenarioClient.session.agent.state.messages.push({
			role: "user",
			content: [{ type: "text", text: "nonblank fixture" }],
			timestamp: 3_100,
		});
		await scenarioClient.newChat();
	});
	const lateCwd = join(base, "late-cwd");
	mkdirSync(lateCwd, { recursive: true });
	await prepareLateRuntimeScenario("set-cwd", (scenarioClient) =>
		scenarioClient.setCwd(lateCwd),
	);
	const lateSwitchCwd = join(base, "late-switch-cwd");
	const lateSwitchSessionDir = join(base, "late-switch-sessions");
	mkdirSync(lateSwitchCwd, { recursive: true });
	mkdirSync(lateSwitchSessionDir, { recursive: true });
	const lateSwitchManager = SessionManager.create(lateSwitchCwd, lateSwitchSessionDir);
	lateSwitchManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "switch fixture" }],
		timestamp: 3_200,
	});
	lateSwitchManager.appendMessage(
		assistantMessage([{ type: "text", text: "switch answer" }], "stop", 3_201),
	);
	await prepareLateRuntimeScenario("switch-session", (scenarioClient) =>
		scenarioClient.switchSession(lateSwitchManager.getSessionFile()),
	);
	await prepareLateRuntimeScenario("force-reset", (scenarioClient) => {
		const scenarioConversation = scenarioClient.convs.get(scenarioClient.activeId);
		if (!scenarioConversation) throw new Error("force-reset scenario conversation missing");
		return scenarioClient.forceResetConversation(
			scenarioConversation,
			"late force-reset fixture",
		);
	});

	const agentServiceModule = await import(
		pathToFileURL(join(REPO_ROOT, "dist/server/agent-service.js")).href
	);
	const originalCreate = agentServiceModule.ClientSession.create;
	const runtimePrototype = Object.getPrototypeOf(clientSession.runtime);
	const originalRuntimeDispose = runtimePrototype.dispose;
	let runtimeDisposeCalls = 0;
	runtimePrototype.dispose = async function (...args) {
		runtimeDisposeCalls++;
		return originalRuntimeDispose.apply(this, args);
	};
	let releasePendingCreate;
	const pendingCreateGate = new Promise((resolve) => {
		releasePendingCreate = resolve;
	});
	agentServiceModule.ClientSession.create = async function (...args) {
		await pendingCreateGate;
		return originalCreate.apply(this, args);
	};
	const pendingAttach = appModule.service
		.attach("pending-shutdown-client", () => {})
		.then(
			(session) => ({ session }),
			(error) => ({ error }),
		);
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
	await Promise.race([
		firstClose,
		sleep(750).then(() => {
			releasePendingCreate();
			throw new Error("server shutdown exceeded pending-create deadline");
		}),
	]);
	const disposalsBeforeLateCreate = runtimeDisposeCalls;
	const recordsBeforeLateCreate = records.length;
	const connectionsBeforeLateCreate = connectionCount;
	releasePendingCreate();
	for (const scenario of lateRuntimeScenarios) scenario.release();
	const pendingAttachResult = await pendingAttach;
	const lateRuntimeResults = await Promise.allSettled(
		lateRuntimeScenarios.map((scenario) => scenario.operation),
	);
	await sleep(100);
	agentServiceModule.ClientSession.create = originalCreate;
	runtimePrototype.dispose = originalRuntimeDispose;
	if (
		"session" in pendingAttachResult ||
		appModule.service.get("pending-shutdown-client") !== undefined ||
		runtimeDisposeCalls < disposalsBeforeLateCreate + lateRuntimeScenarios.length + 1 ||
		records.length !== recordsBeforeLateCreate ||
		connectionCount !== connectionsBeforeLateCreate ||
		lateRuntimeResults.some((result) => result.status === "rejected") ||
		lateRuntimeScenarios.some((scenario) =>
			scenario.client.disposed !== true ||
			scenario.client.convs.size !== scenario.baselineConversationCount ||
			scenario.subscribeCalls !== 0 ||
			appModule.service.get(scenario.clientId) !== undefined
		)
	) {
		throw new Error("late runtime creation survived bounded shutdown");
	}
	console.log("PASS bounded shutdown disposes late runtime creations across operation families");
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
