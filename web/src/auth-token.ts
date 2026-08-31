/**
 * PI_WEB_TOKEN 客户端配合逻辑。
 *
 * 服务端设置 PI_WEB_TOKEN 后，所有 HTTP/WS 请求必须携带口令。浏览器导航
 * 无法带自定义头，所以约定：首次经 `?token=xxx` 进入 → 存入 localStorage →
 * 从地址栏移除（避免链接分享/历史记录泄露）→ 之后所有请求统一追加查询参数，
 * 服务端同时下发 HttpOnly cookie 兜底后续导航。
 */
const KEY = "pi-web-ui:token";

interface BrowserAuthGlobals {
	readonly location?: { readonly href: string };
	readonly history?: { replaceState(data: unknown, unused: string, url?: string): void };
	readonly localStorage?: {
		getItem(key: string): string | null;
		setItem(key: string, value: string): void;
	};
}

function browserGlobals(): BrowserAuthGlobals {
	return globalThis as unknown as BrowserAuthGlobals;
}

/** 应用启动时调用一次：吸收 URL 里的 ?token= 并清洗地址栏。 */
export function initAuthToken(): void {
	try {
		const globals = browserGlobals();
		if (!globals.location || !globals.history || !globals.localStorage) return;
		const url = new URL(globals.location.href);
		const t = url.searchParams.get("token");
		if (t) {
			globals.localStorage.setItem(KEY, t.trim());
			url.searchParams.delete("token");
			globals.history.replaceState(null, "", url.toString());
		}
	} catch {
		/* ignore */
	}
}

/** 当前持久化的 token（未设置时为空串）。 */
export function authToken(): string {
	try {
		return browserGlobals().localStorage?.getItem(KEY) ?? "";
	} catch {
		return "";
	}
}

/** 给相对路径 URL 追加 token 查询参数（已带 query 的用 & 连接）。 */
export function withToken(url: string): string {
	const t = authToken();
	if (!t) return url;
	return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}`;
}
