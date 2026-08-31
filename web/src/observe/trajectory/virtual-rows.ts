/**
 * Adapted from DeepSeek Harness:
 * packages/client/ui-trajectory/src/client/trajectory-virtual-rows.ts
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { trajectoryRecordId, type TrajectoryRecord } from "./record.js";

const CONTENT_ROW_HEIGHT = 30;
const COLLAPSED_SUMMARY_HEIGHT = 20;
const TERMINAL_BOUNDARY_HEIGHT = 9;

/** Minimal record shape required by the trajectory virtual-row projection. */
export interface VirtualizableTrajectoryRecord {
	readonly record: TrajectoryRecord;
	readonly requestOnly?: boolean;
	readonly collapsedSummaryKind?: "turn" | "assistant";
}

/** One logical record retained inside a measurable virtual row. */
export interface TrajectoryVirtualRowEntry<T extends VirtualizableTrajectoryRecord> {
	readonly logicalIndex: number;
	readonly record: T;
}

/** One virtualizer item, which may carry separator-only request boundaries. */
export interface TrajectoryVirtualRow<T extends VirtualizableTrajectoryRecord> {
	readonly entries: readonly TrajectoryVirtualRowEntry<T>[];
	readonly height: number;
	readonly key: string;
}

/** DOM-safe identity shared by React, virtualizer, and scroll contracts. */
export function trajectoryVirtualRecordKey(
	record: VirtualizableTrajectoryRecord,
): string {
	const identity = encodeURIComponent(trajectoryRecordId(record.record));
	return record.collapsedSummaryKind === undefined
		? identity
		: `${identity}\u0000summary\u0000${record.collapsedSummaryKind}`;
}

/**
 * Attach separator-only records to next content row. Terminal separators keep
 * their marker clearance as a standalone measurable item.
 */
export function groupTrajectoryVirtualRows<T extends VirtualizableTrajectoryRecord>(
	records: readonly T[],
): readonly TrajectoryVirtualRow<T>[] {
	const rows: TrajectoryVirtualRow<T>[] = [];
	let pending: TrajectoryVirtualRowEntry<T>[] = [];

	for (const [logicalIndex, record] of records.entries()) {
		const entry = { logicalIndex, record };
		if (record.requestOnly === true) {
			pending.push(entry);
			continue;
		}
		const entries = [...pending, entry];
		pending = [];
		rows.push({
			entries,
			height:
				record.collapsedSummaryKind === undefined
					? CONTENT_ROW_HEIGHT
					: COLLAPSED_SUMMARY_HEIGHT,
			key: trajectoryVirtualRecordKey(record),
		});
	}

	if (pending.length > 0) {
		rows.push({
			entries: pending,
			height: TERMINAL_BOUNDARY_HEIGHT,
			key: pending
				.map((candidate) => trajectoryVirtualRecordKey(candidate.record))
				.join("|"),
		});
	}

	return rows;
}
