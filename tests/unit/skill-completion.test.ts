import { describe, expect, it } from "vitest";
import {
	applySkillCompletion,
	getSkillCompletions,
} from "../../web/src/skill-completion.js";

const commands = [
	{ name: "skill:writing-clearly", source: "skill" as const, description: "Clear prose" },
	{ name: "skill:writing-asd-ste100-style", source: "skill" as const, description: "STE100" },
	{ name: "skill:systematic-debugging", source: "skill" as const, description: "Debug first" },
	{ name: "reload", source: "builtin" as const, description: "Reload" },
];

describe("getSkillCompletions", () => {
	it("offers real Pi skills for a dollar prefix at the cursor", () => {
		const result = getSkillCompletions("Use $writ", 9, commands);
		expect(result?.items.map((item) => item.name)).toEqual([
			"writing-asd-ste100-style",
			"writing-clearly",
		]);
	});

	it("opens the full skill catalog for a bare dollar token", () => {
		const result = getSkillCompletions("Try $", 5, commands);
		expect(result?.items).toHaveLength(3);
		expect(result?.items.every((item) => item.source === "skill")).toBe(true);
	});

	it("matches a skill token mid-sentence and after another skill tag", () => {
		const text = "$systematic-debugging then $wri please";
		const cursor = text.indexOf(" please");
		const result = getSkillCompletions(text, cursor, commands);
		expect(result?.token.prefix).toBe("wri");
		expect(result?.items.map((item) => item.name)).toContain("writing-clearly");
	});

	it("does not trigger inside words, for money, or from non-skill commands", () => {
		expect(getSkillCompletions("cost$wri", 8, commands)).toBeNull();
		expect(getSkillCompletions("pay $50", 7, commands)).toBeNull();
		expect(getSkillCompletions("$rel", 4, commands)).toBeNull();
	});
});

describe("applySkillCompletion", () => {
	it("replaces only the active dollar token and preserves surrounding text", () => {
		const text = "Use $wri for this";
		const cursor = text.indexOf(" for");
		expect(applySkillCompletion(text, cursor, "writing-clearly")).toEqual({
			text: "Use $writing-clearly for this",
			cursor: "Use $writing-clearly".length,
		});
	});

	it("adds a trailing space when completion ends at the input boundary", () => {
		expect(applySkillCompletion("Use $sys", 8, "systematic-debugging")).toEqual({
			text: "Use $systematic-debugging ",
			cursor: "Use $systematic-debugging ".length,
		});
	});
});
