import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it("pins DSH trajectory donor commit and MIT license", async () => {
	const notice = await readFile("THIRD_PARTY_NOTICES.md", "utf8");

	expect(notice).toContain("DeepSeek Harness");
	expect(notice).toContain("packages/client/ui-trajectory");
	expect(notice).toContain("0a53fb55bea101816fa226bb964ae2bed71c343b");
	expect(notice).toContain("Copyright (c) 2026 DeepSeek");
	expect(notice).toContain("MIT");
	expect(notice).toContain("https://github.com/deepseek-ai/DeepSeek-Harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/LICENSE");
});

it("includes the third-party notice in the packed npm artifact", async () => {
	const { stdout } = await execFileAsync(
		"npm",
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{ encoding: "utf8" },
	);
	const packResults = JSON.parse(stdout) as Array<{
		files: Array<{ path: string }>;
	}>;
	const packedPaths = packResults[0]?.files.map((file) => file.path) ?? [];

	expect(packedPaths).toContain("THIRD_PARTY_NOTICES.md");
});
