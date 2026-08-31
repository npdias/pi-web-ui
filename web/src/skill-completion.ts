export interface SkillCommand {
	name: string;
	source: string;
	description?: string;
	descriptionEn?: string;
}

export interface SkillCompletionItem extends SkillCommand {
	name: string;
	source: "skill";
}

export interface SkillToken {
	start: number;
	end: number;
	prefix: string;
}

function activeSkillToken(text: string, cursor: number): SkillToken | null {
	const safeCursor = Math.max(0, Math.min(cursor, text.length));
	const before = text.slice(0, safeCursor);
	const match = before.match(/(?:^|\s)\$([a-z0-9-]*)$/i);
	if (!match) return null;
	const prefix = match[1] ?? "";
	if (/^\d/.test(prefix)) return null;
	return {
		start: safeCursor - prefix.length - 1,
		end: safeCursor,
		prefix,
	};
}

export function getSkillCompletions(
	text: string,
	cursor: number,
	commands: SkillCommand[],
): { token: SkillToken; items: SkillCompletionItem[] } | null {
	const token = activeSkillToken(text, cursor);
	if (!token) return null;
	const prefix = token.prefix.toLowerCase();
	const items = commands
		.filter(
			(command): command is SkillCompletionItem =>
				command.source === "skill" && command.name.startsWith("skill:"),
		)
		.map((command) => ({
			...command,
			name: command.name.slice("skill:".length),
		}))
		.filter((command) => command.name.toLowerCase().startsWith(prefix))
		.sort((a, b) => a.name.localeCompare(b.name));
	return items.length > 0 ? { token, items } : null;
}

export function applySkillCompletion(
	text: string,
	cursor: number,
	name: string,
): { text: string; cursor: number } {
	const token = activeSkillToken(text, cursor);
	if (!token) return { text, cursor };
	const suffix = text.slice(token.end);
	const trailing = suffix.length === 0 || !/^\s/.test(suffix) ? " " : "";
	const insertion = `$${name}${trailing}`;
	return {
		text: `${text.slice(0, token.start)}${insertion}${suffix}`,
		cursor: token.start + insertion.length,
	};
}
