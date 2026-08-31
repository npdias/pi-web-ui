import { createConnection, type Socket } from "node:net";
import type {
	PiTelemetryRecord,
	TelemetryAcknowledgement,
	TelemetrySocketHealth,
	TelemetrySocketState,
} from "./types.js";

const MAX_QUEUE_SIZE = 1_000;
const RECONNECT_DELAYS_MS = [250, 1_000, 5_000, 30_000] as const;

interface QueuedRecord {
	line: string;
	sent: boolean;
}

export interface TelemetrySocketClientOptions {
	socketPath: string;
	connect?: (socketPath: string) => Socket;
}

export class TelemetrySocketClient {
	private readonly socketPath: string;
	private readonly connectSocket: (socketPath: string) => Socket;
	private readonly queue: QueuedRecord[] = [];
	private socket: Socket | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private reconnectAttempt = 0;
	private acknowledgementBuffer = "";
	private state: TelemetrySocketState = "disconnected";
	private accepted = 0;
	private rejected = 0;
	private errors = 0;
	private gaps = 0;

	constructor(options: TelemetrySocketClientOptions) {
		this.socketPath = options.socketPath;
		this.connectSocket = options.connect ?? createConnection;
	}

	emit(record: PiTelemetryRecord): void {
		if (this.state === "disposed") return;
		let line: string;
		try {
			line = JSON.stringify(record) + "\n";
		} catch {
			this.errors++;
			this.rejected++;
			return;
		}
		if (this.queue.length >= MAX_QUEUE_SIZE) {
			this.gaps++;
			return;
		}
		this.queue.push({ line, sent: false });
		if (this.state === "connected") this.flush();
		else if (this.state === "disconnected") this.connect();
	}

	health(): TelemetrySocketHealth {
		return {
			state: this.state,
			queued: this.queue.length,
			accepted: this.accepted,
			rejected: this.rejected,
			errors: this.errors,
			gaps: this.gaps,
		};
	}

	dispose(): void {
		if (this.state === "disposed") return;
		this.state = "disposed";
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.removeAllListeners();
			socket.destroy();
		}
		this.queue.length = 0;
		this.acknowledgementBuffer = "";
	}

	private connect(): void {
		if (this.state === "disposed" || this.queue.length === 0) return;
		this.state = "connecting";
		let socket: Socket;
		try {
			socket = this.connectSocket(this.socketPath);
		} catch {
			this.errors++;
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		socket.once("connect", () => {
			if (this.socket !== socket || this.state === "disposed") return;
			this.state = "connected";
			this.reconnectAttempt = 0;
			this.flush();
		});
		socket.on("data", (chunk: Buffer | string) => {
			if (this.socket !== socket || this.state === "disposed") return;
			this.readAcknowledgements(chunk.toString());
		});
		socket.on("drain", () => {
			if (this.socket === socket && this.state === "connected") this.flush();
		});
		socket.once("error", () => {
			this.errors++;
			this.disconnect(socket);
		});
		socket.once("close", () => this.disconnect(socket));
	}

	private flush(): void {
		const socket = this.socket;
		if (!socket || this.state !== "connected") return;
		for (const queued of this.queue) {
			if (queued.sent) continue;
			queued.sent = true;
			try {
				if (!socket.write(queued.line)) return;
			} catch {
				queued.sent = false;
				this.errors++;
				this.disconnect(socket);
				return;
			}
		}
	}

	private readAcknowledgements(chunk: string): void {
		this.acknowledgementBuffer += chunk;
		let newline: number;
		while ((newline = this.acknowledgementBuffer.indexOf("\n")) >= 0) {
			const line = this.acknowledgementBuffer.slice(0, newline);
			this.acknowledgementBuffer = this.acknowledgementBuffer.slice(newline + 1);
			const queued = this.queue[0];
			if (!queued?.sent) {
				this.errors++;
				continue;
			}
			this.queue.shift();
			try {
				const acknowledgement = JSON.parse(line) as Partial<TelemetryAcknowledgement>;
				if (acknowledgement.accepted === true) this.accepted++;
				else if (acknowledgement.accepted === false) this.rejected++;
				else this.errors++;
			} catch {
				this.errors++;
			}
		}
		this.flush();
	}

	private disconnect(socket: Socket): void {
		if (this.socket !== socket || this.state === "disposed") return;
		this.socket = null;
		this.acknowledgementBuffer = "";
		for (const queued of this.queue) queued.sent = false;
		socket.destroy();
		if (this.queue.length > 0) this.scheduleReconnect();
		else this.state = "disconnected";
	}

	private scheduleReconnect(): void {
		if (this.state === "disposed" || this.reconnectTimer) return;
		this.state = "backoff";
		const delay =
			RECONNECT_DELAYS_MS[
				Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
			];
		this.reconnectAttempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.state === "disposed") return;
			this.state = "disconnected";
			this.connect();
		}, delay);
		this.reconnectTimer.unref?.();
	}
}
