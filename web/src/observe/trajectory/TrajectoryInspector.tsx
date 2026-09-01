/**
 * Inspector information architecture adapted from selected DeepSeek Harness:
 * packages/client/ui-trajectory/src/client/TrajectoryTable.tsx
 * Commit: 0a53fb55bea101816fa226bb964ae2bed71c343b
 * Copyright (c) 2026 DeepSeek. MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { memo, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import {
	formatDurationMillis,
	type TelemetryTrajectoryRecord,
	type TrajectoryRecord,
} from "./record.js";
import { formatTelemetryDetail } from "./detail-format.js";
import { trajectoryRecordLiveElapsedMs } from "./timeline.js";

export interface TrajectoryInspectorProps {
	readonly record: TrajectoryRecord | null;
	readonly detailStatus?: "loading" | "exact" | "partial" | "error";
	readonly detailMissingCount?: number;
	readonly drawerOpen?: boolean;
	readonly drawerMode?: boolean;
	readonly nowMs?: number;
	readonly onClose?: () => void;
}

function DetailStatus({
	status,
	missingCount = 0,
}: {
	readonly status: TrajectoryInspectorProps["detailStatus"];
	readonly missingCount?: number;
}) {
	if (status === undefined) return null;
	let message: string;
	switch (status) {
		case "loading":
			message = "Loading exact event detail. Showing bounded projection meanwhile.";
			break;
		case "exact":
			message = "Exact event detail loaded.";
			break;
		case "partial":
			message = `${missingCount.toLocaleString("en-US")} ${missingCount === 1 ? "event" : "events"} unavailable. Showing exact detail where available and bounded projection for missing evidence.`;
			break;
		case "error":
			message = "Exact event detail unavailable. Showing bounded projection.";
			break;
	}
	return (
		<p className="observe-trajectory-inspector__detail-status" data-status={status} role="status">
			{message}
		</p>
	);
}

interface EvidenceRow {
	readonly label: string;
	readonly value: ReactNode;
}

const TOKEN_FIELDS = [
	["input_tokens", "Input"],
	["output_tokens", "Output"],
	["cache_read_tokens", "Cache read"],
	["cache_write_tokens", "Cache write"],
	["cache_write_1h_tokens", "Cache write 1h"],
	["reasoning_tokens", "Reasoning"],
	["total_tokens", "Total"],
] as const;

const CORRELATION_FIELDS = [
	["trace_id", "Trace"],
	["parent_id", "Parent"],
	["session_id", "Session"],
	["conversation_id", "Conversation"],
	["turn_id", "Turn"],
	["step_id", "Step"],
	["request_id", "Request"],
	["tool_call_id", "Tool call"],
	["assignment_id", "Assignment"],
] as const;

function Section({
	title,
	children,
}: {
	readonly title: string;
	readonly children: ReactNode;
}) {
	return (
		<section className="observe-trajectory-inspector__section">
			<h3>{title}</h3>
			{children}
		</section>
	);
}

function EvidenceList({ rows }: { readonly rows: readonly EvidenceRow[] }) {
	return (
		<dl className="observe-trajectory-inspector__evidence">
			{rows.map((row) => (
				<div key={row.label}>
					<dt>{row.label}</dt>
					<dd>{row.value}</dd>
				</div>
			))}
		</dl>
	);
}

function DetailSection({ title, value }: { readonly title: string; readonly value?: string }) {
	if (value === undefined || value.length === 0) return null;
	return (
		<Section title={title}>
			<pre className="observe-trajectory-inspector__detail">{value}</pre>
		</Section>
	);
}

function tokenRows(record: TelemetryTrajectoryRecord): readonly EvidenceRow[] {
	const rows: EvidenceRow[] = [];
	for (const [field, label] of TOKEN_FIELDS) {
		const value = record.attributes[field];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
		rows.push({ label, value: value.toLocaleString("en-US") });
	}
	return rows;
}

function correlationRows(record: TelemetryTrajectoryRecord): readonly EvidenceRow[] {
	const rows: EvidenceRow[] = [];
	for (const [field, label] of CORRELATION_FIELDS) {
		const value = record.correlation?.[field];
		if (value !== undefined) rows.push({ label, value: <code>{value}</code> });
	}
	return rows;
}

function timingRows(record: TrajectoryRecord, nowMs: number | undefined): readonly EvidenceRow[] {
	const rows: EvidenceRow[] = [
		{ label: "Duration", value: formatDurationMillis(record.durationMs) },
	];
	const liveElapsedMs = trajectoryRecordLiveElapsedMs(record, nowMs);
	if (liveElapsedMs !== null) {
		rows.push({ label: "Live elapsed", value: formatDurationMillis(liveElapsedMs) });
	}
	if (record.startedAt !== undefined) {
		rows.push({ label: "Started", value: <time dateTime={record.startedAt}>{record.startedAt}</time> });
	}
	if (record.endedAt !== undefined) {
		rows.push({ label: "Ended", value: <time dateTime={record.endedAt}>{record.endedAt}</time> });
	}
	if (record.isOpen) {
		rows.push({ label: "Closure", value: "Open" });
	} else if (record.kind !== "GAP" && record.closureUnknown) {
		rows.push({ label: "Closure", value: "Unknown after replay gap" });
	} else {
		rows.push({ label: "Closure", value: "Observed closed" });
	}
	return rows;
}

function redactionRows(record: TelemetryTrajectoryRecord): readonly EvidenceRow[] {
	const rows: EvidenceRow[] = [];
	if (record.privacyIncomplete) {
		rows.push({ label: "Privacy class", value: "Unknown" });
	} else if (record.privacyClass !== undefined) {
		rows.push({ label: "Privacy class", value: record.privacyClass });
	}
	if (record.redaction !== undefined) {
		rows.push({
			label: "Applied",
			value: record.redaction.applied === true ? "Yes" : "No",
		});
		const fields = record.redaction.fields;
		if (Array.isArray(fields) && fields.length > 0) {
			rows.push({
				label: "Fields",
				value: fields.filter((field): field is string => typeof field === "string").join(", "),
			});
		}
	}
	if (record.payloadRefs.length > 0) {
		rows.push({
			label: "Payload refs",
			value: (
				<ul className="observe-trajectory-inspector__payload-refs">
					{record.payloadRefs.map((payloadRef) => <li key={payloadRef}><code>{payloadRef}</code></li>)}
				</ul>
			),
		});
	}
	return rows;
}

function sourceRows(record: TelemetryTrajectoryRecord): readonly EvidenceRow[] {
	return [
		{ label: "Robot", value: <code>{record.source.robot_id}</code> },
		{ label: "Host", value: <code>{record.source.host_id}</code> },
		{ label: "Component", value: <code>{record.source.component}</code> },
		...(record.source.instance_id === undefined
			? []
			: [{ label: "Instance", value: <code>{record.source.instance_id}</code> }]),
		...(record.source.version === undefined
			? []
			: [{ label: "Version", value: <code>{record.source.version}</code> }]),
	];
}

function rawEvidence(record: TrajectoryRecord): unknown {
	if (record.kind === "GAP") return { gap: record.gap };
	return {
		attributes: record.attributes,
		source_envelopes: record.sourceEnvelopes,
	};
}

/** Read-only event details. Payload references remain inert text. */
export const TrajectoryInspector = memo(function TrajectoryInspector({
	record,
	detailStatus,
	detailMissingCount,
	drawerOpen = record !== null,
	drawerMode = false,
	nowMs,
	onClose,
}: TrajectoryInspectorProps) {
	const inspectorRef = useRef<HTMLElement | null>(null);
	const recordId = record?.id;
	useEffect(() => {
		if (!drawerMode || !drawerOpen || recordId === undefined) return;
		const root = inspectorRef.current;
		if (root === null) return;
		const previous = document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
		root.focus();
		return () => { previous?.focus(); };
	}, [drawerMode, drawerOpen, recordId]);

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === "Escape" && onClose !== undefined) {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key !== "Tab" || !drawerMode) return;
		const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
			'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
		)];
		if (focusable.length === 0) {
			event.preventDefault();
			event.currentTarget.focus();
			return;
		}
		const first = focusable[0];
		const last = focusable.at(-1);
		if (
			event.shiftKey &&
			(document.activeElement === first || document.activeElement === event.currentTarget)
		) {
			event.preventDefault();
			last?.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first?.focus();
		}
	};

	if (record === null) {
		return (
			<aside
				aria-label="Trajectory record details"
				aria-live="polite"
				className="observe-trajectory-inspector"
				data-open="false"
			>
				<p className="observe-trajectory-inspector__empty">Select a trajectory record.</p>
			</aside>
		);
	}

	const telemetryRecord = record.kind === "GAP" ? null : record;
	const tokens = telemetryRecord === null ? [] : tokenRows(telemetryRecord);
	const correlations = telemetryRecord === null ? [] : correlationRows(telemetryRecord);
	const redaction = telemetryRecord === null ? [] : redactionRows(telemetryRecord);

	return (
		<aside
			ref={inspectorRef}
			role={drawerMode ? "dialog" : undefined}
			aria-modal={drawerMode ? true : undefined}
			aria-label="Trajectory record details"
			aria-live="polite"
			className="observe-trajectory-inspector"
			data-open={drawerOpen ? "true" : "false"}
			data-drawer={drawerMode ? "true" : undefined}
			data-focus-entry={drawerMode ? "true" : undefined}
			data-record-id={record.id}
			onKeyDown={onKeyDown}
			tabIndex={-1}
		>
			<header className="observe-trajectory-inspector__header">
				<div>
					<span className="observe-trajectory-inspector__kind">{record.kind}</span>
					<span className="observe-trajectory-inspector__index">#{record.index}</span>
				</div>
				{onClose !== undefined && (
					<button type="button" aria-label="Close record details" onClick={onClose}>Close</button>
				)}
			</header>
			<DetailStatus status={detailStatus} missingCount={detailMissingCount} />

			<Section title="Summary">
				<p>{record.summary}</p>
				{record.state !== undefined && <p className="observe-trajectory-inspector__state">State: {record.state}</p>}
			</Section>
			<DetailSection title="Input" value={record.inputDetail} />
			<DetailSection title="Output" value={record.outputDetail ?? record.result} />
			<DetailSection title="Thinking" value={record.thinkingDetail} />
			<DetailSection title="Tool schema" value={record.schemaDetail} />
			<Section title="Timing"><EvidenceList rows={timingRows(record, nowMs)} /></Section>
			{tokens.length > 0 && <Section title="Tokens"><EvidenceList rows={tokens} /></Section>}
			{correlations.length > 0 && (
				<Section title="Correlation"><EvidenceList rows={correlations} /></Section>
			)}
			{telemetryRecord !== null && (
				<Section title="Source"><EvidenceList rows={sourceRows(telemetryRecord)} /></Section>
			)}
			{redaction.length > 0 && (
				<Section title="Redaction"><EvidenceList rows={redaction} /></Section>
			)}
			<details className="observe-trajectory-inspector__raw">
				<summary>Raw details</summary>
				<pre>{formatTelemetryDetail(rawEvidence(record))}</pre>
			</details>
		</aside>
	);
});
