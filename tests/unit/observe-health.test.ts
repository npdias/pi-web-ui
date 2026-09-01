import { describe, expect, it } from "vitest";
import type { TelemetrySnapshot } from "../../web/src/observe/telemetry-store.js";
import type { TelemetryHealth } from "../../web/src/observe/telemetry-types.js";
import * as observeModule from "../../web/src/observe/ObserveView.js";

const exports = observeModule as unknown as Record<string, unknown>;

describe("Observe background health", () => {
	it("reports real core health while another app tab is selected", () => {
		expect(typeof exports.deriveHealthSummary).toBe("function");
		if (typeof exports.deriveHealthSummary !== "function") return;

		const snapshot: TelemetrySnapshot = {
			records: [],
			events: [],
			gaps: [],
			cursor: null,
			coreGeneration: 0,
			loadedBytes: 0,
			status: "connected",
			preferences: {
				followLive: true,
				timeMode: "wall",
				foldTurns: false,
				foldCalls: false,
			},
		};
		const health: TelemetryHealth = {
			status: "idle",
			counters: {
				accepted: 1,
				rejected: 0,
				persistence_gap: 0,
				dropped: 0,
				torn_lines: 0,
				stale_sources: 0,
				retention_runs: 0,
				retention_deleted_segments: 0,
				retention_deleted_bytes: 0,
				retention_failures: 0,
			},
			memory_tail: { size: 1, capacity: 1_000 },
			sources: [],
		};
		const derive = exports.deriveHealthSummary as (
			active: boolean,
			snapshot: TelemetrySnapshot,
			health: TelemetryHealth | null,
			healthError: boolean,
			sourcesError: boolean,
		) => { readonly label: string; readonly tone: string };

		expect(derive(false, snapshot, health, false, false)).toMatchObject({
			label: "Idle",
			tone: "idle",
		});
	});
});
