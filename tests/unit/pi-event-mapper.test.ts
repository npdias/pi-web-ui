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
		expect(reorderedRecords.map((record) => record.kind)).toEqual(["agent.turn"]);
		expect(promptChanged.map((record) => record.kind)).toEqual(["context.changed", "agent.turn"]);
		expect(schemaChanged.map((record) => record.kind)).toEqual(["context.changed", "agent.turn"]);
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
