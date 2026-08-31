import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("pins DSH trajectory donor commit and MIT license", async () => {
	const notice = await readFile("THIRD_PARTY_NOTICES.md", "utf8");

	expect(notice).toContain("DeepSeek Harness");
	expect(notice).toContain("packages/client/ui-trajectory");
	expect(notice).toContain("0a53fb55bea101816fa226bb964ae2bed71c343b");
	expect(notice).toContain("Copyright (c) 2026 DeepSeek");
	expect(notice).toContain("MIT");
	expect(notice).toContain("https://github.com/deepseek-ai/DeepSeek-Harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/LICENSE");
});
