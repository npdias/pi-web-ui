/**
 * Toolbar structure substantially adapted from DeepSeek Harness:
 * packages/client/ui-trajectory/src/client/TrajectoryToolbar.tsx
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { memo, useEffect, useRef, type KeyboardEvent } from "react";
import type { TrajectoryRecordKind } from "./record.js";
import type { TrajectoryTimelineMode } from "./timeline.js";

export interface TrajectoryFilters {
	readonly kind: TrajectoryRecordKind | "ALL";
	readonly source: string;
	readonly errorsOnly: boolean;
	readonly activeOnly: boolean;
	readonly stalledOnly: boolean;
	readonly traceId: string;
}

export interface TrajectoryToolbarProps {
	readonly mode: TrajectoryTimelineMode;
	readonly foldTurns: boolean;
	readonly foldCalls: boolean;
	readonly searchQuery: string;
	readonly filters: TrajectoryFilters;
	readonly sourceOptions?: readonly string[];
	readonly isFollowingLive: boolean;
	readonly onModeChange?: (mode: TrajectoryTimelineMode) => void;
	readonly onFoldTurnsChange?: (folded: boolean) => void;
	readonly onFoldCallsChange?: (folded: boolean) => void;
	readonly onSearchQueryChange?: (query: string) => void;
	readonly onFiltersChange?: (filters: TrajectoryFilters) => void;
	readonly onJumpToLive?: () => void;
	readonly onEscape?: () => void;
}

const KINDS: readonly TrajectoryRecordKind[] = [
	"SYSTEM",
	"USER",
	"CONTEXT",
	"REQUEST",
	"ASSISTANT",
	"TOOL",
	"SUBTOOL",
	"RESULT",
	"ERROR",
	"CANCELLED",
	"STALL",
	"GAP",
];

function interactiveTarget(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && (
		target.isContentEditable ||
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.tagName === "SELECT"
	);
}

/** Read-only Trajectory controls. Slash focuses search; Escape closes inspection. */
export const TrajectoryToolbar = memo(function TrajectoryToolbar({
	mode,
	foldTurns,
	foldCalls,
	searchQuery,
	filters,
	sourceOptions = [],
	isFollowingLive,
	onModeChange,
	onFoldTurnsChange,
	onFoldCallsChange,
	onSearchQueryChange,
	onFiltersChange,
	onJumpToLive,
	onEscape,
}: TrajectoryToolbarProps) {
	const searchRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (
				event.key !== "/" ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				interactiveTarget(event.target)
			) {
				return;
			}
			event.preventDefault();
			searchRef.current?.focus();
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => { document.removeEventListener("keydown", onDocumentKeyDown); };
	}, []);

	const updateFilter = <K extends keyof TrajectoryFilters>(
		key: K,
		value: TrajectoryFilters[K],
	) => {
		onFiltersChange?.({ ...filters, [key]: value });
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		onEscape?.();
	};

	return (
		<div
			className="observe-trajectory-toolbar"
			role="toolbar"
			aria-label="Trajectory toolbar"
			onKeyDown={onKeyDown}
		>
			<div className="observe-trajectory-toolbar__group">
				<label>
					<span>Time</span>
					<select
						aria-label="Time mode"
						value={mode}
						onChange={(event) => {
							onModeChange?.(event.currentTarget.value as TrajectoryTimelineMode);
						}}
					>
						<option value="wall">Wall clock</option>
						<option value="compressed">Idle compressed</option>
						<option value="sequence">Sequence</option>
					</select>
				</label>
				<button
					type="button"
					aria-pressed={foldTurns}
					onClick={() => { onFoldTurnsChange?.(!foldTurns); }}
				>
					Fold Turns
				</button>
				<button
					type="button"
					aria-pressed={foldCalls}
					onClick={() => { onFoldCallsChange?.(!foldCalls); }}
				>
					Fold calls
				</button>
			</div>

			<div className="observe-trajectory-toolbar__search">
				<input
					ref={searchRef}
					type="search"
					aria-label="Search trajectory"
					placeholder="Search trajectory  /"
					value={searchQuery}
					onChange={(event) => { onSearchQueryChange?.(event.currentTarget.value); }}
				/>
			</div>

			<div className="observe-trajectory-toolbar__filters" aria-label="Trajectory filters">
				<select
					aria-label="Kind filter"
					value={filters.kind}
					onChange={(event) => {
						updateFilter("kind", event.currentTarget.value as TrajectoryFilters["kind"]);
					}}
				>
					<option value="ALL">All kinds</option>
					{KINDS.map((kind) => <option value={kind} key={kind}>{kind}</option>)}
				</select>
				<select
					aria-label="Source filter"
					value={filters.source}
					onChange={(event) => { updateFilter("source", event.currentTarget.value); }}
				>
					<option value="">All sources</option>
					{sourceOptions.map((source) => <option value={source} key={source}>{source}</option>)}
				</select>
				<label><input
					type="checkbox"
					checked={filters.errorsOnly}
					onChange={(event) => { updateFilter("errorsOnly", event.currentTarget.checked); }}
				/>Errors only</label>
				<label><input
					type="checkbox"
					checked={filters.activeOnly}
					onChange={(event) => { updateFilter("activeOnly", event.currentTarget.checked); }}
				/>Active only</label>
				<label><input
					type="checkbox"
					checked={filters.stalledOnly}
					onChange={(event) => { updateFilter("stalledOnly", event.currentTarget.checked); }}
				/>Possibly stalled</label>
				<input
					type="search"
					aria-label="Trace ID filter"
					placeholder="Trace ID"
					value={filters.traceId}
					onChange={(event) => { updateFilter("traceId", event.currentTarget.value); }}
				/>
			</div>

			<button
				type="button"
				className="observe-trajectory-toolbar__live"
				data-following={isFollowingLive ? "true" : "false"}
				disabled={isFollowingLive}
				onClick={onJumpToLive}
			>
				{isFollowingLive ? "Following live" : "Jump to live"}
			</button>
		</div>
	);
});
