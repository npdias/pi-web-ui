/**
 * Adapted from DeepSeek Harness:
 * packages/client/ui-trajectory/src/client/trajectory-record.ts
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import type {
	TelemetryCorrelation,
	TelemetryEvent,
	TelemetryJson,
	TelemetryReplayGap,
	TelemetrySeverity,
	TelemetrySource,
} from "../telemetry-types.js";

/** Closed display vocabulary. Current projection emits only supported Pi adapter kinds. */
export type TrajectoryRecordKind =
	| "SYSTEM"
	| "USER"
	| "CONTEXT"
	| "REQUEST"
	| "ASSISTANT"
	| "TOOL"
	| "SUBTOOL"
	| "RESULT"
	| "ERROR"
	| "CANCELLED"
	| "STALL"
	| "GAP";

interface TrajectoryRecordBase {
	/** Identity derived from source evidence, correlated tool lifecycle, or gap tuple. */
	readonly id: string;
	/** 1-based display position in server sequence order. */
	readonly index: number;
	readonly kind: TrajectoryRecordKind;
	/** First source sequence represented by this row. */
	readonly sequence: number;
	/** Source-scoped lifecycle attempt ordinal. Absent for gaps/non-lifecycle events. */
	readonly attemptOrdinal?: number;
	readonly summary: string;
	readonly summaryTruncated?: boolean;
	/** Recorded duration only. `null` means unknown, never zero-filled. */
	readonly durationMs: number | null;
	/** True only while evidence confirms the span remains open. Gap-unknown closure is false. */
	readonly isOpen: boolean;
	readonly isError: boolean;
	readonly sourceEventIds: readonly string[];
	readonly sourceSequences: readonly number[];
	readonly eventKind?: string;
	readonly phase?: string;
	readonly state?: string;
	readonly turnId?: string;
	readonly stepId?: string;
	readonly requestId?: string;
	readonly traceId?: string;
	readonly toolCallId?: string;
	readonly parentRecordId?: string;
	readonly startedAt?: string;
	readonly endedAt?: string;
	readonly inputDetail?: string;
	readonly outputDetail?: string;
	readonly thinkingDetail?: string;
	readonly schemaDetail?: string;
	readonly result?: string;
	readonly toolName?: string;
}

/** One row projected from one normalized event or one paired tool lifecycle. */
export interface TelemetryTrajectoryRecord extends TrajectoryRecordBase {
	readonly kind: Exclude<TrajectoryRecordKind, "GAP">;
	readonly eventKind: string;
	readonly severity: TelemetrySeverity;
	readonly source: TelemetrySource;
	readonly correlation?: TelemetryCorrelation;
	readonly attributes: Readonly<Record<string, TelemetryJson>>;
	/** False until an upstream complete-history boundary makes global count provable. */
	readonly attemptOrdinalKnown: boolean;
	/** A replay gap may contain the missing terminal, so active/closed state is unknown. */
	readonly closureUnknown: boolean;
	/** At least one replay gap intersects the observed lifecycle interval. */
	readonly gapTainted: boolean;
	readonly gapEvidence: readonly TelemetryReplayGap[];
	/** Two or more distinct terminal envelopes exist without an intervening start. */
	readonly terminalConflict: boolean;
	readonly unmatchedTerminal: boolean;
	readonly diagnostic: boolean;
	/** Normalized source envelopes retained in server sequence order; payloads stay references. */
	readonly sourceEnvelopes: readonly TelemetryEvent[];
	readonly privacyClass?: string;
	readonly privacyIncomplete: boolean;
	readonly payloadRefs: readonly string[];
	readonly redaction?: Readonly<Record<string, TelemetryJson>>;
}

/** Explicit lost/expired replay interval. It remains visible in the ledger. */
export interface GapTrajectoryRecord extends TrajectoryRecordBase {
	readonly kind: "GAP";
	readonly gap: TelemetryReplayGap;
}

export type TrajectoryRecord = TelemetryTrajectoryRecord | GapTrajectoryRecord;

/** One Step grouping. IDs come only from normalized correlation fields. */
export interface TrajectoryStep {
	readonly id: string;
	readonly stepId?: string;
	readonly requestId?: string;
	readonly firstSequence: number;
	readonly records: readonly TrajectoryRecord[];
}

/** One Turn grouping, plus an explicit unscoped bucket when no Turn ID exists. */
export interface TrajectoryTurn {
	readonly id: string;
	readonly turnId?: string;
	readonly traceId?: string;
	readonly firstSequence: number;
	readonly steps: readonly TrajectoryStep[];
	readonly records: readonly TrajectoryRecord[];
}

/** Input accepted directly from a store snapshot or from normalized events. */
export type TrajectoryProjectionInput =
	| TelemetryEvent
	| { readonly type: "event"; readonly event: TelemetryEvent }
	| { readonly type: "gap"; readonly gap: TelemetryReplayGap };

/** Stable row identity. No display-index fallback is allowed. */
export function trajectoryRecordId(record: TrajectoryRecord): string {
	return record.id;
}

/** Format recorded milliseconds. Unknown timing stays an em dash. */
export function formatDurationMillis(milliseconds: number | null): string {
	if (
		milliseconds === null ||
		!Number.isFinite(milliseconds) ||
		milliseconds < 0
	) {
		return "—";
	}
	const integer = String(Math.round(milliseconds));
	return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ms`;
}

/** Format recorded seconds through the shared millisecond formatter. */
export function formatElapsedSeconds(seconds: number | null): string {
	return formatDurationMillis(seconds === null ? null : seconds * 1_000);
}
