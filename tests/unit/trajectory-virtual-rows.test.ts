/**
 * Adapted from DeepSeek Harness:
 * packages/client/ui-trajectory/tests/virtual-rows.client.spec.ts
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { describe, expect, it } from "vitest";
import type { TrajectoryRecord } from "../../web/src/observe/trajectory/record.js";
import {
	groupTrajectoryVirtualRows,
	trajectoryVirtualRecordKey,
	type VirtualizableTrajectoryRecord,
} from "../../web/src/observe/trajectory/virtual-rows.js";

function record(
	index: number,
	overrides: Partial<TrajectoryRecord> = {},
	collapsedSummaryKind?: "turn" | "assistant",
): VirtualizableTrajectoryRecord {
	return {
		record: {
			id: `event:record-${index}`,
			index,
			kind: "ASSISTANT",
			sequence: index,
			summary: `record ${index}`,
			durationMs: 0,
			isOpen: false,
			isError: false,
			sourceEventIds: [`record-${index}`],
			sourceSequences: [index],
			eventKind: "provider.thinking",
			severity: "debug",
			source: {
				robot_id: "robot-01",
				host_id: "host-01",
				component: "pi",
			},
			attributes: {},
			...overrides,
		} as TrajectoryRecord,
		...(collapsedSummaryKind === undefined ? {} : { collapsedSummaryKind }),
	};
}

describe("trajectory virtual rows", () => {
	it("groups zero-height request boundaries with the following content row", () => {
		const first = { ...record(1), requestOnly: true };
		const second = { ...record(2), requestOnly: true };
		const content = record(3);

		expect(groupTrajectoryVirtualRows([first, second, content])).toEqual([
			{
				entries: [
					{ logicalIndex: 0, record: first },
					{ logicalIndex: 1, record: second },
					{ logicalIndex: 2, record: content },
				],
				height: 30,
				key: trajectoryVirtualRecordKey(content),
			},
		]);
	});

	it("retains terminal request-boundary clearance as a measurable row", () => {
		const content = record(1);
		const boundary = { ...record(2), requestOnly: true };
		const rows = groupTrajectoryVirtualRows([content, boundary]);

		expect(rows).toHaveLength(2);
		expect(rows[1]).toEqual({
			entries: [{ logicalIndex: 1, record: boundary }],
			height: 9,
			key: trajectoryVirtualRecordKey(boundary),
		});
	});

	it("uses the rendered collapsed-summary height", () => {
		const summary = record(1, {}, "turn");

		expect(groupTrajectoryVirtualRows([summary])[0]?.height).toBe(20);
	});

	it("keeps an existing row key stable when older history is prepended", () => {
		const existing = record(2, { id: "event:stable" });
		const prepended = record(1);

		const before = groupTrajectoryVirtualRows([existing])[0]?.key;
		const after = groupTrajectoryVirtualRows([prepended, existing])[1]?.key;

		expect(after).toBe(before);
	});

	it("keeps the content key when a request boundary joins its row", () => {
		const content = record(2, { id: "event:stable" });
		const boundary = { ...record(1), requestOnly: true };

		expect(groupTrajectoryVirtualRows([boundary, content])[0]?.key).toBe(
			groupTrajectoryVirtualRows([content])[0]?.key,
		);
	});

	it("distinguishes a folded summary from its source record", () => {
		const source = record(1, { id: "event:stable" });
		const summary = record(1, { id: "event:stable" }, "assistant");

		expect(trajectoryVirtualRecordKey(summary)).not.toBe(
			trajectoryVirtualRecordKey(source),
		);
	});

	it("exposes a DOM-safe semantic key", () => {
		const source = record(1, { id: "event:call with spaces/and?punctuation" });

		expect(trajectoryVirtualRecordKey(source)).toBe(
			"event%3Acall%20with%20spaces%2Fand%3Fpunctuation",
		);
	});

	it("projects 10,000 records without DOM state and retains unique stable keys", () => {
		const records = Array.from({ length: 10_000 }, (_, index) => record(index + 1));
		const rows = groupTrajectoryVirtualRows(records);

		expect(rows).toHaveLength(10_000);
		expect(new Set(rows.map((row) => row.key)).size).toBe(10_000);
		expect(rows[0]?.entries[0]?.logicalIndex).toBe(0);
		expect(rows.at(-1)?.entries[0]?.logicalIndex).toBe(9_999);
	});
});
