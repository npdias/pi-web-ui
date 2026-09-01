import type {
	ConversationSummary,
	SessionSummary,
} from "../../../server/protocol.js";

export function durableSessionTitle(
	session: SessionSummary,
	emptyTitle: string,
): string {
	const title = session.name || session.firstMessage.trim();
	return title.length > 0 ? title : emptyTitle;
}

export function canonicalConversationTitle(
	conversation: ConversationSummary,
	sessions: readonly SessionSummary[],
	emptyTitle: string,
): string {
	if (!conversation.sessionPath) return conversation.title;
	const durable = sessions.find((session) => session.path === conversation.sessionPath);
	return durable === undefined
		? conversation.title
		: durableSessionTitle(durable, emptyTitle);
}

export function visibleHistorySessions(
	conversations: readonly ConversationSummary[],
	sessions: readonly SessionSummary[],
): readonly SessionSummary[] {
	const openPaths = new Set(
		conversations
			.map((conversation) => conversation.sessionPath)
			.filter((path): path is string => typeof path === "string" && path.length > 0),
	);
	return openPaths.size === 0
		? sessions
		: sessions.filter((session) => !openPaths.has(session.path));
}
