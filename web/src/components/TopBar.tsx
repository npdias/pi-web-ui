import { useState } from "react";
import {
	FiFolder,
	FiGitBranch,
	FiMenu,
	FiMessageSquare,
	FiMoreHorizontal,
	FiSearch,
	FiSun,
	FiPlus,
	FiSettings,
	FiLayers,
	FiTerminal,
	FiVolume2,
} from "react-icons/fi";
import type { ChatState } from "../use-chat";
import type { ClientMessage } from "../types";
import { Dropdown, DropdownItem } from "./Dropdown";
import { SoundSettingsPanel } from "./SoundSettings";
import type { SoundKind, SoundSettings } from "../sounds";
import { useT } from "../i18n";

interface TopBarProps {
	chat: ChatState;
	send: (msg: ClientMessage) => boolean;
	view: "chat" | "terminal" | "git" | `plugin:${string}`;
	onViewChange: (view: "chat" | "terminal" | "git" | `plugin:${string}`) => void;
	/** Installed optional plugins (<dataDir>/plugins) — one view tab each. */
	plugins: { id: string; name: string; icon?: string; description?: string; error?: string }[];
	/** Open a side panel as a mobile drawer ("left" = history, "right" = files). */
	onOpenPanel: (side: "left" | "right") => void;
	/** Open the settings panel (system prompt / skills / extensions / presets). */
	onOpenSettings: () => void;
	/** Open the background-task panel (AI-started servers — stop individually or all). */
	onOpenBgTasks: () => void;
	/** Open the global search panel (sessions / projects / workspace files). */
	onOpenGlobalSearch: () => void;
	/** Sound notification settings + change handler (owned by App). */
	sound: SoundSettings;
	onSoundChange: (settings: SoundSettings) => void;
	onSoundPreview: (kind: SoundKind) => void;
	/** Theme list + current selection + switch handler (owned by App). */
	themes: { id: string; name: string; builtin: boolean }[];
	theme: string | null;
	onThemeChange: (id: string | null) => void;
}

export function TopBar({
	chat,
	send,
	view,
	plugins,
	onViewChange,
	onOpenPanel,
	onOpenSettings,
	onOpenBgTasks,
	onOpenGlobalSearch,
	sound,
	onSoundChange,
	onSoundPreview,
	themes,
	theme,
	onThemeChange,
}: TopBarProps) {
	const t = useT();
	const [soundOpen, setSoundOpen] = useState(false);
	const [themeOpen, setThemeOpen] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);

	const connLabel = chat.ready
		? t("connected")
		: chat.status === "closed"
			? t("reconnecting")
			: t("connecting");
	const connClass = chat.ready ? "ok" : "busy";


	return (
		<header className="topbar">
			<div className="brand">
				<button
					type="button"
					className="panel-toggle"
					title={t("openHistory")}
					onClick={() => onOpenPanel("left")}
				>
					<FiMenu />
				</button>
				<span className="brand-logo">π</span>
				<span className="brand-name">pi-web-ui</span>
				<span className={`conn-dot ${connClass}`} title={connLabel} />
				<span className="conn-label">{connLabel}</span>
			</div>

			<div className="topbar-actions">
				<div
					className="view-switch"
					role="tablist"
					aria-label={t("viewSwitch")}
				>
					<button
						type="button"
						role="tab"
						aria-selected={view === "chat"}
						className={view === "chat" ? "active" : ""}
						onClick={() => onViewChange("chat")}
					>
						<FiMessageSquare />
						<span>{t("chat")}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={view === "terminal"}
						className={view === "terminal" ? "active" : ""}
						onClick={() => onViewChange("terminal")}
					>
						<FiTerminal />
						<span>{t("terminal")}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={view === "git"}
						className={view === "git" ? "active" : ""}
						onClick={() => onViewChange("git")}
					>
						<FiGitBranch />
						<span>{t("scmTab")}</span>
					</button>
					{plugins.map((p) => {
						const tip = p.error
							? `${p.name}: ${p.error}`
							: p.description
								? `${p.name} — ${p.description}`
								: p.name;
						return (
							<button
								key={p.id}
								type="button"
								role="tab"
								aria-selected={view === `plugin:${p.id}`}
								className={`plugin-tab${view === `plugin:${p.id}` ? " active" : ""}${p.error ? " broken" : ""}`}
								title={tip}
								onClick={() => onViewChange(`plugin:${p.id}`)}
							>
								{p.icon ? <span aria-hidden>{p.icon}</span> : null}
								<span>{p.name}</span>
							</button>
						);
					})}
				</div>

				{/* Desktop toolbar — model/thinking move into input row on mobile. */}
				<div className="topbar-desktop">
					{/* Global search — sessions / projects / workspace files. */}
					<button
						type="button"
						className="chip"
						title={t("searchGlobalTip")}
						onClick={onOpenGlobalSearch}
					>
						<FiSearch />
						<span className="chip-sub">{t("searchGlobal")}</span>
					</button>
					{/* Background tasks — AI-started servers still listening. Always shown
					    so the list survives the conversation that started them (badge = count). */}
					<button
						type="button"
						className="chip bg-task-chip"
						data-tip={t("bgTasksTip")}
						onClick={onOpenBgTasks}
					>
						<FiLayers />
						<span className="chip-sub">{t("bgTasks")}</span>
						{chat.bgServers.length > 0 && (
							<span className="bg-task-badge">{chat.bgServers.length}</span>
						)}
					</button>

					<button
						type="button"
						className="chip"
						title={t("settingsTitle")}
						onClick={onOpenSettings}
					>
						<FiSettings />
						<span className="chip-sub">{t("settings")}</span>
					</button>

					<Dropdown
						trigger={
							<>
								<FiVolume2 />
								<span className="chip-sub">{t("sound")}</span>
							</>
						}
						open={soundOpen}
						onOpenChange={setSoundOpen}
					>
						<SoundSettingsPanel
							settings={sound}
							onChange={onSoundChange}
							onPreview={onSoundPreview}
						/>
					</Dropdown>

					<Dropdown
						trigger={
							<>
								<FiSun />
								<span className="chip-sub">{t("theme")}</span>
							</>
						}
						open={themeOpen}
						onOpenChange={setThemeOpen}
					>
						<div className="dd-header">{t("theme")}</div>
						<DropdownItem
							active={theme === null}
							onClick={() => {
								onThemeChange(null);
								setThemeOpen(false);
							}}
						>
							{t("themeDefault")}
						</DropdownItem>
						{themes.map((th) => (
							<DropdownItem
								key={th.id}
								active={theme === th.id}
								onClick={() => {
									onThemeChange(th.id);
									setThemeOpen(false);
								}}
							>
								{th.name}
							</DropdownItem>
						))}
					</Dropdown>

				</div>

				<button
					type="button"
					className="chip newchat"
					data-tip={t("newChatTip")}
					onClick={() => send({ type: "new_chat" })}
				>
					<FiPlus />
					<span>{t("newChat")}</span>
				</button>

				{/* Mobile "⋯" panel. */}
				<div className="topbar-more">
					<Dropdown
						trigger={
							<>
								<FiMoreHorizontal />
								<span className="chip-sub">{t("more")}</span>
							</>
						}
						open={moreOpen}
						onOpenChange={setMoreOpen}
					>
						<div className="dd-header">{t("sound")}</div>
						<div className="dd-header">{t("settings")}</div>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenSettings();
							}}
						>
							<FiSettings /> {t("settingsTitle")}
						</DropdownItem>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenGlobalSearch();
							}}
						>
							<FiSearch /> {t("searchGlobal")}
						</DropdownItem>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenBgTasks();
							}}
						>
							<FiLayers /> {t("bgTasks")}
							{chat.bgServers.length > 0 && (
								<em className="bg-task-badge">{chat.bgServers.length}</em>
							)}
						</DropdownItem>
						<SoundSettingsPanel
							settings={sound}
							onChange={onSoundChange}
							onPreview={onSoundPreview}
						/>
						<div className="dd-header">{t("theme")}</div>
						<DropdownItem
							active={theme === null}
							onClick={() => {
								onThemeChange(null);
								setMoreOpen(false);
							}}
						>
							{t("themeDefault")}
						</DropdownItem>
						{themes.map((th) => (
							<DropdownItem
								key={th.id}
								active={theme === th.id}
								onClick={() => {
									onThemeChange(th.id);
									setMoreOpen(false);
								}}
							>
								{th.name}
							</DropdownItem>
						))}
					</Dropdown>
				</div>

				<button
					type="button"
					className="panel-toggle"
					title={t("openFiles")}
					onClick={() => onOpenPanel("right")}
				>
					<FiFolder />
				</button>
			</div>
		</header>
	);
}
