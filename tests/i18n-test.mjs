/* English-only UI smoke: boots the compiled server, opens the built UI, verifies
 * every user starts in English and no language selector is rendered.
 * Run:  npm run build && node i18n-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-ui-"));
process.env.PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;

const server = spawn(
	process.execPath,
	[join(new URL("..", import.meta.url).pathname, "dist", "server", "index.js")],
	{
		cwd: new URL("..", import.meta.url).pathname,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	},
);
server.on("error", (e) => console.error("[srv spawn error]", e));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}

async function main() {
	await waitServer();
	const browser = await chromium.launch({
		executablePath:
			CHROME_PATH,
	});
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));

	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".boot-wait", { state: "hidden", timeout: 60000 });
	await page.waitForSelector(".topbar", { timeout: 5000 });
	console.log("app booted");

	// -- English is mandatory -------------------------------------------------
	await page.waitForSelector(".brand", { timeout: 5000 });
	const enNewChat = await page.locator(".topbar .newchat span").textContent();
	check(`UI starts in English ("New chat")`, enNewChat?.includes("New chat"));
	const enTab = await page
		.locator(".view-switch button span")
		.first()
		.textContent();
	check(`view tab shows "Chat"`, enTab?.includes("Chat"));
	check(
		"no language selector is rendered",
		(await page.locator("text=Language").count()) === 0 &&
			(await page.locator("text=中文").count()) === 0,
	);

	// -- reload cannot restore a saved non-English locale ---------------------
	await page.evaluate(() => localStorage.setItem("pi-web-ui:lang", "zh"));
	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 15000 });
	await sleep(500);
	const enAfterReload = await page
		.locator(".topbar .newchat span")
		.textContent();
	check(`saved Chinese locale is ignored after reload`, enAfterReload?.includes("New chat"));
	check(
		"desktop has no upstream GitHub link or update control",
		(await page.locator('a[href*="xing-shuyin/pi-web-ui"]').count()) === 0 &&
			(await page.locator('[title*="update" i]').count()) === 0,
	);

	// Settings retain UI Plugins and Presets, omit Goal Review.
	await page.locator('button[title="Settings"]').click();
	await page.waitForSelector(".settings-modal", { timeout: 5000 });
	check(
		"Goal Review is absent from settings",
		(await page.locator(".settings-tab", { hasText: "Goal review" }).count()) === 0,
	);
	check(
		"goal-review controls are absent from chat",
		(await page.locator(".goalbar").count()) === 0,
	);
	const uiPluginsTab = page.locator(".settings-tab", { hasText: "UI plugins" });
	const presetsTab = page.locator(".settings-tab", { hasText: "Presets" });
	check("UI Plugins settings tab remains visible", (await uiPluginsTab.count()) === 1);
	check("Presets settings tab remains visible", (await presetsTab.count()) === 1);
	await uiPluginsTab.click();
	check("UI Plugins tab opens", await uiPluginsTab.evaluate((el) => el.classList.contains("active")));
	await presetsTab.click();
	check("Presets tab opens", await presetsTab.evaluate((el) => el.classList.contains("active")));
	const visionTab = page.locator(".settings-tab", { hasText: "Vision bridge" });
	await visionTab.click();
	const visionSwitch = page.locator(".set-switch").last();
	check(
		"Vision Bridge defaults off for a fresh client",
		!(await visionSwitch.evaluate((el) => el.classList.contains("on"))),
	);
	await page.locator(".modal-close").click();

	// Mobile More menu also excludes language, update, and upstream links.
	await page.setViewportSize({ width: 390, height: 844 });
	const more = page.locator(".topbar-more button.chip");
	await more.click();
	await page.waitForSelector(".topbar-more .dd-menu", { timeout: 3000 });
	const mobileMenu = page.locator(".topbar-more .dd-menu");
	const mobileMenuText = await mobileMenu.textContent();
	check(
		"mobile More has no language or update controls",
		!mobileMenuText?.includes("Language") && !mobileMenuText?.includes("Update"),
	);
	check(
		"mobile More has no upstream GitHub link",
		(await mobileMenu.locator('a[href*="xing-shuyin/pi-web-ui"]').count()) === 0,
	);

	const errs = consoleErrors.filter(
		(e) => !e.includes("favicon") && !e.includes("ResizeObserver"),
	);
	check(`no console errors (${errs.length})`, errs.length === 0);

	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
