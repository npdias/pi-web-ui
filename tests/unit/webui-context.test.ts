import { describe, expect, it } from "vitest";
import { WebUIContext } from "../../server/webui-context.js";
import type { ServerMessage } from "../../server/protocol.js";

/** Mimic pi SDK wrapUIPromptContext: `{ ...ui, select: wrapped }` copies own
 *  properties only. Class prototype methods would vanish here. */
function wrapLikeSdk(ui: WebUIContext) {
	return {
		...ui,
		select: ui.select,
	};
}

describe("WebUIContext SDK wrap", () => {
	it("setStatus and notify remain functions after object spread", () => {
		const ui = new WebUIContext(() => {});
		const wrapped = wrapLikeSdk(ui);
		expect(typeof wrapped.setStatus).toBe("function");
		expect(typeof wrapped.notify).toBe("function");
	});

	it("spread copy still emits statuses and notice", () => {
		const msgs: ServerMessage[] = [];
		const ui = new WebUIContext((msg) => msgs.push(msg));
		const wrapped = wrapLikeSdk(ui);

		wrapped.setStatus("0-claude-max", "🧠 5h 19%");
		wrapped.notify("hello", "info");

		expect(msgs).toContainEqual({
			type: "statuses",
			statuses: [{ key: "0-claude-max", text: "🧠 5h 19%" }],
		});
		expect(msgs).toContainEqual({
			type: "notice",
			level: "info",
			text: "hello",
		});
	});

	it("emits each identical startup-ready notice only once", () => {
		const msgs: ServerMessage[] = [];
		const ui = new WebUIContext((msg) => msgs.push(msg));

		ui.notify("web-tools ready (local)", "info");
		ui.notify("web-tools ready (local)", "info");
		ui.notify("homeclaw ready", "info");
		ui.notify("homeclaw ready", "info");
		ui.notify("Ponytail loaded: full", "info");
		ui.notify("Ponytail loaded: full", "info");

		expect(msgs.filter((msg) => msg.type === "notice")).toEqual([
			{ type: "notice", level: "info", text: "web-tools ready (local)" },
			{ type: "notice", level: "info", text: "homeclaw ready" },
			{ type: "notice", level: "info", text: "Ponytail loaded: full" },
		]);
	});

	it("does not suppress failures, warnings, normal info, or not-ready notices", () => {
		const msgs: ServerMessage[] = [];
		const ui = new WebUIContext((msg) => msgs.push(msg));

		for (const [text, level] of [
			["extension failed", "error"],
			["extension warning", "warning"],
			["ordinary update", "info"],
			["pi-computer-use is not ready yet", "info"],
		] as const) {
			ui.notify(text, level);
			ui.notify(text, level);
		}

		expect(msgs.filter((msg) => msg.type === "notice")).toHaveLength(8);
	});
});
