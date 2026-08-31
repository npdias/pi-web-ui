import { createConnection, type Socket } from "node:net";
import type {
	PiTelemetryRecord,
	TelemetryAcknowledgement,
	TelemetrySocketHealth,
	TelemetrySocketState,
} from "./types.js";

const MAX_QUEUE_SIZE = 1_000;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const ACKNOWLEDGEMENT_TIMEOUT_MS = 1_000;
const RECONNECT_DELAYS_MS = [250, 1_000, 5_000, 30_000] as const;

interface QueuedRecord {
	line: string;
	bytes: number;
	sent: boolean;
	sentAt: number | null;
}

function parseAcknowledgement(line: string): TelemetryAcknowledgement | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const acknowledgement = value as Record<string, unknown>;
	if (acknowledgement.accepted === true) {
		if (
			typeof acknowledgement.event_id !== "string" ||
			acknowledgement.event_id.trim() === "" ||
			typeof acknowledgement.sequence !== "number" ||
			!Number.isSafeInteger(acknowledgement.sequence) ||
			acknowledgement.sequence <= 0 ||
			!Object.hasOwn(acknowledgement, "error") ||
			acknowledgement.error !== null
		) {
			return null;
		}
	} else if (acknowledgement.accepted === false) {
		if (
			acknowledgement.event_id !== null ||
			acknowledgement.sequence !== null ||
			typeof acknowledgement.error !== "string" ||
			acknowledgement.error.trim() === ""
		) {
			return null;
		}
	} else {
		return null;
	}
	return acknowledgement as unknown as TelemetryAcknowledgement;
}

export interface TelemetrySocketClientOptions {
	socketPath: string;
	connect?: (socketPath: string) => Socket;
	monotonicNow?: () => number;
}

export class TelemetrySocketClient {
	private readonly socketPath: string;
	private readonly connectSocket: (socketPath: string) => Socket;
	private readonly monotonicNow: () => number;
	private readonly queue: QueuedRecord[] = [];
	private queuedBytes = 0;
	private socket: Socket | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private acknowledgementTimer: NodeJS.Timeout | null = null;
	private reconnectAttempt = 0;
	private readonly acknowledgementChunks: Buffer[] = [];
	private acknowledgementBytes = 0;
	private writeBlocked = false;
	private state: TelemetrySocketState = "disconnected";
	private accepted = 0;
	private rejected = 0;
	private errors = 0;
	private gaps = 0;

	constructor(options: TelemetrySocketClientOptions) {
		this.socketPath = options.socketPath;
		this.connectSocket = options.connect ?? createConnection;
		this.monotonicNow = options.monotonicNow ?? (() => performance.now());
	}

	emit(record: PiTelemetryRecord): void {
		if (this.state === "disposed") return;
		let line: string;
		try {
			const serialized = JSON.stringify(record);
			if (Buffer.byteLength(serialized, "utf8") > MAX_FRAME_BYTES) {
				this.errors++;
				this.gaps++;
				return;
			}
			line = serialized + "\n";
		} catch {
			this.errors++;
			this.rejected++;
			return;
		}
		const bytes = Buffer.byteLength(line, "utf8");
		if (
			this.queue.length >= MAX_QUEUE_SIZE ||
			this.queuedBytes + bytes > MAX_QUEUE_BYTES
		) {
			this.gaps++;
			return;
		}
		this.queue.push({ line, bytes, sent: false, sentAt: null });
		this.queuedBytes += bytes;
		if (this.state === "connected") this.flush();
		else if (this.state === "disconnected") this.connect();
	}

	health(): TelemetrySocketHealth {
		return {
			state: this.state,
			queued: this.queue.length,
			queuedBytes: this.queuedBytes,
			accepted: this.accepted,
			rejected: this.rejected,
			errors: this.errors,
			gaps: this.gaps,
		};
	}

	/** Record adapter-side loss that happened before a record reached emit(). */
	recordFailure(lostRecords = 0): void {
		this.errors++;
		if (Number.isSafeInteger(lostRecords) && lostRecords > 0) {
			this.gaps += lostRecords;
		}
	}

	dispose(): void {
		if (this.state === "disposed") return;
		this.state = "disposed";
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.clearAcknowledgementTimer();
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.removeAllListeners();
			socket.destroy();
		}
		this.queue.length = 0;
		this.queuedBytes = 0;
		this.clearAcknowledgementBuffer();
		this.writeBlocked = false;
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
			this.writeBlocked = false;
			this.flush();
		});
		socket.on("data", (chunk: Buffer | string) => {
			if (this.socket !== socket || this.state === "disposed") return;
			this.readAcknowledgements(chunk);
		});
		socket.on("drain", () => {
			if (this.socket !== socket || this.state !== "connected") return;
			this.writeBlocked = false;
			this.flush();
		});
		socket.once("error", () => {
			this.errors++;
			this.disconnect(socket);
		});
		socket.once("close", () => {
			if (this.socket === socket && this.queue.length > 0) this.errors++;
			this.disconnect(socket);
		});
	}

	private flush(): void {
		const socket = this.socket;
		if (!socket || this.state !== "connected" || this.writeBlocked) return;
		for (const queued of this.queue) {
			if (queued.sent) continue;
			queued.sent = true;
			queued.sentAt = this.monotonicNow();
			try {
				const writable = socket.write(queued.line);
				this.armAcknowledgementTimer();
				if (!writable) {
					this.writeBlocked = true;
					return;
				}
			} catch {
				queued.sent = false;
				queued.sentAt = null;
				this.errors++;
				this.disconnect(socket);
				return;
			}
		}
	}

	private readAcknowledgements(chunk: Buffer | string): void {
		let remaining = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		while (remaining.length > 0) {
			const newline = remaining.indexOf(0x0a);
			const segment = remaining.subarray(0, newline >= 0 ? newline : remaining.length);
			if (this.acknowledgementBytes + segment.length > MAX_FRAME_BYTES) {
				this.protocolFailure();
				return;
			}
			if (segment.length > 0) {
				this.acknowledgementChunks.push(Buffer.from(segment));
				this.acknowledgementBytes += segment.length;
			}
			if (newline < 0) return;
			const line = Buffer.concat(
				this.acknowledgementChunks,
				this.acknowledgementBytes,
			).toString("utf8");
			this.clearAcknowledgementBuffer();
			const queued = this.queue[0];
			if (!queued?.sent) {
				this.protocolFailure();
				return;
			}
			const acknowledgement = parseAcknowledgement(line);
			if (!acknowledgement) {
				this.protocolFailure();
				return;
			}
			this.reconnectAttempt = 0;
			const acknowledged = this.queue.shift();
			if (acknowledged) this.queuedBytes -= acknowledged.bytes;
			this.clearAcknowledgementTimer();
			if (acknowledgement.accepted) this.accepted++;
			else this.rejected++;
			this.armAcknowledgementTimer();
			remaining = remaining.subarray(newline + 1);
		}
		this.flush();
	}

	private clearAcknowledgementBuffer(): void {
		this.acknowledgementChunks.length = 0;
		this.acknowledgementBytes = 0;
	}

	private armAcknowledgementTimer(): void {
		if (this.acknowledgementTimer || this.state !== "connected") return;
		const socket = this.socket;
		const oldest = this.queue[0];
		if (!socket || !oldest?.sent || oldest.sentAt === null) return;
		const delay = Math.max(
			0,
			oldest.sentAt + ACKNOWLEDGEMENT_TIMEOUT_MS - this.monotonicNow(),
		);
		this.acknowledgementTimer = setTimeout(() => {
			this.acknowledgementTimer = null;
			if (
				this.state !== "connected" ||
				this.socket !== socket ||
				this.queue[0] !== oldest ||
				!oldest.sent
			) {
				return;
			}
			this.errors++;
			this.disconnect(socket);
		}, delay);
		this.acknowledgementTimer.unref?.();
	}

	private clearAcknowledgementTimer(): void {
		if (this.acknowledgementTimer) clearTimeout(this.acknowledgementTimer);
		this.acknowledgementTimer = null;
	}

	private protocolFailure(): void {
		this.errors++;
		const socket = this.socket;
		if (socket) this.disconnect(socket);
	}

	private disconnect(socket: Socket): void {
		if (this.socket !== socket || this.state === "disposed") return;
		this.socket = null;
		this.clearAcknowledgementTimer();
		this.clearAcknowledgementBuffer();
		this.writeBlocked = false;
		for (const queued of this.queue) {
			queued.sent = false;
			queued.sentAt = null;
		}
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
