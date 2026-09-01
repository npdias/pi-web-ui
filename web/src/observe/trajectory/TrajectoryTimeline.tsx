/**
 * Substantially adapted from DeepSeek Harness:
 * packages/client/ui-trajectory/src/client/TrajectoryTimeline.tsx
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import {
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent,
} from "react";
import { formatDurationMillis, type TrajectoryTurn } from "./record.js";
import {
	boundTrajectoryTimelineForRender,
	deriveTrajectoryTimeline,
	TRAJECTORY_TIMELINE_LANES,
	trajectoryHasOpenRecords,
	type TrajectoryTimelineLane,
	type TrajectoryTimelineMode,
	type TrajectoryTimelineRenderSpan,
	type TrajectoryTimeRange,
} from "./timeline.js";

const MINIMUM_DRAG_PX = 3;
const MINIMUM_ZOOM_OPERATIONS = 4;
const LANE_LABELS: Readonly<Record<TrajectoryTimelineLane, string>> = {
	model: "Model / Agent",
	tools: "Tools",
	services: "Services",
	host: "Host",
};
const LANE_INDEX: Readonly<Record<TrajectoryTimelineLane, number>> = {
	model: 0,
	tools: 1,
	services: 2,
	host: 3,
};

interface FractionRange {
	readonly start: number;
	readonly end: number;
}

interface DragGesture {
	readonly pointerId: number;
	readonly anchorTime: number;
	readonly anchorClientX: number;
	readonly recordId: string | null;
}

interface PanGesture {
	readonly pointerId: number;
	readonly anchorClientX: number;
	readonly anchorStart: number;
	moved: boolean;
}

/** Props for fixed overview above Trajectory ledger. */
export interface TrajectoryTimelineProps {
	readonly turns: readonly TrajectoryTurn[];
	readonly mode?: TrajectoryTimelineMode;
	readonly range?: TrajectoryTimeRange | null;
	readonly selectedRecordId?: string | null;
	readonly searchMatchRecordIds?: ReadonlySet<string> | null;
	readonly nowMs?: number;
	readonly onRangeChange?: (range: TrajectoryTimeRange | null) => void;
	readonly onRecordSelect?: (recordId: string) => void;
	readonly onRecordFocus?: (recordId: string) => void;
}

function orderedRange(left: number, right: number): FractionRange {
	return left <= right ? { start: left, end: right } : { start: right, end: left };
}

function clampFraction(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function centeredRange(
	center: number,
	width: number,
	minimum: number,
	maximum: number,
): FractionRange {
	const clampedWidth = Math.min(maximum - minimum, Math.max(0, width));
	const start = Math.min(
		Math.max(center - clampedWidth / 2, minimum),
		maximum - clampedWidth,
	);
	return { start, end: start + clampedWidth };
}

function rangeFraction(
	range: TrajectoryTimeRange,
	start: number,
	duration: number,
	minimum: number,
	maximum: number,
): FractionRange {
	const bounded = orderedRange(
		Math.min(maximum, Math.max(minimum, range.start)),
		Math.min(maximum, Math.max(minimum, range.end)),
	);
	return {
		start: (bounded.start - start) / duration,
		end: (bounded.end - start) / duration,
	};
}

function useDisplayNow(nowMs: number | undefined, hasOpenRecords: boolean): number {
	const [liveNow, setLiveNow] = useState(() => nowMs ?? Date.now());
	useEffect(() => {
		if (nowMs !== undefined) {
			setLiveNow(nowMs);
			return;
		}
		if (!hasOpenRecords) return;
		const timer = globalThis.setInterval(() => { setLiveNow(Date.now()); }, 1_000);
		return () => { globalThis.clearInterval(timer); };
	}, [hasOpenRecords, nowMs]);
	return nowMs ?? liveNow;
}

function timelineSpanLabel(span: TrajectoryTimelineRenderSpan): string {
	const state = span.isOpen
		? "Open"
		: span.closureUnknown
			? "Closure unknown"
			: span.isStalled
				? "Possibly stalled"
				: span.isCancelled
					? "Cancelled"
					: span.isError
						? "Error"
						: "Observed";
	const liveElapsed = span.liveElapsedMs === null
		? ""
		: `. Live elapsed ${formatDurationMillis(span.liveElapsedMs)}`;
	return `${span.kind}: ${span.label}. ${state}. Duration ${formatDurationMillis(span.durationMs)}${liveElapsed}`;
}

function LaneLabels() {
	return (
		<div className="observe-trajectory-timeline__labels" aria-label="Timeline lanes">
			{TRAJECTORY_TIMELINE_LANES.map((lane) => (
				<span key={lane} data-lane-label={lane}>{LANE_LABELS[lane]}</span>
			))}
		</div>
	);
}

/** Four-lane overview with stable-ID selection, range focus, wheel zoom, and pan. */
export const TrajectoryTimeline = memo(function TrajectoryTimeline({
	turns,
	mode = "wall",
	range = null,
	selectedRecordId = null,
	searchMatchRecordIds = null,
	nowMs,
	onRangeChange,
	onRecordSelect,
	onRecordFocus,
}: TrajectoryTimelineProps) {
	const hasOpenRecords = useMemo(() => trajectoryHasOpenRecords(turns), [turns]);
	const displayNow = useDisplayNow(nowMs, hasOpenRecords);
	const model = useMemo(
		() => deriveTrajectoryTimeline(turns, mode, { nowMs: displayNow }),
		[displayNow, mode, turns],
	);
	const dragRef = useRef<DragGesture | null>(null);
	const panRef = useRef<PanGesture | null>(null);
	const rootRef = useRef<HTMLElement | null>(null);
	const trackRef = useRef<HTMLDivElement | null>(null);
	const [draft, setDraft] = useState<TrajectoryTimeRange | null>(null);
	const [viewport, setViewport] = useState<TrajectoryTimeRange | null>(null);
	const [panning, setPanning] = useState(false);
	const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
	const itemRefs = useRef(new Map<string, HTMLButtonElement>());

	useEffect(() => {
		if (
			model !== null &&
			range !== null &&
			(range.end < model.start || range.start > model.end)
		) {
			onRangeChange?.(null);
		}
	}, [model, onRangeChange, range]);

	useEffect(() => {
		if (model === null) return;
		setViewport((current) =>
			current !== null && (current.end < model.start || current.start > model.end)
				? null
				: current);
	}, [model]);

	useEffect(() => {
		if (model === null || selectedRecordId === null) return;
		const selectedSpan = model.spans.find((span) => span.recordId === selectedRecordId);
		if (selectedSpan === undefined) return;
		setViewport((current) => {
			if (current === null) return current;
			if (selectedSpan.end >= current.start && selectedSpan.start <= current.end) return current;
			const duration = Math.max(1, current.end - current.start);
			const desiredStart = selectedSpan.end <= current.start
				? selectedSpan.start
				: selectedSpan.end - duration;
			const nextStart = Math.min(
				Math.max(desiredStart, model.start),
				Math.max(model.start, model.end - duration),
			);
			return nextStart === current.start
				? current
				: { start: nextStart, end: nextStart + duration };
		});
	}, [model, selectedRecordId]);

	const fullDuration = Math.max(1, (model?.end ?? 0) - (model?.start ?? 0));
	const viewportDuration = Math.min(
		fullDuration,
		Math.max(1, (viewport?.end ?? 0) - (viewport?.start ?? 0)),
	);
	const viewportStart = model === null || viewport === null
		? model?.start ?? 0
		: Math.min(
			Math.max(viewport.start, model.start),
			model.end - viewportDuration,
		);
	const domainDuration = viewport === null ? fullDuration : viewportDuration;
	const domainStart = viewport === null ? model?.start ?? 0 : viewportStart;
	const domainStyle = model === null
		? undefined
		: {
			"--observe-timeline-domain-left":
				`${-(domainStart - model.start) / domainDuration * 100}%`,
			"--observe-timeline-domain-width": `${fullDuration / domainDuration * 100}%`,
		} as CSSProperties;
	const committed = model === null || range === null
		? null
		: rangeFraction(range, domainStart, domainDuration, model.start, model.end);
	const draftFraction = model === null || draft === null
		? null
		: rangeFraction(draft, domainStart, domainDuration, model.start, model.end);
	const visibleRange = draftFraction ?? committed;
	const activeRange = draft ?? range;
	const preserveRecordIds = useMemo(() => {
		const ids = new Set<string>();
		if (selectedRecordId !== null) ids.add(selectedRecordId);
		for (const span of model?.spans ?? []) {
			if (span.isOpen) ids.add(span.recordId);
		}
		return ids;
	}, [model, selectedRecordId]);
	const renderModel = useMemo(
		() => boundTrajectoryTimelineForRender(model, {
			maxItems: 512,
			...(selectedRecordId === null ? {} : { primaryRecordId: selectedRecordId }),
			preserveRecordIds,
		}),
		[model, preserveRecordIds, selectedRecordId],
	);
	const renderSpans = renderModel.spans;
	const interactiveItems = useMemo(() => [
		...renderModel.gapBands.map((gap) => ({
			id: gap.id,
			start: gap.start,
			lane: -1,
			recordIds: gap.recordIds,
		})),
		...renderSpans.map((span) => ({
			id: span.id,
			start: span.start,
			lane: LANE_INDEX[span.lane],
			recordIds: span.recordIds,
		})),
	].sort((left, right) => left.start - right.start || left.lane - right.lane), [renderModel, renderSpans]);
	const selectedItemId = selectedRecordId === null
		? null
		: interactiveItems.find((item) => item.recordIds.includes(selectedRecordId))?.id ?? null;
	const effectiveFocusedItemId = focusedItemId !== null &&
		interactiveItems.some((item) => item.id === focusedItemId)
		? focusedItemId
		: selectedItemId ?? interactiveItems[0]?.id ?? null;
	useEffect(() => {
		if (selectedItemId !== null) setFocusedItemId(selectedItemId);
	}, [selectedItemId]);
	const moveItemFocus = (currentId: string, direction: -1 | 1) => {
		const current = interactiveItems.findIndex((item) => item.id === currentId);
		const next = Math.min(
			interactiveItems.length - 1,
			Math.max(0, (current < 0 ? direction > 0 ? -1 : interactiveItems.length : current) + direction),
		);
		const nextId = interactiveItems[next]?.id;
		if (nextId === undefined) return;
		setFocusedItemId(nextId);
		requestAnimationFrame(() => { itemRefs.current.get(nextId)?.focus(); });
	};
	const onItemKeyDown = (event: KeyboardEvent<HTMLButtonElement>, itemId: string) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		moveItemFocus(itemId, event.key === "ArrowRight" ? 1 : -1);
	};
	const registerItem = (itemId: string, node: HTMLButtonElement | null) => {
		if (node === null) itemRefs.current.delete(itemId);
		else itemRefs.current.set(itemId, node);
	};

	useEffect(() => {
		const root = rootRef.current;
		if (root === null) return;
		const onWheel = (event: globalThis.WheelEvent): void => {
			event.preventDefault();
			const track = trackRef.current;
			if (track === null || model === null) return;
			const rect = track.getBoundingClientRect();
			const anchorFraction = clampFraction(
				(event.clientX - rect.left) / Math.max(1, rect.width),
			);
			const minimum = Math.min(
				mode === "sequence" ? MINIMUM_ZOOM_OPERATIONS : 20,
				fullDuration,
			);
			const nextDuration = Math.min(
				fullDuration,
				Math.max(minimum, domainDuration * Math.exp(event.deltaY * 0.0015)),
			);
			if (nextDuration >= fullDuration * 0.999) {
				setViewport(null);
				return;
			}
			const anchorTime = domainStart + anchorFraction * domainDuration;
			const nextStart = Math.min(
				Math.max(anchorTime - anchorFraction * nextDuration, model.start),
				model.end - nextDuration,
			);
			setViewport({ start: nextStart, end: nextStart + nextDuration });
		};
		root.addEventListener("wheel", onWheel, { passive: false });
		return () => { root.removeEventListener("wheel", onWheel); };
	}, [domainDuration, domainStart, fullDuration, mode, model]);

	if (model === null) {
		return (
			<section
				ref={rootRef}
				className="observe-trajectory-timeline"
				aria-label="Trajectory timeline"
				data-mode={mode}
			>
				<LaneLabels />
				<div className="observe-trajectory-timeline__empty">No timing data · —</div>
			</section>
		);
	}

	const minimumSelectionDuration = Math.min(
		domainDuration,
		fullDuration / Math.max(1, model.spans.length + model.gapBands.length),
	);
	const fractionAt = (event: PointerEvent<HTMLDivElement>): number => {
		const rect = event.currentTarget.getBoundingClientRect();
		return clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
	};
	const recordIdAt = (event: PointerEvent<HTMLDivElement>): string | null => {
		const target = event.target instanceof HTMLElement ? event.target : null;
		return target?.closest<HTMLElement>("[data-record-id]")?.dataset.recordId ?? null;
	};
	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button === 2) {
			panRef.current = {
				pointerId: event.pointerId,
				anchorClientX: event.clientX,
				anchorStart: domainStart,
				moved: false,
			};
			setPanning(true);
			event.currentTarget.setPointerCapture?.(event.pointerId);
			return;
		}
		if (event.button !== 0) return;
		const anchorTime = domainStart + fractionAt(event) * domainDuration;
		dragRef.current = {
			pointerId: event.pointerId,
			anchorTime,
			anchorClientX: event.clientX,
			recordId: recordIdAt(event),
		};
		event.currentTarget.setPointerCapture?.(event.pointerId);
		setDraft({ start: anchorTime, end: anchorTime });
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const pan = panRef.current;
		if (pan !== null && pan.pointerId === event.pointerId) {
			if (Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX) pan.moved = true;
			if (viewport === null) return;
			const rect = event.currentTarget.getBoundingClientRect();
			const delta = (event.clientX - pan.anchorClientX) / Math.max(1, rect.width);
			const nextStart = Math.min(
				Math.max(pan.anchorStart - delta * domainDuration, model.start),
				model.end - domainDuration,
			);
			setViewport({ start: nextStart, end: nextStart + domainDuration });
			return;
		}
		const drag = dragRef.current;
		if (drag === null || drag.pointerId !== event.pointerId) return;
		const pointTime = domainStart + fractionAt(event) * domainDuration;
		setDraft(orderedRange(drag.anchorTime, pointTime));
	};
	const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
		const pan = panRef.current;
		if (pan !== null && pan.pointerId === event.pointerId) {
			panRef.current = null;
			setPanning(false);
			if (!pan.moved) onRangeChange?.(null);
			return;
		}
		const drag = dragRef.current;
		if (drag === null || drag.pointerId !== event.pointerId) return;
		const pointTime = domainStart + fractionAt(event) * domainDuration;
		const selected = orderedRange(drag.anchorTime, pointTime);
		dragRef.current = null;
		setDraft(null);
		const click = Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX;
		if (click && drag.recordId !== null) {
			onRangeChange?.(null);
			onRecordSelect?.(drag.recordId);
			return;
		}
		const committedRange = selected.end - selected.start < minimumSelectionDuration
			? centeredRange(
				click ? selected.start : (selected.start + selected.end) / 2,
				minimumSelectionDuration,
				model.start,
				model.end,
			)
			: selected;
		onRangeChange?.(committedRange);
		if (click && model.spans.length > 0) {
			const nearest = model.spans.reduce((candidate, span) => {
				const candidateDistance = Math.min(
					Math.abs(selected.start - candidate.start),
					Math.abs(selected.start - candidate.end),
				);
				const spanDistance = Math.min(
					Math.abs(selected.start - span.start),
					Math.abs(selected.start - span.end),
				);
				return spanDistance < candidateDistance ? span : candidate;
			});
			onRecordFocus?.(nearest.recordId);
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		onRangeChange?.(null);
		setViewport(null);
	};
	const onPointerCancel = () => {
		dragRef.current = null;
		panRef.current = null;
		setDraft(null);
		setPanning(false);
	};

	return (
		<section
			ref={rootRef}
			className="observe-trajectory-timeline"
			aria-label="Trajectory timeline"
			data-mode={mode}
		>
			<LaneLabels />
			<div
				ref={trackRef}
				className="observe-trajectory-timeline__track"
				aria-label="Timeline overview; drag to focus events, wheel to zoom"
				data-panning={panning ? "true" : undefined}
				tabIndex={0}
				onKeyDown={onKeyDown}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerEnd}
				onPointerCancel={onPointerCancel}
				onDoubleClick={() => {
					onRangeChange?.(null);
					setViewport(null);
				}}
				onContextMenu={(event) => { event.preventDefault(); }}
			>
				{visibleRange !== null && (
					<div
						className="observe-trajectory-timeline__selection"
						data-dragging={draft === null ? undefined : "true"}
						aria-hidden="true"
						style={{
							"--observe-timeline-selection-left": `${visibleRange.start * 100}%`,
							"--observe-timeline-selection-width":
								`${(visibleRange.end - visibleRange.start) * 100}%`,
						} as CSSProperties}
					/>
				)}
				<div
					className="observe-trajectory-timeline__domain"
					data-timeline-domain
					style={domainStyle}
				>
					{renderModel.turnBoundaries.map((boundary) => (
						<span
							aria-hidden="true"
							className="observe-trajectory-timeline__turn-boundary"
							data-turn-id={boundary.turnId}
							key={boundary.turnId}
							style={{
								"--observe-timeline-turn-left":
									`${(boundary.time - model.start) / fullDuration * 100}%`,
							} as CSSProperties}
						/>
					))}
					{renderModel.gapBands.map((gap) => {
						const left = (gap.start - model.start) / fullDuration * 100;
						const width = (gap.end - gap.start) / fullDuration * 100;
						const itemId = gap.id;
						const recordId = gap.count === 1 ? gap.recordIds[0] ?? null : null;
						const current = selectedRecordId !== null && gap.recordIds.includes(selectedRecordId);
						const label = gap.count === 1
							? gap.label
							: `${gap.label}. Activate to focus this range.`;
						return (
							<button
								type="button"
								aria-label={label}
								aria-pressed={current}
								className="observe-trajectory-timeline__gap"
								data-timeline-item-id={itemId}
								data-record-id={recordId ?? undefined}
								data-gap-id={recordId ?? undefined}
								data-aggregate-count={gap.count > 1 ? gap.count : undefined}
								data-current={current ? "true" : undefined}
								key={gap.id}
								ref={(node) => { registerItem(itemId, node); }}
								tabIndex={effectiveFocusedItemId === itemId ? 0 : -1}
								onPointerDown={(event) => { event.stopPropagation(); }}
								onKeyDown={(event) => { onItemKeyDown(event, itemId); }}
								onClick={() => {
									if (recordId !== null) onRecordSelect?.(recordId);
									else onRangeChange?.({ start: gap.start, end: gap.end });
								}}
								style={{
									"--observe-timeline-span-left": `${left}%`,
									"--observe-timeline-span-width": `${width}%`,
								} as CSSProperties}
							/>
						);
					})}
					{renderSpans.map((span) => {
						const left = (span.start - model.start) / fullDuration * 100;
						const width = (span.end - span.start) / fullDuration * 100;
						const selected = activeRange !== null &&
							span.start <= activeRange.end && span.end >= activeRange.start;
						const recordId = span.count === 1 ? span.recordIds[0] ?? null : null;
						const current = selectedRecordId !== null && span.recordIds.includes(selectedRecordId);
						const aggregateStatuses = [
							span.isError ? "Contains error." : null,
							span.isCancelled ? "Contains cancellation." : null,
							span.isStalled ? "Contains possible stall." : null,
						].filter((value): value is string => value !== null).join(" ");
						const label = span.count === 1
							? timelineSpanLabel(span)
							: `${span.label}. ${aggregateStatuses} Activate to focus this range.`;
						return (
							<button
								type="button"
								aria-label={label}
								aria-pressed={current}
								className="observe-trajectory-timeline__span"
								data-timeline-item-id={span.id}
								data-record-id={recordId ?? undefined}
								data-aggregate-count={span.count > 1 ? span.count : undefined}
								data-lane={span.lane}
								data-kind={span.kind}
								data-current={current ? "true" : undefined}
								data-search-match={searchMatchRecordIds === null
									? undefined
									: span.recordIds.some((id) => searchMatchRecordIds.has(id)) ? "true" : "false"}
								data-selected={selected ? "true" : undefined}
								data-error={span.isError ? "true" : undefined}
								data-cancelled={span.isCancelled ? "true" : undefined}
								data-stalled={span.isStalled ? "true" : undefined}
								data-open={span.isOpen ? "true" : undefined}
								data-closure-unknown={span.closureUnknown ? "true" : undefined}
								key={span.id}
								ref={(node) => { registerItem(span.id, node); }}
								tabIndex={effectiveFocusedItemId === span.id ? 0 : -1}
								onPointerDown={(event) => { event.stopPropagation(); }}
								onKeyDown={(event) => { onItemKeyDown(event, span.id); }}
								onClick={() => {
									if (recordId !== null) onRecordSelect?.(recordId);
									else onRangeChange?.({ start: span.start, end: span.end });
								}}
								style={{
									"--observe-timeline-span-left": `${left}%`,
									"--observe-timeline-span-width": `${width}%`,
									"--observe-timeline-span-lane": LANE_INDEX[span.lane],
								} as CSSProperties}
							>
								<span className="observe-trajectory-timeline__sr-only">
									{formatDurationMillis(span.durationMs)}
								</span>
							</button>
						);
					})}
				</div>
			</div>
			{model.unknownTimingRecordIds.length > 0 && (
				<p className="observe-trajectory-timeline__unknown">
					{model.unknownTimingRecordIds.length} record{model.unknownTimingRecordIds.length === 1 ? "" : "s"} lack timing · —
				</p>
			)}
		</section>
	);
});
