/**
 * Ledger, Cell, Turn, and Header structure adapted from DeepSeek Harness:
 * packages/client/ui-trajectory/src/client/TrajectoryTable.tsx
 * packages/client/ui-trajectory/src/client/TrajectoryCell.tsx
 * packages/client/ui-trajectory/src/client/TrajectoryTurn.tsx
 * packages/client/ui-trajectory/src/client/TrajectoryTurnHeader.tsx
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import {
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
} from "react";
import {
	formatDurationMillis,
	type TrajectoryRecord,
	type TrajectoryStep,
	type TrajectoryTurn as TrajectoryTurnModel,
} from "./record.js";
import { trajectoryRecordLiveElapsedMs } from "./timeline.js";
import {
	groupTrajectoryVirtualRows,
	type TrajectoryVirtualRow,
	type VirtualizableTrajectoryRecord,
} from "./virtual-rows.js";

export interface TrajectoryLedgerProps {
	readonly turns: readonly TrajectoryTurnModel[];
	readonly selectedRecordId?: string | null;
	readonly searchMatchRecordIds?: ReadonlySet<string> | null;
	readonly timelineFocusRecordIds?: ReadonlySet<string> | null;
	readonly visibleRecordIds?: ReadonlySet<string> | null;
	readonly foldTurns?: boolean;
	readonly foldCalls?: boolean;
	readonly nowMs?: number;
	readonly isFollowingLive: boolean;
	readonly onRecordSelect?: (recordId: string) => void;
	readonly onFollowingLiveChange?: (following: boolean) => void;
	readonly onEscape?: () => void;
}

interface LedgerEntry extends VirtualizableTrajectoryRecord {
	readonly turn: TrajectoryTurnModel;
	readonly step: TrajectoryStep;
	readonly showTurnHeader: boolean;
	readonly showStepHeader: boolean;
	readonly summaryCount?: number;
}

interface RenderedVirtualItem {
	readonly index: number;
	readonly key: string | number | bigint;
	readonly start: number;
	readonly size: number;
}

function recordTokens(record: TrajectoryRecord): string {
	if (record.kind === "GAP") return "—";
	const input = record.attributes.input_tokens;
	const output = record.attributes.output_tokens;
	const parts: string[] = [];
	if (typeof input === "number" && Number.isFinite(input)) parts.push(`${input.toLocaleString("en-US")} in`);
	if (typeof output === "number" && Number.isFinite(output)) parts.push(`${output.toLocaleString("en-US")} out`);
	return parts.length === 0 ? "—" : parts.join(" · ");
}

function recordState(record: TrajectoryRecord, nowMs: number | undefined): string {
	if (record.kind === "GAP") return "Gap";
	if (record.isOpen) {
		const elapsed = trajectoryRecordLiveElapsedMs(record, nowMs);
		return elapsed === null ? "Open" : `Open · elapsed ${formatDurationMillis(elapsed)}`;
	}
	if (record.closureUnknown) return "Closure unknown";
	if (record.kind === "STALL") return "Possibly stalled";
	if (record.kind === "CANCELLED") return "Cancelled";
	if (record.isError) return "Error";
	return record.state?.replaceAll("_", " ") ?? "Observed";
}

function compareRecord(left: TrajectoryRecord, right: TrajectoryRecord): number {
	if (left.sequence !== right.sequence) return left.sequence < right.sequence ? -1 : 1;
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Resolve one Arrow-key move; stale active IDs enter at requested visible edge. */
export function nextTrajectoryLedgerRecordId(
	records: readonly TrajectoryRecord[],
	activeRecordId: string | null,
	direction: -1 | 1,
): string | null {
	if (records.length === 0) return null;
	const current = records.findIndex((record) => record.id === activeRecordId);
	if (current < 0) {
		return direction > 0 ? records[0]?.id ?? null : records.at(-1)?.id ?? null;
	}
	const next = Math.min(records.length - 1, Math.max(0, current + direction));
	return records[next]?.id ?? null;
}

/** Tail identity changes when an in-place lifecycle record gains new evidence. */
export function trajectoryLedgerTailKey(records: readonly TrajectoryRecord[]): string {
	const tail = records.at(-1);
	if (tail === undefined) return "empty";
	return [
		tail.id,
		tail.sourceEventIds.join(","),
		tail.state ?? "",
		tail.durationMs ?? "unknown",
		tail.isOpen ? "open" : "closed",
		tail.kind === "GAP" ? "gap" : tail.closureUnknown ? "closure-unknown" : "closure-known",
	].join("|");
}

function visibleStepRecords(
	step: TrajectoryStep,
	visibleRecordIds: ReadonlySet<string> | null,
	foldCalls: boolean,
	selectedRecordId: string | null,
	ownerById: ReadonlyMap<string, TrajectoryRecord>,
): readonly TrajectoryRecord[] {
	return [...step.records]
		.sort(compareRecord)
		.filter((record) => visibleRecordIds === null || visibleRecordIds.has(record.id))
		.filter((record) => {
			if (!foldCalls || record.id === selectedRecordId || record.parentRecordId === undefined) {
				return true;
			}
			const owner = ownerById.get(record.parentRecordId);
			return owner === undefined || (owner.kind !== "TOOL" && owner.kind !== "SUBTOOL");
		});
}

function ledgerEntries(
	turns: readonly TrajectoryTurnModel[],
	visibleRecordIds: ReadonlySet<string> | null,
	foldTurns: boolean,
	foldCalls: boolean,
	selectedRecordId: string | null,
): readonly LedgerEntry[] {
	const ownerById = new Map<string, TrajectoryRecord>();
	for (const turn of turns) {
		for (const record of turn.records) ownerById.set(record.id, record);
	}
	const entries: LedgerEntry[] = [];
	for (const turn of [...turns].sort((left, right) => left.firstSequence - right.firstSequence)) {
		const visible = [...turn.records]
			.sort(compareRecord)
			.filter((record) => visibleRecordIds === null || visibleRecordIds.has(record.id));
		if (visible.length === 0) continue;
		if (foldTurns) {
			const representative = visible.find((record) => record.id === selectedRecordId) ?? visible[0];
			const step = turn.steps.find((candidate) => candidate.records.some((record) =>
				record.id === representative?.id)) ?? turn.steps[0];
			if (representative === undefined || step === undefined) continue;
			entries.push({
				record: representative,
				turn,
				step,
				showTurnHeader: true,
				showStepHeader: false,
				collapsedSummaryKind: "turn",
				summaryCount: visible.length,
			});
			continue;
		}
		let firstInTurn = true;
		for (const step of turn.steps) {
			const records = visibleStepRecords(
				step,
				visibleRecordIds,
				foldCalls,
				selectedRecordId,
				ownerById,
			);
			let firstInStep = true;
			for (const record of records) {
				entries.push({
					record,
					turn,
					step,
					showTurnHeader: firstInTurn,
					showStepHeader: firstInStep,
				});
				firstInTurn = false;
				firstInStep = false;
			}
		}
	}
	return entries;
}

function virtualRowHeight(row: TrajectoryVirtualRow<LedgerEntry>): number {
	const first = row.entries[0]?.record;
	const requestBoundaries = row.entries.filter((entry) => entry.record.requestOnly === true).length;
	return row.height + requestBoundaries * 9 +
		(first?.showTurnHeader === true ? 28 : 0) +
		(first?.showStepHeader === true ? 22 : 0);
}

function fallbackVirtualItems(
	rows: readonly TrajectoryVirtualRow<LedgerEntry>[],
): readonly RenderedVirtualItem[] {
	const items: RenderedVirtualItem[] = [];
	let start = 0;
	for (let index = 0; index < Math.min(rows.length, 24); index += 1) {
		const row = rows[index];
		if (row === undefined) continue;
		const size = virtualRowHeight(row);
		items.push({ index, key: row.key, start, size });
		start += size;
	}
	return items;
}

function boundedIdentifier(value: string): string {
	const printable = value.replace(/[\u0000-\u001f\u007f]/gu, "�");
	return printable.length <= 72 ? printable : `${printable.slice(0, 71)}…`;
}

function TrajectoryTurnHeader({ turn }: { readonly turn: TrajectoryTurnModel }) {
	const label = turn.turnId !== undefined
		? `Turn ${boundedIdentifier(turn.turnId)}`
		: turn.traceId !== undefined
			? `Trace ${boundedIdentifier(turn.traceId)}`
			: "Unscoped turn";
	return (
		<div className="observe-trajectory-ledger__turn-header">
			{label}
		</div>
	);
}

function TrajectoryStepHeader({ step }: { readonly step: TrajectoryStep }) {
	const label = step.stepId !== undefined
		? `Step ${boundedIdentifier(step.stepId)}`
		: step.requestId !== undefined
			? `Request ${boundedIdentifier(step.requestId)}`
			: "Unscoped step";
	return (
		<div className="observe-trajectory-ledger__step-header">
			{label}
		</div>
	);
}

function TrajectoryCell({
	entry,
	rowIndex,
	selected,
	active,
	searchMatch,
	timelineFocus,
	nowMs,
	onSelect,
}: {
	readonly entry: LedgerEntry;
	readonly rowIndex: number;
	readonly selected: boolean;
	readonly active: boolean;
	readonly searchMatch: boolean | null;
	readonly timelineFocus: boolean | null;
	readonly nowMs: number | undefined;
	readonly onSelect: (recordId: string) => void;
}) {
	const { record } = entry;
	const id = `observe-trajectory-row-${encodeURIComponent(record.id)}`;
	if (entry.collapsedSummaryKind === "turn") {
		return (
			<div
				id={id}
				className="observe-trajectory-ledger__row observe-trajectory-ledger__row--summary"
				data-record-id={record.id}
				aria-selected={selected}
				aria-rowindex={rowIndex}
				role="row"
				onClick={() => { onSelect(record.id); }}
			>
				<span role="gridcell">#{record.index}</span>
				<span role="gridcell">TURN</span>
				<span role="gridcell">{entry.summaryCount ?? 0} records</span>
				<span role="gridcell">—</span>
				<span role="gridcell">—</span>
				<span role="gridcell">Folded</span>
			</div>
		);
	}
	return (
		<div
			id={id}
			className="observe-trajectory-ledger__row"
			data-record-id={record.id}
			data-kind={record.kind}
			data-active={active ? "true" : undefined}
			data-search-match={searchMatch === null ? undefined : searchMatch ? "true" : "false"}
			data-timeline-focus={timelineFocus === null ? undefined : timelineFocus ? "true" : "false"}
			aria-selected={selected}
			aria-rowindex={rowIndex}
			role="row"
			onClick={() => { onSelect(record.id); }}
		>
			<span role="gridcell">#{record.index}</span>
			<span role="gridcell"><span className="observe-trajectory-ledger__kind">{record.kind}</span></span>
			<span role="gridcell" title={record.summary}>{record.summary}</span>
			<span role="gridcell">{recordTokens(record)}</span>
			<span role="gridcell">{formatDurationMillis(record.durationMs)}</span>
			<span role="gridcell">{recordState(record, nowMs)}</span>
		</div>
	);
}

function TrajectoryTurn({
	row,
	selectedRecordId,
	activeRecordId,
	searchMatchRecordIds,
	timelineFocusRecordIds,
	nowMs,
	onSelect,
}: {
	readonly row: TrajectoryVirtualRow<LedgerEntry>;
	readonly selectedRecordId: string | null;
	readonly activeRecordId: string | null;
	readonly searchMatchRecordIds: ReadonlySet<string> | null;
	readonly timelineFocusRecordIds: ReadonlySet<string> | null;
	readonly nowMs: number | undefined;
	readonly onSelect: (recordId: string) => void;
}) {
	const first = row.entries[0]?.record;
	return (
		<>
			{first?.showTurnHeader === true && <TrajectoryTurnHeader turn={first.turn} />}
			{first?.showStepHeader === true && <TrajectoryStepHeader step={first.step} />}
			{row.entries.map(({ logicalIndex, record: entry }) => (
				<TrajectoryCell
					key={`${logicalIndex}:${entry.record.id}`}
					entry={entry}
					rowIndex={logicalIndex + 2}
					selected={entry.record.id === selectedRecordId}
					active={entry.record.id === activeRecordId}
					searchMatch={searchMatchRecordIds === null
						? null
						: searchMatchRecordIds.has(entry.record.id)}
					timelineFocus={timelineFocusRecordIds === null
						? null
						: timelineFocusRecordIds.has(entry.record.id)}
					nowMs={nowMs}
					onSelect={onSelect}
				/>
			))}
		</>
	);
}

/** Virtualized read-only Turn/Step ledger. */
export const TrajectoryLedger = memo(function TrajectoryLedger({
	turns,
	selectedRecordId = null,
	searchMatchRecordIds = null,
	timelineFocusRecordIds = null,
	visibleRecordIds = null,
	foldTurns = false,
	foldCalls = false,
	nowMs,
	isFollowingLive,
	onRecordSelect,
	onFollowingLiveChange,
	onEscape,
}: TrajectoryLedgerProps) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const entries = useMemo(
		() => ledgerEntries(
			turns,
			visibleRecordIds,
			foldTurns,
			foldCalls,
			selectedRecordId,
		),
		[foldCalls, foldTurns, selectedRecordId, turns, visibleRecordIds],
	);
	const rows = useMemo(() => groupTrajectoryVirtualRows(entries), [entries]);
	const [activeRecordId, setActiveRecordId] = useState<string | null>(
		selectedRecordId ?? entries[0]?.record.id ?? null,
	);
	useEffect(() => {
		if (selectedRecordId !== null) setActiveRecordId(selectedRecordId);
	}, [selectedRecordId]);

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		getItemKey: (index) => rows[index]?.key ?? index,
		estimateSize: (index) => {
			const row = rows[index];
			return row === undefined ? 30 : virtualRowHeight(row);
		},
		initialRect: { width: 1_024, height: 520 },
		overscan: 12,
	});
	const measuredItems = virtualizer.getVirtualItems();
	const virtualItems: readonly RenderedVirtualItem[] = measuredItems.length > 0
		? measuredItems
		: fallbackVirtualItems(rows);
	const fallbackTotal = rows.reduce((total, row) => total + virtualRowHeight(row), 0);
	const totalSize = Math.max(virtualizer.getTotalSize(), fallbackTotal);
	const logicalEntries = useMemo(
		() => rows.flatMap((row) => row.entries.map((entry) => entry.record)),
		[rows],
	);
	const logicalRecords = useMemo(
		() => logicalEntries.map((entry) => entry.record),
		[logicalEntries],
	);
	const resolvedActiveRecordId = logicalRecords.some((record) => record.id === activeRecordId)
		? activeRecordId
		: logicalRecords[0]?.id ?? null;
	const renderedRecordIds = new Set<string>();
	for (const virtualItem of virtualItems) {
		for (const entry of rows[virtualItem.index]?.entries ?? []) {
			renderedRecordIds.add(entry.record.record.id);
		}
	}
	const activeDescendant = resolvedActiveRecordId !== null && renderedRecordIds.has(resolvedActiveRecordId)
		? `observe-trajectory-row-${encodeURIComponent(resolvedActiveRecordId)}`
		: undefined;
	const tailKey = trajectoryLedgerTailKey(logicalRecords);

	useEffect(() => {
		if (activeRecordId !== resolvedActiveRecordId) setActiveRecordId(resolvedActiveRecordId);
	}, [activeRecordId, resolvedActiveRecordId]);

	useEffect(() => {
		if (!isFollowingLive || rows.length === 0) return;
		const frame = requestAnimationFrame(() => {
			virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
		});
		return () => { cancelAnimationFrame(frame); };
	}, [isFollowingLive, rows.length, tailKey, virtualizer]);

	const selectRecord = (recordId: string) => {
		setActiveRecordId(recordId);
		onFollowingLiveChange?.(false);
		onRecordSelect?.(recordId);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onEscape?.();
			return;
		}
		if (logicalEntries.length === 0) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const direction = event.key === "ArrowDown" ? 1 : -1;
			const candidateId = nextTrajectoryLedgerRecordId(
				logicalRecords,
				resolvedActiveRecordId,
				direction,
			);
			const candidate = logicalRecords.find((record) => record.id === candidateId);
			if (candidate === undefined) return;
			setActiveRecordId(candidate.id);
			const rowIndex = rows.findIndex((row) => row.entries.some((entry) =>
				entry.record.record.id === candidate.id));
			if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: "auto" });
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const candidate = logicalRecords.find((record) => record.id === resolvedActiveRecordId);
			if (candidate !== undefined) selectRecord(candidate.id);
		}
	};

	return (
		<div
			className="observe-trajectory-ledger"
			role="grid"
			aria-label="Trajectory ledger"
			aria-rowcount={entries.length + 1}
			aria-colcount={6}
			aria-activedescendant={activeDescendant}
			data-virtualized="true"
			tabIndex={0}
			onKeyDown={onKeyDown}
		>
			<div className="observe-trajectory-ledger__columns" role="row" aria-rowindex={1}>
				{["Index", "Kind", "Summary", "Tokens", "Duration", "State"].map((column) => (
					<span key={column} role="columnheader">{column}</span>
				))}
			</div>
			<div
				ref={scrollRef}
				className="observe-trajectory-ledger__scroll"
				role="rowgroup"
				onScroll={(event) => {
					if (!isFollowingLive) return;
					const element = event.currentTarget;
					const atTail = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
					if (!atTail) onFollowingLiveChange?.(false);
				}}
			>
				{rows.length === 0 ? (
					<p className="observe-trajectory-ledger__empty">No trajectory records match current view.</p>
				) : (
					<div
						className="observe-trajectory-ledger__virtual-space"
						style={{ height: `${totalSize}px` }}
					>
						{virtualItems.map((virtualItem) => {
							const row = rows[virtualItem.index];
							if (row === undefined) return null;
							return (
								<div
									key={virtualItem.key}
									className="observe-trajectory-ledger__virtual-row"
									data-index={virtualItem.index}
									ref={(node) => {
										if (node !== null) virtualizer.measureElement(node);
									}}
									style={{
										transform: `translateY(${virtualItem.start}px)`,
									} as CSSProperties}
								>
									<TrajectoryTurn
										row={row}
										selectedRecordId={selectedRecordId}
										activeRecordId={resolvedActiveRecordId}
										searchMatchRecordIds={searchMatchRecordIds}
										timelineFocusRecordIds={timelineFocusRecordIds}
										nowMs={nowMs}
										onSelect={selectRecord}
									/>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
});
