import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type KeyboardEvent,
} from "react";
import { useT } from "../i18n.js";
import { TelemetryStore, type TelemetrySnapshot } from "./telemetry-store.js";
import type {
	TelemetryHealth,
	TelemetrySourceHealth,
} from "./telemetry-types.js";
import { flattenTrajectoryRecords, projectTrajectory } from "./trajectory/project.js";
import type { TrajectoryRecord } from "./trajectory/record.js";
import { TrajectorySearchIndex } from "./trajectory/search-index.js";
import { TrajectoryInspector } from "./trajectory/TrajectoryInspector.js";
import { TrajectoryLedger } from "./trajectory/TrajectoryLedger.js";
import { TrajectoryTimeline } from "./trajectory/TrajectoryTimeline.js";
import {
	trajectoryTimelineFocusRecordIds,
	type TrajectoryTimeRange,
} from "./trajectory/timeline.js";
import {
	TrajectoryToolbar,
	type TrajectoryFilters,
} from "./trajectory/TrajectoryToolbar.js";

export type ObserveHealthTone =
	| "loading"
	| "disconnected"
	| "idle"
	| "healthy"
	| "degraded"
	| "gap";

export interface ObserveHealthSummary {
	readonly tone: ObserveHealthTone;
	readonly label: string;
	readonly detail: string;
}

export const DISCONNECTED_OBSERVE_HEALTH: ObserveHealthSummary = {
	tone: "disconnected",
	label: "Disconnected",
	detail: "Observe telemetry is disconnected.",
};

export interface ObserveViewProps {
	readonly active: boolean;
	readonly onHealthChange?: (health: ObserveHealthSummary) => void;
}

type ObserveSubview = "trajectory" | "services" | "host" | "logs" | "changes";

const DEFAULT_FILTERS: TrajectoryFilters = {
	kind: "ALL",
	source: "",
	errorsOnly: false,
	activeOnly: false,
	stalledOnly: false,
	traceId: "",
};

const SUBVIEWS: readonly ObserveSubview[] = [
	"trajectory",
	"services",
	"host",
	"logs",
	"changes",
];
const SUBVIEW_LABEL_KEYS = {
	trajectory: "observeTrajectory",
	services: "observeServices",
	host: "observeHost",
	logs: "observeLogs",
	changes: "observeChanges",
} as const;

function sourceKey(source: TelemetrySourceHealth["source"]): string {
	return [
		source.robot_id,
		source.host_id,
		source.component,
		source.instance_id ?? "",
	].join("/");
}

function recordSourceKey(record: TrajectoryRecord): string {
	return record.kind === "GAP" ? "" : sourceKey(record.source);
}

function countFact(count: number, singular: string, plural = `${singular}s`): string | null {
	return count === 0 ? null : `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}

function healthCounterFacts(health: TelemetryHealth | null): readonly string[] {
	if (health === null) return [];
	return [
		countFact(health.counters.rejected, "rejected event"),
		countFact(health.counters.persistence_gap, "persistence gap"),
		countFact(health.counters.dropped, "dropped event"),
		countFact(health.counters.torn_lines, "torn line"),
		countFact(health.counters.stale_sources, "stale source"),
		countFact(health.counters.retention_failures, "retention failure"),
	].filter((fact): fact is string => fact !== null);
}

function deriveHealthSummary(
	active: boolean,
	snapshot: TelemetrySnapshot,
	health: TelemetryHealth | null,
	healthError: boolean,
	sourcesError: boolean,
): ObserveHealthSummary {
	if (!active) return DISCONNECTED_OBSERVE_HEALTH;
	if (snapshot.status === "replaying" || snapshot.status === "connecting") {
		return {
			tone: "loading",
			label: "Loading",
			detail: "Hydrating retained telemetry and connecting live stream.",
		};
	}
	if (
		snapshot.status === "backoff" ||
		snapshot.status === "idle" ||
		snapshot.status === "stopped"
	) {
		return DISCONNECTED_OBSERVE_HEALTH;
	}
	const loadedErrorCount = snapshot.events.filter((event) =>
		event.severity === "error" ||
		event.severity === "critical" ||
		event.state === "error" ||
		event.kind === "agent.stall" ||
		event.attributes.is_error === true,
	).length;
	const staleSources = health?.sources.filter((source) => source.status === "stale").length ?? 0;
	const counterFacts = healthCounterFacts(health);
	const facts = [
		healthError ? "core health unavailable" : null,
		sourcesError ? "source health listing unavailable" : null,
		...counterFacts,
		staleSources > 0 && health?.counters.stale_sources === 0
			? `${staleSources} stale source health entr${staleSources === 1 ? "y" : "ies"}`
			: null,
		loadedErrorCount > 0 ? `${loadedErrorCount} error or stall fact${loadedErrorCount === 1 ? "" : "s"}` : null,
	].filter((fact): fact is string => fact !== null);
	if (snapshot.gaps.length > 0) {
		const gapFact = `${snapshot.gaps.length} explicit telemetry replay gap${snapshot.gaps.length === 1 ? "" : "s"} in loaded evidence`;
		return {
			tone: "gap",
			label: "Gap",
			detail: [gapFact, ...facts].join("; "),
		};
	}
	if (health === null && !healthError) {
		return {
			tone: "loading",
			label: "Loading",
			detail: "Live stream connected; waiting for telemetry core health.",
		};
	}
	if (
		healthError ||
		sourcesError ||
		health?.status === "degraded" ||
		counterFacts.length > 0 ||
		staleSources > 0 ||
		loadedErrorCount > 0
	) {
		return {
			tone: "degraded",
			label: "Degraded",
			detail: facts.length > 0 ? facts.join("; ") : "Telemetry core reports degraded health.",
		};
	}
	if (health?.status === "idle") {
		return {
			tone: "idle",
			label: "Idle",
			detail: "Telemetry core is available with no current event activity.",
		};
	}
	return {
		tone: "healthy",
		label: "Healthy",
		detail: "Telemetry core and live stream report no loaded gap, stale, or error facts.",
	};
}

function matchesHostSource(source: TelemetrySourceHealth): boolean {
	return /(^|[-_.])(host|hardware|system-sampler)([-_.]|$)/u.test(
		source.source.component,
	);
}

function mergeSources(
	health: TelemetryHealth | null,
	sources: readonly TelemetrySourceHealth[],
): readonly TelemetrySourceHealth[] {
	const merged = new Map<string, TelemetrySourceHealth>();
	for (const item of health?.sources ?? []) merged.set(sourceKey(item.source), item);
	for (const item of sources) merged.set(sourceKey(item.source), item);
	return [...merged.values()].sort((left, right) =>
		sourceKey(left.source).localeCompare(sourceKey(right.source)));
}

function EmptyState({ title, children }: {
	readonly title: string;
	readonly children: string;
}) {
	return (
		<section className="observe-empty-state" aria-live="polite">
			<h2>{title}</h2>
			<p>{children}</p>
		</section>
	);
}

function SourceFacts({
	title,
	sources,
	emptyTitle,
	emptyText,
}: {
	readonly title: string;
	readonly sources: readonly TelemetrySourceHealth[];
	readonly emptyTitle: string;
	readonly emptyText: string;
}) {
	const t = useT();
	if (sources.length === 0) return <EmptyState title={emptyTitle}>{emptyText}</EmptyState>;
	return (
		<section className="observe-source-view" aria-labelledby={`observe-source-${title}`}>
			<header>
				<h2 id={`observe-source-${title}`}>{title}</h2>
				<p>{t("observeSourceFactsBody")}</p>
			</header>
			<div className="observe-source-grid">
				{sources.map((item) => (
					<article className="observe-source-card" key={sourceKey(item.source)} data-status={item.status}>
						<div className="observe-source-card__heading">
							<code>{item.source.component}</code>
							<span>{item.status === "healthy" ? t("observeHealthy") : t("observeStale")}</span>
						</div>
						<dl>
							<div><dt>{t("observeRobot")}</dt><dd><code>{item.source.robot_id}</code></dd></div>
							<div><dt>{t("observeHost")}</dt><dd><code>{item.source.host_id}</code></dd></div>
							{item.source.instance_id !== undefined && (
								<div><dt>{t("observeInstance")}</dt><dd><code>{item.source.instance_id}</code></dd></div>
							)}
							{item.source.version !== undefined && (
								<div><dt>{t("observeVersion")}</dt><dd><code>{item.source.version}</code></dd></div>
							)}
							<div><dt>{t("observeLastEvent")}</dt><dd><time dateTime={item.last_event_at}>{item.last_event_at}</time></dd></div>
							<div><dt>{t("observeLastEventAge")}</dt><dd>{item.last_event_age_seconds.toLocaleString("en-US")} s</dd></div>
						</dl>
					</article>
				))}
			</div>
		</section>
	);
}

export function ObserveView({ active, onHealthChange }: ObserveViewProps) {
	const t = useT();
	const [store] = useState(() => new TelemetryStore());
	const [snapshot, setSnapshot] = useState<TelemetrySnapshot>(() => store.snapshot());
	const [health, setHealth] = useState<TelemetryHealth | null>(null);
	const [sources, setSources] = useState<readonly TelemetrySourceHealth[]>([]);
	const [healthError, setHealthError] = useState(false);
	const [sourcesError, setSourcesError] = useState(false);
	const [subview, setSubview] = useState<ObserveSubview>("trajectory");
	const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [filters, setFilters] = useState<TrajectoryFilters>(DEFAULT_FILTERS);
	const [timelineRange, setTimelineRange] = useState<TrajectoryTimeRange | null>(null);
	const [searchIndex] = useState(() => new TrajectorySearchIndex());
	const [nowMs, setNowMs] = useState(() => Date.now());
	const [isNarrow, setIsNarrow] = useState(
		() => globalThis.matchMedia?.("(max-width: 720px)").matches ?? false,
	);

	useEffect(() => {
		setSnapshot(store.snapshot());
		return store.subscribe(setSnapshot);
	}, [store]);

	useEffect(() => {
		if (!active) {
			store.disconnect();
			setHealth(null);
			setSources([]);
			setHealthError(false);
			setSourcesError(false);
			return;
		}
		setHealth(null);
		setSources([]);
		setHealthError(false);
		setSourcesError(false);
		const controller = new AbortController();
		let refreshing = false;
		let refreshGeneration = 0;
		const refreshMetadata = async () => {
			if (refreshing) return;
			refreshing = true;
			const requestGeneration = ++refreshGeneration;
			const [healthResult, sourcesResult] = await Promise.allSettled([
				store.getHealth(controller.signal),
				store.getSources(controller.signal),
			]);
			refreshing = false;
			if (
				controller.signal.aborted ||
				requestGeneration !== refreshGeneration
			) return;
			setHealth(healthResult.status === "fulfilled" ? healthResult.value : null);
			setSources(sourcesResult.status === "fulfilled" ? sourcesResult.value : []);
			setHealthError(healthResult.status === "rejected");
			setSourcesError(sourcesResult.status === "rejected");
		};
		void store.connect();
		void refreshMetadata();
		const timer = globalThis.setInterval(() => { void refreshMetadata(); }, 15_000);
		return () => {
			globalThis.clearInterval(timer);
			refreshGeneration++;
			controller.abort();
			store.disconnect();
		};
	}, [active, store]);

	useEffect(() => {
		const query = globalThis.matchMedia?.("(max-width: 720px)");
		if (query === undefined) return;
		const update = () => { setIsNarrow(query.matches); };
		update();
		query.addEventListener("change", update);
		return () => { query.removeEventListener("change", update); };
	}, []);

	const healthSummary = useMemo(
		() => deriveHealthSummary(active, snapshot, health, healthError, sourcesError),
		[active, health, healthError, snapshot, sourcesError],
	);
	useEffect(() => {
		onHealthChange?.(healthSummary);
	}, [healthSummary, onHealthChange]);

	const turns = useMemo(() => projectTrajectory(snapshot.records), [snapshot.records]);
	const records = useMemo(() => flattenTrajectoryRecords(turns), [turns]);
	const hasOpenRecords = useMemo(
		() => records.some((record) =>
			record.kind !== "GAP" && record.isOpen && !record.closureUnknown),
		[records],
	);
	useEffect(() => {
		if (!active || !hasOpenRecords) return;
		setNowMs(Date.now());
		const timer = globalThis.setInterval(() => { setNowMs(Date.now()); }, 1_000);
		return () => { globalThis.clearInterval(timer); };
	}, [active, hasOpenRecords]);
	const selectedRecord = useMemo(
		() => records.find((record) => record.id === selectedRecordId) ?? null,
		[records, selectedRecordId],
	);
	const sourceFacts = useMemo(() => mergeSources(health, sources), [health, sources]);
	const sourceMetadataPending =
		health === null && sources.length === 0 && !healthError && !sourcesError;
	const sourceMetadataUnavailable =
		sourceFacts.length === 0 && healthError && sourcesError;
	const hostSources = useMemo(() => sourceFacts.filter(matchesHostSource), [sourceFacts]);
	const serviceSources = useMemo(
		() => sourceFacts.filter((source) => !matchesHostSource(source)),
		[sourceFacts],
	);
	const sourceOptions = useMemo(
		() => [...new Set(records.map(recordSourceKey).filter(Boolean))].sort(),
		[records],
	);
	const searchMatches = useMemo(() => {
		searchIndex.update(turns);
		return searchIndex.search(searchQuery);
	}, [searchIndex, searchQuery, turns]);
	const visibleRecordIds = useMemo(() => {
		const hasFilter =
			searchMatches !== null ||
			filters.kind !== "ALL" ||
			filters.source !== "" ||
			filters.errorsOnly ||
			filters.activeOnly ||
			filters.stalledOnly ||
			filters.traceId.trim() !== "";
		if (!hasFilter) return null;
		const trace = filters.traceId.trim().toLowerCase();
		return new Set(records.filter((record) => {
			if (searchMatches !== null && !searchMatches.has(record.id)) return false;
			if (filters.kind !== "ALL" && record.kind !== filters.kind) return false;
			if (filters.source !== "" && recordSourceKey(record) !== filters.source) return false;
			if (filters.errorsOnly && !record.isError) return false;
			if (filters.activeOnly && !record.isOpen) return false;
			if (filters.stalledOnly && record.kind !== "STALL") return false;
			if (
				trace !== "" &&
				(record.kind === "GAP" || !(record.traceId ?? "").toLowerCase().includes(trace))
			) return false;
			return true;
		}).map((record) => record.id));
	}, [filters, records, searchMatches]);
	const timelineFocusRecordIds = useMemo(
		() => timelineRange === null
			? null
			: trajectoryTimelineFocusRecordIds(
				turns,
				timelineRange,
				snapshot.preferences.timeMode,
				{ nowMs },
			),
		[nowMs, snapshot.preferences.timeMode, timelineRange, turns],
	);

	const updatePreferences = useCallback((patch: Partial<TelemetrySnapshot["preferences"]>) => {
		store.setPreferences({ ...snapshot.preferences, ...patch });
	}, [snapshot.preferences, store]);
	const selectRecord = useCallback((recordId: string) => {
		setSelectedRecordId(recordId);
		updatePreferences({ followLive: false });
	}, [updatePreferences]);
	const closeInspector = useCallback(() => { setSelectedRecordId(null); }, []);
	const jumpToLive = useCallback(() => {
		setSelectedRecordId(null);
		setTimelineRange(null);
		updatePreferences({ followLive: true });
	}, [updatePreferences]);
	const activateSubview = useCallback((next: ObserveSubview, focus: boolean) => {
		setSubview(next);
		if (!focus) return;
		globalThis.requestAnimationFrame(() => {
			document.getElementById(`observe-subtab-${next}`)?.focus();
		});
	}, []);
	const onSubviewKeyDown = useCallback((
		event: KeyboardEvent<HTMLButtonElement>,
		current: ObserveSubview,
	) => {
		const index = SUBVIEWS.indexOf(current);
		let next: ObserveSubview | undefined;
		switch (event.key) {
			case "ArrowRight":
				next = SUBVIEWS[(index + 1) % SUBVIEWS.length];
				break;
			case "ArrowLeft":
				next = SUBVIEWS[(index - 1 + SUBVIEWS.length) % SUBVIEWS.length];
				break;
			case "Home":
				next = SUBVIEWS[0];
				break;
			case "End":
				next = SUBVIEWS.at(-1);
				break;
			default:
				return;
		}
		if (next === undefined) return;
		event.preventDefault();
		activateSubview(next, true);
	}, [activateSubview]);

	const trajectoryContent = snapshot.records.length === 0 &&
		(snapshot.status === "replaying" || snapshot.status === "connecting")
		? (
			<section className="observe-loading-state" aria-live="polite">
				<h2>{t("observeLoading")}</h2>
				<p>{t("observeHydratingBody")}</p>
			</section>
		)
		: snapshot.records.length === 0
			? (
				<EmptyState title={t("observeNoTelemetryTitle")}>
					{t("observeNoTelemetryBody")}
				</EmptyState>
			)
			: (
				<div className="observe-trajectory-view">
					<TrajectoryTimeline
						turns={turns}
						mode={snapshot.preferences.timeMode}
						range={timelineRange}
						selectedRecordId={selectedRecordId}
						searchMatchRecordIds={searchMatches}
						nowMs={nowMs}
						onRangeChange={setTimelineRange}
						onRecordSelect={selectRecord}
					/>
					<TrajectoryToolbar
						mode={snapshot.preferences.timeMode}
						foldTurns={snapshot.preferences.foldTurns}
						foldCalls={snapshot.preferences.foldCalls}
						searchQuery={searchQuery}
						filters={filters}
						sourceOptions={sourceOptions}
						isFollowingLive={snapshot.preferences.followLive}
						onModeChange={(mode) => {
							setTimelineRange(null);
							updatePreferences({ timeMode: mode });
						}}
						onFoldTurnsChange={(foldTurns) => { updatePreferences({ foldTurns }); }}
						onFoldCallsChange={(foldCalls) => { updatePreferences({ foldCalls }); }}
						onSearchQueryChange={setSearchQuery}
						onFiltersChange={setFilters}
						onJumpToLive={jumpToLive}
						onEscape={closeInspector}
					/>
					<div className="observe-trajectory-workspace">
						<TrajectoryLedger
							turns={turns}
							selectedRecordId={selectedRecordId}
							searchMatchRecordIds={searchMatches}
							timelineFocusRecordIds={timelineFocusRecordIds}
							visibleRecordIds={visibleRecordIds}
							foldTurns={snapshot.preferences.foldTurns}
							foldCalls={snapshot.preferences.foldCalls}
							nowMs={nowMs}
							isFollowingLive={snapshot.preferences.followLive}
							onRecordSelect={selectRecord}
							onFollowingLiveChange={(followLive) => { updatePreferences({ followLive }); }}
							onEscape={closeInspector}
						/>
						{selectedRecord === null && !isNarrow ? (
							<aside className="observe-inspector-placeholder" aria-label="Trajectory record details">
								<p>Select a trajectory record.</p>
							</aside>
						) : (
							<TrajectoryInspector
								record={selectedRecord}
								drawerMode={isNarrow}
								drawerOpen={selectedRecord !== null}
								nowMs={nowMs}
								onClose={closeInspector}
							/>
						)}
					</div>
				</div>
			);

	return (
		<section className="observe-view" data-active={active ? "true" : "false"} aria-label={t("observeWorkspace")}>
			{active && (
			<>
			<header className="observe-view__header">
				<div>
					<h1>{t("observe")}</h1>
					<p>{t("observeReadOnlyDescription")}</p>
				</div>
				<nav className="observe-subnav" role="tablist" aria-label={t("observeViews")}>
					{SUBVIEWS.map((name) => (
						<button
							id={`observe-subtab-${name}`}
							type="button"
							role="tab"
							aria-selected={subview === name}
							aria-controls={`observe-panel-${name}`}
							tabIndex={subview === name ? 0 : -1}
							className={subview === name ? "active" : ""}
							key={name}
							onClick={() => { activateSubview(name, false); }}
							onKeyDown={(event) => { onSubviewKeyDown(event, name); }}
						>
							{t(SUBVIEW_LABEL_KEYS[name])}
						</button>
					))}
				</nav>
			</header>
			<div className="observe-health-banner" data-tone={healthSummary.tone} role="status">
				<strong>{healthSummary.label}</strong>
				<span>{healthSummary.detail}</span>
			</div>
			<div
				className="observe-view__content"
				id="observe-panel-trajectory"
				role="tabpanel"
				aria-labelledby="observe-subtab-trajectory"
				hidden={subview !== "trajectory"}
			>
				{subview === "trajectory" && trajectoryContent}
			</div>
			<div
				className="observe-view__content"
				id="observe-panel-services"
				role="tabpanel"
				aria-labelledby="observe-subtab-services"
				hidden={subview !== "services"}
			>
				{subview === "services" && sourceMetadataPending && (
					<section className="observe-loading-state" aria-live="polite">
						<h2>{t("observeSourceLoadingTitle")}</h2>
						<p>{t("observeSourceLoadingBody")}</p>
					</section>
				)}
				{subview === "services" && !sourceMetadataPending && (
					<SourceFacts
						title={t("observeServices")}
						sources={serviceSources}
						emptyTitle={t(sourceMetadataUnavailable
							? "observeSourcesUnavailableTitle"
							: "observeNoServicesTitle")}
						emptyText={t(sourceMetadataUnavailable
							? "observeSourcesUnavailableBody"
							: "observeNoServicesBody")}
					/>
				)}
			</div>
			<div
				className="observe-view__content"
				id="observe-panel-host"
				role="tabpanel"
				aria-labelledby="observe-subtab-host"
				hidden={subview !== "host"}
			>
				{subview === "host" && sourceMetadataPending && (
					<section className="observe-loading-state" aria-live="polite">
						<h2>{t("observeSourceLoadingTitle")}</h2>
						<p>{t("observeSourceLoadingBody")}</p>
					</section>
				)}
				{subview === "host" && !sourceMetadataPending && (
					<SourceFacts
						title={t("observeHost")}
						sources={hostSources}
						emptyTitle={t(sourceMetadataUnavailable
							? "observeSourcesUnavailableTitle"
							: "observeNoHostTitle")}
						emptyText={t(sourceMetadataUnavailable
							? "observeSourcesUnavailableBody"
							: "observeNoHostBody")}
					/>
				)}
			</div>
			<div
				className="observe-view__content"
				id="observe-panel-logs"
				role="tabpanel"
				aria-labelledby="observe-subtab-logs"
				hidden={subview !== "logs"}
			>
				{subview === "logs" && (
					<EmptyState title={t("observeNoLogsTitle")}>
						{t("observeNoLogsBody")}
					</EmptyState>
				)}
			</div>
			<div
				className="observe-view__content"
				id="observe-panel-changes"
				role="tabpanel"
				aria-labelledby="observe-subtab-changes"
				hidden={subview !== "changes"}
			>
				{subview === "changes" && (
					<EmptyState title={t("observeNoChangesTitle")}>
						{t("observeNoChangesBody")}
					</EmptyState>
				)}
			</div>
			</>
			)}
		</section>
	);
}
