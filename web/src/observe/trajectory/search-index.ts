/**
 * Adapted from DeepSeek Harness:
 * packages/client/ui-trajectory/src/client/trajectory-search-index.ts
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { flattenTrajectoryRecords } from "./project.js";
import type {
	TelemetryTrajectoryRecord,
	TrajectoryRecord,
	TrajectoryTurn,
} from "./record.js";

interface SearchEntry {
	readonly record: TrajectoryRecord;
	readonly sources: readonly string[];
	readonly text: string;
}

const MAX_FIELD_LENGTH = 2_048;
const MAX_ENTRY_LENGTH = 8_192;
const MAX_QUERY_LENGTH = 512;
const MAX_QUERY_TERMS = 16;
const MAX_QUERY_TERM_LENGTH = 64;
const MAX_CACHED_QUERIES = 32;
const SEARCHABLE_ATTRIBUTE_KEYS: Readonly<Record<string, readonly string[]>> = {
	"agent.run": ["cause_class", "duplicate_start", "matched_start", "will_retry"],
	"agent.turn": ["cause_class", "duplicate_start", "matched_start"],
	"tool.execution": ["cause_class", "duplicate_start", "is_error", "matched_start", "tool_name"],
	"provider.thinking": ["content", "content_index"],
	"agent.stall": ["silence_ms", "threshold_ms"],
	"agent.reset": ["cause_class"],
	"context.changed": [],
};

function boundedNormalized(value: string, maximum = MAX_FIELD_LENGTH): string {
	return value
		.slice(0, maximum)
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maximum);
}

function displayValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

function correlationSources(record: TelemetryTrajectoryRecord): readonly string[] {
	const correlation = record.correlation;
	if (correlation === undefined) return [];
	return [
		correlation.trace_id,
		correlation.parent_id,
		correlation.session_id,
		correlation.conversation_id,
		correlation.turn_id,
		correlation.step_id,
		correlation.request_id,
		correlation.tool_call_id,
		correlation.assignment_id,
	].filter((value): value is string => value !== undefined);
}

function attributeSources(record: TelemetryTrajectoryRecord): readonly string[] {
	const values: string[] = [];
	for (const key of SEARCHABLE_ATTRIBUTE_KEYS[record.eventKind] ?? []) {
		const value = displayValue(record.attributes[key]);
		if (value !== "") values.push(key, value);
	}
	return values;
}

function recordSources(record: TrajectoryRecord): readonly string[] {
	if (record.kind === "GAP") {
		return [record.kind, record.summary];
	}
	return [
		record.kind,
		record.eventKind,
		record.phase ?? "",
		record.state ?? "",
		record.severity,
		record.summary,
		record.attemptOrdinal === undefined ? "" : `attempt ${record.attemptOrdinal}`,
		record.diagnostic ? "diagnostic" : "",
		record.terminalConflict ? "terminal conflict" : "",
		record.unmatchedTerminal ? "unmatched terminal" : "",
		record.gapTainted ? "gap tainted" : "",
		record.closureUnknown ? "closure unknown" : "",
		record.privacyIncomplete ? "privacy incomplete" : "",
		record.toolName ?? "",
		record.inputDetail ?? "",
		record.outputDetail ?? "",
		record.thinkingDetail ?? "",
		record.schemaDetail ?? "",
		record.result ?? "",
		record.source.robot_id,
		record.source.host_id,
		record.source.component,
		record.source.instance_id ?? "",
		record.source.version ?? "",
		record.privacyClass ?? "",
		...correlationSources(record),
		...attributeSources(record),
	];
}

function normalizedSources(record: TrajectoryRecord): readonly string[] {
	const sources: string[] = [];
	let remaining = MAX_ENTRY_LENGTH;
	for (const value of recordSources(record)) {
		if (remaining <= 0) break;
		const normalized = boundedNormalized(value, Math.min(MAX_FIELD_LENGTH, remaining));
		if (normalized === "") continue;
		sources.push(normalized);
		remaining -= normalized.length + 1;
	}
	return sources;
}

function sameSources(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length &&
		left.every((value, index) => value === right[index]);
}

function normalizedQuery(query: string): string {
	return boundedNormalized(query, MAX_QUERY_LENGTH);
}

function queryTerms(query: string): readonly string[] {
	return normalizedQuery(query)
		.split(" ")
		.filter(Boolean)
		.slice(0, MAX_QUERY_TERMS)
		.map((term) => term.slice(0, MAX_QUERY_TERM_LENGTH));
}

/** Incremental, view-local full-text index over permitted display fields only. */
export class TrajectorySearchIndex {
	private readonly entries = new Map<string, SearchEntry>();
	private readonly queryCache = new Map<string, ReadonlySet<string>>();
	private turns: readonly TrajectoryTurn[] | undefined;

	/** Number of currently indexed trajectory records. */
	get size(): number {
		return this.entries.size;
	}

	/** Bounded query-result cache size, exposed for diagnostics and tests. */
	get cachedQueryCount(): number {
		return this.queryCache.size;
	}

	/**
	 * Synchronize one projection. Unchanged source arrays retain their Map entry
	 * identity; equivalent rebuilds leave cached result Sets valid.
	 */
	update(turns: readonly TrajectoryTurn[]): boolean {
		if (this.turns === turns) return false;
		this.turns = turns;
		const seen = new Set<string>();
		let changed = false;
		for (const record of flattenTrajectoryRecords(turns)) {
			const sources = normalizedSources(record);
			const previous = this.entries.get(record.id);
			if (previous === undefined || !sameSources(previous.sources, sources)) {
				this.entries.set(record.id, {
					record,
					sources,
					text: sources.join("\n").slice(0, MAX_ENTRY_LENGTH),
				});
				changed = true;
			}
			seen.add(record.id);
		}
		for (const id of this.entries.keys()) {
			if (seen.has(id)) continue;
			this.entries.delete(id);
			changed = true;
		}
		if (changed) this.queryCache.clear();
		return changed;
	}

	/** Case-insensitive AND-term search. Empty query means no active filter. */
	search(query: string): ReadonlySet<string> | null {
		const normalized = normalizedQuery(query);
		const terms = queryTerms(normalized);
		if (terms.length === 0) return null;
		const cacheKey = terms.join("\u0000");
		const cached = this.queryCache.get(cacheKey);
		if (cached !== undefined) {
			this.queryCache.delete(cacheKey);
			this.queryCache.set(cacheKey, cached);
			return cached;
		}
		const matches = new Set<string>();
		for (const [id, entry] of this.entries) {
			if (terms.every((term) => entry.text.includes(term))) matches.add(id);
		}
		if (this.queryCache.size >= MAX_CACHED_QUERIES) {
			const oldest = this.queryCache.keys().next().value;
			if (oldest !== undefined) this.queryCache.delete(oldest);
		}
		this.queryCache.set(cacheKey, matches);
		return matches;
	}
}
