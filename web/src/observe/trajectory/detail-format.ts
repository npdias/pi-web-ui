const MAX_DETAIL_DEPTH = 64;
const MAX_DETAIL_NODES = 50_000;
const MAX_DETAIL_STRING_CHARS = 1024 * 1024;
const MAX_DETAIL_OUTPUT_CHARS = 1024 * 1024;

const DEPTH_MARKER = "[TRUNCATED: depth]";
const SIZE_MARKER = "[TRUNCATED: size]";
const CYCLE_MARKER = "[TRUNCATED: cycle]";
const UNSUPPORTED_MARKER = "[TRUNCATED: unsupported value]";

type MutableJson =
	| null
	| boolean
	| number
	| string
	| MutableJson[]
	| { [key: string]: MutableJson };

interface FormatState {
	nodes: number;
	remainingStringChars: number;
	readonly seen: WeakSet<object>;
}

interface FormatFrame {
	readonly input: readonly unknown[] | Record<string, unknown>;
	readonly output: MutableJson[] | Record<string, MutableJson>;
	readonly depth: number;
}

interface FormatNode {
	readonly value: MutableJson;
	readonly frame?: FormatFrame;
	readonly omit?: boolean;
}

function boundedString(value: string, state: FormatState): string {
	if (value.length <= state.remainingStringChars) {
		state.remainingStringChars -= value.length;
		return value;
	}
	const keep = Math.max(0, state.remainingStringChars - SIZE_MARKER.length);
	state.remainingStringChars = 0;
	return `${value.slice(0, keep)}${SIZE_MARKER}`;
}

function formatNode(
	value: unknown,
	depth: number,
	state: FormatState,
	arrayItem: boolean,
): FormatNode {
	if (value === null || typeof value === "boolean") return { value };
	if (typeof value === "number") {
		return { value: Number.isFinite(value) ? value : null };
	}
	if (typeof value === "string") {
		return { value: boundedString(value, state) };
	}
	if (value === undefined || typeof value === "function" || typeof value === "symbol") {
		return arrayItem ? { value: null } : { value: null, omit: true };
	}
	if (typeof value === "bigint") return { value: UNSUPPORTED_MARKER };
	if (depth >= MAX_DETAIL_DEPTH) return { value: DEPTH_MARKER };
	if (state.nodes >= MAX_DETAIL_NODES || state.remainingStringChars <= 0) {
		return { value: SIZE_MARKER };
	}
	if (typeof value !== "object") return { value: UNSUPPORTED_MARKER };
	if (state.seen.has(value)) return { value: CYCLE_MARKER };
	state.seen.add(value);
	state.nodes++;
	if (Array.isArray(value)) {
		const output: MutableJson[] = [];
		return { value: output, frame: { input: value, output, depth } };
	}
	const output: Record<string, MutableJson> = Object.create(null);
	return {
		value: output,
		frame: { input: value as Record<string, unknown>, output, depth },
	};
}

/** Stack-safe, bounded display serialization for already-redacted telemetry evidence. */
export function formatTelemetryDetail(value: unknown): string {
	const state: FormatState = {
		nodes: 0,
		remainingStringChars: MAX_DETAIL_STRING_CHARS,
		seen: new WeakSet(),
	};
	const root = formatNode(value, 0, state, false);
	const stack = root.frame === undefined ? [] : [root.frame];
	while (stack.length > 0) {
		const frame = stack.pop();
		if (frame === undefined) break;
		if (Array.isArray(frame.input)) {
			const output = frame.output as MutableJson[];
			for (const item of frame.input) {
				const parsed = formatNode(item, frame.depth + 1, state, true);
				output.push(parsed.value);
				if (parsed.frame !== undefined) stack.push(parsed.frame);
			}
			continue;
		}
		const output = frame.output as Record<string, MutableJson>;
		for (const [key, item] of Object.entries(frame.input)) {
			if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
			const parsed = formatNode(item, frame.depth + 1, state, false);
			if (parsed.omit) continue;
			output[key] = parsed.value;
			if (parsed.frame !== undefined) stack.push(parsed.frame);
		}
	}
	const serialized = JSON.stringify(root.value, null, 2);
	if (serialized.length <= MAX_DETAIL_OUTPUT_CHARS) return serialized;
	const keep = Math.max(0, MAX_DETAIL_OUTPUT_CHARS - SIZE_MARKER.length - 1);
	return `${serialized.slice(0, keep)}\n${SIZE_MARKER}`;
}
