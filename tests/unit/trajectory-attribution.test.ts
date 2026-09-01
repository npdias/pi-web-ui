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
	expect(notice).toContain("src/client/layout.ts` -> `web/src/observe/trajectory/project.ts");
	expect(notice).toContain("tests/layout.client.spec.tsx` -> `tests/unit/trajectory-project.test.ts");
	expect(notice).toContain(
		"tests/virtual-rows.client.spec.ts` -> `tests/unit/trajectory-virtual-rows.test.ts",
	);
});

it("records every Task 4 donor adaptation and preserves pinned headers", async () => {
	const notice = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
	const mappings = [
		"src/client/timeline.ts` -> `web/src/observe/trajectory/timeline.ts",
		"src/client/TrajectoryTimeline.tsx` -> `web/src/observe/trajectory/TrajectoryTimeline.tsx",
		"src/client/TrajectoryToolbar.tsx` -> `web/src/observe/trajectory/TrajectoryToolbar.tsx",
		"selected `src/client/TrajectoryTable.tsx` structure -> `web/src/observe/trajectory/TrajectoryLedger.tsx",
		"selected `src/client/TrajectoryTable.tsx` inspector structure -> `web/src/observe/trajectory/TrajectoryInspector.tsx",
		"donor component CSS -> namespaced sections in `web/src/styles.css",
		"tests/views.client.spec.tsx` -> `tests/unit/trajectory-timeline.test.ts",
	];
	for (const mapping of mappings) expect(notice).toContain(mapping);
	expect(notice).not.toContain("Later planned adaptation boundary");

	const adaptedFiles = [
		"web/src/observe/trajectory/timeline.ts",
		"web/src/observe/trajectory/TrajectoryTimeline.tsx",
		"web/src/observe/trajectory/TrajectoryLedger.tsx",
		"web/src/observe/trajectory/TrajectoryInspector.tsx",
		"web/src/observe/trajectory/TrajectoryToolbar.tsx",
		"web/src/styles.css",
		"tests/unit/trajectory-timeline.test.ts",
		"tests/unit/trajectory-components.test.ts",
	];
	for (const path of adaptedFiles) {
		const source = await readFile(path, "utf8");
		expect(source, path).toContain("0a53fb55bea101816fa226bb964ae2bed71c343b");
		expect(source, path).toContain("Copyright (c) 2026 DeepSeek");
	}
});

it("uses a non-color pattern for timeline error status", async () => {
	const styles = await readFile("web/src/styles.css", "utf8");
	const errorRule = styles.match(
		/\.observe-trajectory-timeline__span\[data-error="true"\]\s*\{([^}]*)\}/u,
	)?.[1] ?? "";

	expect(errorRule).toContain("repeating-linear-gradient");
});

it("includes the third-party notice in the packed npm artifact", async () => {
	const npmExecPath = process.env.npm_execpath;
	if (!npmExecPath) {
		throw new Error("npm_execpath is required for package dry-run test");
	}
	const { stdout } = await execFileAsync(
		process.execPath,
		[npmExecPath, "pack", "--dry-run", "--json", "--ignore-scripts"],
		{
			encoding: "utf8",
			env: { ...process.env, PATH: "" },
		},
	);
	const packResults = JSON.parse(stdout) as Array<{
		files: Array<{ path: string }>;
	}>;
	const packedPaths = packResults[0]?.files.map((file) => file.path) ?? [];

	expect(packedPaths).toContain("THIRD_PARTY_NOTICES.md");
});
