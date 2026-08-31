import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	PiEventMapper,
	type PiTelemetryContext,
} from "../../server/telemetry/pi-event-mapper.js";

type AgentEndEvent = Extract<AgentSessionEvent, { type: "agent_end" }>;
type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type TurnEndEvent = Extract<AgentSessionEvent, { type: "turn_end" }>;
type AssistantMessage = Extract<TurnEndEvent["message"], { role: "assistant" }>;

const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
	stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred",
	content: AssistantMessage["content"] = [],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage,
		stopReason,
		timestamp: 1_000,
	};
}

function agentEnd(
	stopReason: Parameters<typeof assistant>[0],
	willRetry = false,
): AgentEndEvent {
	return { type: "agent_end", messages: [assistant(stopReason)], willRetry };
}

function turnEnd(stopReason: Parameters<typeof assistant>[0]): TurnEndEvent {
	return { type: "turn_end", message: assistant(stopReason), toolResults: [] };
}

function toolEnd(
	toolCallId = "call-1",
	isError = false,
): Extract<AgentSessionEvent, { type: "tool_execution_end" }> {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "bash",
		result: { content: [], details: {} },
		isError,
	};
}

function mapper(clock = { wall: 1_700_000_000_000, mono: 100 }): PiEventMapper {
	return new PiEventMapper({
		source: { host_id: "robot-01", component: "pi", version: "0.84.4" },
		sessionId: "session-1",
		conversationId: "conversation-1",
		wallNow: () => clock.wall,
		monotonicNow: () => clock.mono,
	});
}

const lifecycleCases: Array<{
	name: string;
	prepare: AgentSessionEvent[];
	event: AgentSessionEvent;
	want: {
		kind: string;
		phase: string;
		parent_id: string;
		turn_id?: string;
		step_id?: string;
		request_id?: string;
		tool_call_id?: string;
	};
}> = [
	{
		name: "agent_start",
		prepare: [],
		event: { type: "agent_start" },
		want: { kind: "agent.run", phase: "start", parent_id: "session-1" },
	},
	{
		name: "agent_end",
		prepare: [{ type: "agent_start" }],
		event: agentEnd("stop"),
		want: { kind: "agent.run", phase: "end", parent_id: "session-1" },
	},
	{
		name: "turn_start",
		prepare: [{ type: "agent_start" }],
		event: { type: "turn_start" },
		want: {
			kind: "agent.turn",
			phase: "start",
			parent_id: "conversation-1:run:1",
			turn_id: "conversation-1:turn:1",
			step_id: "conversation-1:step:1",
			request_id: "conversation-1:request:1",
		},
	},
	{
		name: "turn_end",
		prepare: [{ type: "agent_start" }, { type: "turn_start" }],
		event: turnEnd("stop"),
		want: {
			kind: "agent.turn",
			phase: "end",
			parent_id: "conversation-1:run:1",
			turn_id: "conversation-1:turn:1",
			step_id: "conversation-1:step:1",
			request_id: "conversation-1:request:1",
		},
	},
	{
		name: "tool_execution_start",
		prepare: [{ type: "agent_start" }, { type: "turn_start" }],
		event: {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "pwd" },
		},
		want: {
			kind: "tool.execution",
			phase: "start",
			parent_id: "conversation-1:request:1",
			turn_id: "conversation-1:turn:1",
			step_id: "conversation-1:step:1",
			request_id: "conversation-1:request:1",
			tool_call_id: "call-1",
		},
	},
	{
		name: "tool_execution_end",
		prepare: [
			{ type: "agent_start" },
			{ type: "turn_start" },
			{
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "pwd" },
			},
		],
		event: toolEnd(),
		want: {
			kind: "tool.execution",
			phase: "end",
			parent_id: "conversation-1:request:1",
			turn_id: "conversation-1:turn:1",
			step_id: "conversation-1:step:1",
			request_id: "conversation-1:request:1",
			tool_call_id: "call-1",
		},
	},
];

describe("PiEventMapper", () => {
	it("uses a concrete-session namespace without changing conversation metadata", () => {
		const subject = new PiEventMapper({
			source: { host_id: "robot-01", component: "pi" },
			sessionId: "session-a",
			conversationId: "conversation-stable",
			idNamespace: "conversation-stable:session-a",
		});

		const [record] = subject.map({ type: "agent_start" });

		expect(record.correlation).toMatchObject({
			trace_id: "conversation-stable:session-a:run:1",
			session_id: "session-a",
			conversation_id: "conversation-stable",
		});
	});

	it("namespaces tool correlation IDs when a concrete-session namespace is supplied", () => {
		const subject = new PiEventMapper({
			source: { host_id: "robot-01", component: "pi" },
			sessionId: "session-b",
			conversationId: "conversation-stable",
			idNamespace: "conversation-stable:session-b",
		});

		subject.map({ type: "agent_start" });
		subject.map({ type: "turn_start" });
		const [record] = subject.map({
			type: "tool_execution_start",
			toolCallId: "reused-tool-id",
			toolName: "fixture",
			args: {},
		});

		expect(record.correlation?.tool_call_id).toBe(
			"conversation-stable:session-b:tool:reused-tool-id",
		);
	});

	it.each(lifecycleCases)("maps $name with stable parent ids", ({ prepare, event, want }) => {
		const subject = mapper();
		for (const prerequisite of prepare) subject.map(prerequisite);

		const [record] = subject.map(event);

		expect(record).toMatchObject({
			kind: want.kind,
			phase: want.phase,
			source: { host_id: "robot-01", component: "pi", version: "0.84.4" },
			correlation: {
				trace_id: "conversation-1:run:1",
				parent_id: want.parent_id,
				session_id: "session-1",
				conversation_id: "conversation-1",
				...(want.turn_id ? { turn_id: want.turn_id } : {}),
				...(want.step_id ? { step_id: want.step_id } : {}),
				...(want.request_id ? { request_id: want.request_id } : {}),
				...(want.tool_call_id ? { tool_call_id: want.tool_call_id } : {}),
			},
			attributes: { source_timestamp_ms: 1_700_000_000_000 },
		});
	});

	it("uses monotonic time for matched tool duration", () => {
		const clock = { wall: 1_700_000_000_000, mono: 100 };
		const subject = mapper(clock);
		subject.map({ type: "agent_start" });
		subject.map({ type: "turn_start" });
		subject.map({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "pwd" },
		});
		clock.wall += 9_000;
		clock.mono = 142.5;

		const [record] = subject.map(toolEnd());

		expect(record).toMatchObject({
			state: "completed",
			duration_ms: 42.5,
			attributes: {
				source_timestamp_ms: 1_700_000_009_000,
				tool_name: "bash",
				is_error: false,
				matched_start: true,
			},
		});
	});

	it("leaves duration unknown for unmatched tool end", () => {
		const subject = mapper();
		subject.map({ type: "agent_start" });
		subject.map({ type: "turn_start" });

		const [record] = subject.map(toolEnd("missing"));

		expect(record.duration_ms).toBeUndefined();
		expect(record).toMatchObject({
			state: "completed",
			correlation: { tool_call_id: "missing" },
			attributes: { matched_start: false },
		});
	});

	it.each([
		["stop", false, "completed", "info"],
		["aborted", false, "cancelled", "warning"],
		["error", false, "error", "error"],
		["length", false, "truncated", "warning"],
		["deferred", false, "deferred", "info"],
		["error", true, "retrying", "warning"],
	] as const)(
		"maps agent end %s retry=%s to %s",
		(stopReason, willRetry, state, severity) => {
			const subject = mapper();
			subject.map({ type: "agent_start" });

			const [record] = subject.map(agentEnd(stopReason, willRetry));

			expect(record).toMatchObject({ phase: "end", state, severity });
		},
	);

	it.each([
		["stop", "completed"],
		["aborted", "cancelled"],
		["error", "error"],
		["length", "truncated"],
		["deferred", "deferred"],
	] as const)("maps turn end %s to %s", (stopReason, state) => {
		const subject = mapper();
		subject.map({ type: "agent_start" });
		subject.map({ type: "turn_start" });

		const [record] = subject.map(turnEnd(stopReason));

		expect(record.state).toBe(state);
	});

	it("keeps one run id across an SDK retry, then allocates a new final run", () => {
		const subject = mapper();
		const [firstStart] = subject.map({ type: "agent_start" });
		const [retryEnd] = subject.map(agentEnd("error", true));
		const [retryStart] = subject.map({ type: "agent_start" });
		subject.map(agentEnd("stop"));
		const [nextStart] = subject.map({ type: "agent_start" });

		expect(firstStart.correlation?.trace_id).toBe("conversation-1:run:1");
		expect(retryEnd.correlation?.trace_id).toBe("conversation-1:run:1");
		expect(retryStart.correlation?.trace_id).toBe("conversation-1:run:1");
		expect(nextStart.correlation?.trace_id).toBe("conversation-1:run:2");
	});

	it.each(
		[
			[
				"failed auto retry",
				{ type: "auto_retry_end", success: false, attempt: 1, finalError: "failed" },
			],
			["settled run", { type: "agent_settled" }],
		] satisfies Array<[string, AgentSessionEvent]>,
	)(
		"clears retry state after %s before a later agent start",
		(_name, terminalEvent) => {
			const clock = { wall: 1_700_000_000_000, mono: 100 };
			const subject = mapper(clock);
			const [firstStart] = subject.map({ type: "agent_start" });
			clock.mono = 110;
			subject.map(agentEnd("error", true));
			clock.mono = 120;

			expect(subject.map(terminalEvent)).toEqual([]);

			clock.mono = 200;
			const [nextStart] = subject.map({ type: "agent_start" });
			clock.mono = 230;
			const [nextEnd] = subject.map(agentEnd("stop"));

			expect(firstStart.correlation?.trace_id).toBe("conversation-1:run:1");
			expect(nextStart.correlation?.trace_id).toBe("conversation-1:run:2");
			expect(nextStart.attributes).not.toHaveProperty("duplicate_start");
			expect(nextEnd.duration_ms).toBe(30);
		},
	);

	it("does not overwrite first tool start on duplicate start or reuse it after end", () => {
		const clock = { wall: 1_700_000_000_000, mono: 100 };
		const subject = mapper(clock);
		subject.map({ type: "agent_start" });
		subject.map({ type: "turn_start" });
		const start = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "pwd" },
		} satisfies AgentSessionEvent;
		subject.map(start);
		clock.mono = 120;
		const [duplicateStart] = subject.map(start);
		clock.mono = 135;
		const [firstEnd] = subject.map(toolEnd());
		clock.mono = 150;
		const [duplicateEnd] = subject.map(toolEnd());

		expect(duplicateStart.attributes).toMatchObject({ duplicate_start: true });
		expect(firstEnd.duration_ms).toBe(35);
		expect(duplicateEnd.duration_ms).toBeUndefined();
		expect(duplicateEnd.attributes).toMatchObject({ matched_start: false });
	});

	it("reuses correlation for duplicate run and turn starts", () => {
		const subject = mapper();
		const [runStart] = subject.map({ type: "agent_start" });
		const [duplicateRunStart] = subject.map({ type: "agent_start" });
		const [turnStart] = subject.map({ type: "turn_start" });
		const [duplicateTurnStart] = subject.map({ type: "turn_start" });

		expect(duplicateRunStart.correlation?.trace_id).toBe(runStart.correlation?.trace_id);
		expect(duplicateRunStart.attributes).toMatchObject({ duplicate_start: true });
		expect(duplicateTurnStart.correlation).toMatchObject({
			turn_id: turnStart.correlation?.turn_id,
			step_id: turnStart.correlation?.step_id,
			request_id: turnStart.correlation?.request_id,
		});
		expect(duplicateTurnStart.attributes).toMatchObject({ duplicate_start: true });
	});

	it("emits context.changed only when prompt or sorted tool-schema hash changes", () => {
		const subject = mapper();
		const initial: PiTelemetryContext = {
			systemPrompt: "private system prompt",
			toolSchemas: [
				{ name: "write", schema: { type: "object", properties: { path: { type: "string" } } } },
				{ name: "read", schema: { required: ["path"], type: "object" } },
			],
		};

		const initialRecords = subject.map({ type: "agent_start" }, initial);
		const reorderedRecords = subject.map({ type: "turn_start" }, {
			...initial,
			toolSchemas: [...initial.toolSchemas].reverse(),
		});
		const promptChanged = subject.map(turnEnd("stop"), {
			...initial,
			systemPrompt: "new private system prompt",
		});
		const schemaChanged = subject.map({ type: "turn_start" }, {
			...initial,
			systemPrompt: "new private system prompt",
			toolSchemas: [
				initial.toolSchemas[0],
				{ name: "read", schema: { required: ["path"], type: "object", additionalProperties: false } },
			],
		});

		expect(initialRecords.map((record) => record.kind)).toEqual(["context.changed", "agent.run"]);
		expect(initialRecords[0].correlation).toMatchObject({
			trace_id: "conversation-1:run:1",
			parent_id: "conversation-1:run:1",
			session_id: "session-1",
			conversation_id: "conversation-1",
		});
		expect(reorderedRecords.map((record) => record.kind)).toEqual(["agent.turn"]);
		expect(promptChanged.map((record) => record.kind)).toEqual(["context.changed", "agent.turn"]);
		expect(schemaChanged.map((record) => record.kind)).toEqual(["context.changed", "agent.turn"]);
		expect(schemaChanged[0].correlation).toMatchObject({
			trace_id: "conversation-1:run:1",
			turn_id: "conversation-1:turn:2",
			step_id: "conversation-1:step:2",
			request_id: "conversation-1:request:2",
			parent_id: "conversation-1:request:2",
		});
		for (const record of [initialRecords[0], promptChanged[0], schemaChanged[0]]) {
			expect(record.attributes).toMatchObject({
				system_prompt_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
				tool_schema_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
			});
			const serialized = JSON.stringify(record);
			expect(serialized).not.toContain("private system prompt");
			expect(serialized).not.toContain("properties");
			expect(serialized).not.toContain("additionalProperties");
		}
	});

	it("emits provider thinking only for explicit non-empty thinking content", () => {
		const subject = mapper();
		subject.map({ type: "agent_start" });
		subject.map({ type: "turn_start" });
		const base = assistant("pending");
		const textEvent: MessageUpdateEvent = {
			type: "message_update",
			message: base,
			assistantMessageEvent: {
				type: "text_end",
				contentIndex: 0,
				content: "answer",
				partial: base,
			},
		};
		const thinkingMessage = assistant("pending", [{ type: "thinking", thinking: "provider summary" }]);
		const thinkingEvent: MessageUpdateEvent = {
			type: "message_update",
			message: thinkingMessage,
			assistantMessageEvent: {
				type: "thinking_end",
				contentIndex: 0,
				content: "provider summary",
				partial: thinkingMessage,
			},
		};
		const emptyThinkingEvent: MessageUpdateEvent = {
			type: "message_update",
			message: thinkingMessage,
			assistantMessageEvent: {
				type: "thinking_end",
				contentIndex: 0,
				content: "",
				partial: thinkingMessage,
			},
		};

		expect(subject.map(textEvent)).toEqual([]);
		expect(subject.map(emptyThinkingEvent)).toEqual([]);
		expect(subject.map(thinkingEvent)).toEqual([
			expect.objectContaining({
				kind: "provider.thinking",
				phase: "end",
				state: "emitted",
				attributes: expect.objectContaining({ content: "provider summary", content_index: 0 }),
			}),
		]);
	});

	it.each([
		[
			"text-only thinking end",
			{
				type: "message_update",
				message: assistant("pending", [{ type: "text", text: "answer" }]),
				assistantMessageEvent: {
					type: "thinking_end",
					contentIndex: 0,
					content: "spoofed thinking",
					partial: assistant("pending", [{ type: "text", text: "answer" }]),
				},
			},
		],
		[
			"out-of-range thinking start",
			{
				type: "message_update",
				message: assistant("pending", [{ type: "thinking", thinking: "summary" }]),
				assistantMessageEvent: {
					type: "thinking_start",
					contentIndex: 1,
					partial: assistant("pending", [{ type: "thinking", thinking: "summary" }]),
				},
			},
		],
		[
			"out-of-range thinking delta",
			{
				type: "message_update",
				message: assistant("pending", [{ type: "thinking", thinking: "summary" }]),
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 1,
					delta: "more",
					partial: assistant("pending", [{ type: "thinking", thinking: "summary" }]),
				},
			},
		],
		[
			"out-of-range thinking end",
			{
				type: "message_update",
				message: assistant("pending", [{ type: "thinking", thinking: "summary" }]),
				assistantMessageEvent: {
					type: "thinking_end",
					contentIndex: 1,
					content: "summary",
					partial: assistant("pending", [{ type: "thinking", thinking: "summary" }]),
				},
			},
		],
	] as const)("ignores %s without changing context or turn state", (_name, malformed) => {
		const subject = mapper();
		const initial: PiTelemetryContext = { systemPrompt: "prompt-1", toolSchemas: [] };
		const changed: PiTelemetryContext = { systemPrompt: "prompt-2", toolSchemas: [] };
		subject.map({ type: "agent_start" }, initial);
		const [, firstTurn] = subject.map({ type: "turn_start" }, changed);

		expect(subject.map(malformed as unknown as AgentSessionEvent, initial)).toEqual([]);

		const nextRecords = subject.map({ type: "turn_start" }, initial);
		expect(nextRecords.map((record) => record.kind)).toEqual(["context.changed", "agent.turn"]);
		expect(nextRecords[1].attributes).toMatchObject({ duplicate_start: true });
		expect(nextRecords[1].correlation).toMatchObject({
			turn_id: firstTurn.correlation?.turn_id,
			step_id: firstTurn.correlation?.step_id,
			request_id: firstTurn.correlation?.request_id,
		});
	});

	it.each([
		["agent_end messages", { type: "agent_end", messages: null, willRetry: false }],
		["agent_end message entry", { type: "agent_end", messages: [null], willRetry: false }],
		["agent_end message object", { type: "agent_end", messages: [{}], willRetry: false }],
		[
			"agent_end assistant image content",
			{
				type: "agent_end",
				messages: [
					{
						...assistant("stop"),
						content: [{ type: "image", data: "base64", mimeType: "image/png" }],
					},
				],
				willRetry: false,
			},
		],
		[
			"agent_end user thinking content",
			{
				type: "agent_end",
				messages: [
					{
						role: "user",
						content: [{ type: "thinking", thinking: "not valid user content" }],
						timestamp: 1_000,
					},
				],
				willRetry: false,
			},
		],
		["turn_end message", { type: "turn_end", message: null, toolResults: [] }],
		["turn_end message object", { type: "turn_end", message: {}, toolResults: [] }],
		[
			"turn_end tool result",
			{ type: "turn_end", message: assistant("stop"), toolResults: [null] },
		],
		[
			"turn_end tool result thinking content",
			{
				type: "turn_end",
				message: assistant("stop"),
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "bash",
						content: [{ type: "thinking", thinking: "not valid tool content" }],
						isError: false,
						timestamp: 1_000,
					},
				],
			},
		],
		[
			"turn_end tool result toolCall content",
			{
				type: "turn_end",
				message: assistant("stop"),
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "bash",
						content: [
							{ type: "toolCall", id: "nested", name: "read", arguments: {} },
						],
						isError: false,
						timestamp: 1_000,
					},
				],
			},
		],
		["tool start identity", { type: "tool_execution_start", toolCallId: 7, toolName: "bash", args: {} }],
		["tool end error flag", { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: {}, isError: "false" }],
		["message update payload", { type: "message_update", message: assistant("pending"), assistantMessageEvent: null }],
		[
			"message update message",
			{
				type: "message_update",
				message: {},
				assistantMessageEvent: {
					type: "thinking_end",
					contentIndex: 0,
					content: "provider summary",
					partial: assistant("pending"),
				},
			},
		],
		[
			"message update partial",
			{
				type: "message_update",
				message: assistant("pending"),
				assistantMessageEvent: {
					type: "thinking_end",
					contentIndex: 0,
					content: "provider summary",
					partial: {},
				},
			},
		],
		["retry end result", { type: "auto_retry_end", success: "false", attempt: 1 }],
	] as const)(
		"ignores malformed %s without emitting context or changing turn correlation",
		(_name, malformed) => {
			const subject = mapper();
			const initial: PiTelemetryContext = { systemPrompt: "prompt-1", toolSchemas: [] };
			const changed: PiTelemetryContext = { systemPrompt: "prompt-2", toolSchemas: [] };
			subject.map({ type: "agent_start" }, initial);
			const [, firstTurn] = subject.map({ type: "turn_start" }, changed);
			let malformedRecords: ReturnType<PiEventMapper["map"]> = [];

			expect(() => {
				malformedRecords = subject.map(malformed as unknown as AgentSessionEvent, initial);
			}).not.toThrow();
			expect(malformedRecords).toEqual([]);

			const nextRecords = subject.map({ type: "turn_start" }, initial);
			expect(nextRecords.map((record) => record.kind)).toEqual([
				"context.changed",
				"agent.turn",
			]);
			expect(nextRecords[1].attributes).toMatchObject({ duplicate_start: true });
			expect(nextRecords[1].correlation).toMatchObject({
				turn_id: firstTurn.correlation?.turn_id,
				step_id: firstTurn.correlation?.step_id,
				request_id: firstTurn.correlation?.request_id,
			});
		},
	);

	it.each([
		[
			"self-referential array",
			() => {
				const schema: unknown[] = [];
				schema.push(schema);
				return schema;
			},
		],
		[
			"object-array mixed cycle",
			() => {
				const schema: { items?: unknown[] } = {};
				const items: unknown[] = [schema];
				schema.items = items;
				return schema;
			},
		],
		["boxed BigInt", () => Object(1n)],
		["Map", () => new Map([["type", "object"]])],
		["Date", () => new Date("2026-08-31T00:00:00Z")],
		["RegExp", () => /object/],
	] as const)("rejects %s before clocks, state, or context emission", (_name, makeSchema) => {
		let wallCalls = 0;
		let monotonicCalls = 0;
		const subject = new PiEventMapper({
			source: { host_id: "robot-01", component: "pi" },
			sessionId: "session-1",
			conversationId: "conversation-1",
			wallNow: () => {
				wallCalls++;
				return 1_700_000_000_000;
			},
			monotonicNow: () => {
				monotonicCalls++;
				return 100;
			},
		});
		const invalidContext: PiTelemetryContext = {
			systemPrompt: "prompt",
			toolSchemas: [{ name: "cyclic", schema: makeSchema() }],
		};
		let records: ReturnType<PiEventMapper["map"]> = [];

		expect(() => {
			records = subject.map({ type: "agent_start" }, invalidContext);
		}).not.toThrow();
		expect(records).toEqual([]);
		expect({ wallCalls, monotonicCalls }).toEqual({ wallCalls: 0, monotonicCalls: 0 });

		const validRecords = subject.map(
			{ type: "agent_start" },
			{ systemPrompt: "prompt", toolSchemas: [{ name: "read", schema: { type: "object" } }] },
		);
		expect(validRecords.map((record) => record.kind)).toEqual(["context.changed", "agent.run"]);
		expect(validRecords[0].correlation).toMatchObject({ trace_id: "conversation-1:run:1" });
		expect(validRecords[1].attributes).not.toHaveProperty("duplicate_start");
	});

	it("does not consume a matched tool start when malformed tool end arrives", () => {
		const clock = { wall: 1_700_000_000_000, mono: 100 };
		const subject = mapper(clock);
		subject.map({ type: "agent_start" });
		subject.map({ type: "turn_start" });
		subject.map({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: {},
		});
		clock.mono = 120;

		expect(
			subject.map({
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "bash",
				result: {},
				isError: "false",
			} as unknown as AgentSessionEvent),
		).toEqual([]);

		clock.mono = 135;
		const [validEnd] = subject.map(toolEnd());
		expect(validEnd.duration_ms).toBe(35);
		expect(validEnd.attributes).toMatchObject({ matched_start: true });
	});

	it("does not emit or suppress context changes for an unknown event", () => {
		const subject = mapper();
		const initial: PiTelemetryContext = { systemPrompt: "prompt-1", toolSchemas: [] };
		const changed: PiTelemetryContext = { systemPrompt: "prompt-2", toolSchemas: [] };
		subject.map({ type: "agent_start" }, initial);

		expect(
			subject.map(
				{ type: "future_event", systemPrompt: "spoof" } as unknown as AgentSessionEvent,
				changed,
			),
		).toEqual([]);

		const validRecords = subject.map({ type: "turn_start" }, changed);
		expect(validRecords.map((record) => record.kind)).toEqual(["context.changed", "agent.turn"]);
	});

	it.each([
		["system prompt", { systemPrompt: 7, toolSchemas: [] }],
		["tool schema list", { systemPrompt: "prompt", toolSchemas: null }],
		["tool schema name", { systemPrompt: "prompt", toolSchemas: [{ name: 7, schema: {} }] }],
		["sparse tool schema list", { systemPrompt: "prompt", toolSchemas: Array(1) }],
	] as const)(
		"ignores malformed context %s while preserving valid lifecycle mapping",
		(_name, malformedContext) => {
			const subject = mapper();
			let records: ReturnType<PiEventMapper["map"]> = [];

			expect(() => {
				records = subject.map(
					{ type: "agent_start" },
					malformedContext as unknown as PiTelemetryContext,
				);
			}).not.toThrow();
			expect(records.map((record) => record.kind)).toEqual(["agent.run"]);
			expect(records[0].correlation).toMatchObject({ trace_id: "conversation-1:run:1" });
		},
	);

	it("reset clears open spans and context while dispose rejects later mapping", () => {
		const clock = { wall: 1_700_000_000_000, mono: 100 };
		const subject = mapper(clock);
		const context: PiTelemetryContext = { systemPrompt: "prompt", toolSchemas: [] };
		subject.map({ type: "agent_start" }, context);
		subject.map({ type: "turn_start" });
		subject.map({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: {},
		});
		clock.mono = 200;

		subject.reset();
		const afterReset = subject.map(toolEnd(), context);

		expect(afterReset.map((record) => record.kind)).toEqual(["context.changed", "tool.execution"]);
		expect(afterReset[1].duration_ms).toBeUndefined();
		expect(afterReset[1].correlation).not.toHaveProperty("turn_id");

		subject.dispose();
		expect(subject.map({ type: "agent_start" }, context)).toEqual([]);
	});
});
