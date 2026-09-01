import { describe, expect, it } from "vitest";
import type { ConversationSummary, SessionSummary } from "../../server/protocol.js";
import {
	canonicalConversationTitle,
	visibleHistorySessions,
} from "../../web/src/components/left-panel-sessions.js";

describe("left panel session identity", () => {
	it("uses durable session title and removes an open session from History", () => {
		const sharedPath = "/sessions/current.jsonl";
		const conversation = {
			id: "c1",
			title: "where's the doc?",
			cwd: "/repo",
			messageCount: 40,
			isStreaming: false,
			sessionPath: sharedPath,
		} as ConversationSummary;
		const durable: SessionSummary = {
			path: sharedPath,
			name: "",
			firstMessage: "inspect the project",
			messageCount: 40,
			modified: 1,
			source: "web",
		};
		const unrelated: SessionSummary = {
			path: "/sessions/other.jsonl",
			name: "Other chat",
			firstMessage: "other",
			messageCount: 2,
			modified: 2,
			source: "web",
		};
		expect(
			canonicalConversationTitle(conversation, [durable, unrelated], "Empty chat"),
		).toBe("inspect the project");
		expect(visibleHistorySessions([conversation], [durable, unrelated])).toEqual([
			unrelated,
		]);
	});

	it("keeps unrelated history and falls back to live title without a session path", () => {
		const conversation = {
			id: "fresh",
			title: "Fresh prompt",
			cwd: "/repo",
			messageCount: 1,
			isStreaming: true,
		} as ConversationSummary;
		const session: SessionSummary = {
			path: "/sessions/history.jsonl",
			name: "History",
			firstMessage: "history",
			messageCount: 3,
			modified: 3,
			source: "web",
		};

		expect(
			canonicalConversationTitle(
				conversation,
				[session],
				"Empty chat",
			),
		).toBe("Fresh prompt");
		expect(
			visibleHistorySessions(
				[conversation],
				[session],
			),
		).toEqual([session]);
	});
});
