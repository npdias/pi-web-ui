import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetrySocketClient } from "../../server/telemetry/client.js";
import type { PiTelemetryRecord } from "../../server/telemetry/types.js";

const records: PiTelemetryRecord[] = [
	{
		kind: "agent.turn",
		phase: "start",
		source: { host_id: "robot-01", component: "pi" },
	},
	{
		kind: "agent.turn",
		phase: "end",
		source: { host_id: "robot-01", component: "pi" },
	},
];

const MIB = 1024 * 1024;
const QUEUE_BYTE_CAP = 16 * MIB;

function recordWithLineBytes(targetBytes: number, fill = "x"): PiTelemetryRecord {
	const empty: PiTelemetryRecord = {
		kind: "agent.turn",
		phase: "observation",
		source: { host_id: "robot-01", component: "pi" },
		attributes: { payload: "" },
	};
	const emptyLineBytes = Buffer.byteLength(`${JSON.stringify(empty)}\n`, "utf8");
	const fillBytes = Buffer.byteLength(fill, "utf8");
	const payloadBytes = targetBytes - emptyLineBytes;
	if (payloadBytes < 0 || payloadBytes % fillBytes !== 0) {
		throw new Error("target line size cannot be represented by requested fill");
	}
	return {
		...empty,
		attributes: { payload: fill.repeat(payloadBytes / fillBytes) },
	};
}

const clients: TelemetrySocketClient[] = [];
const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const client of clients.splice(0)) client.dispose();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function socketPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-telemetry-client-"));
	tempDirs.push(dir);
	return join(dir, "telemetry.sock");
}

async function listen(server: Server, path: string): Promise<void> {
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition not met");
}

class FakeSocket extends EventEmitter {
	destroyedByClient = false;
	readonly writes: string[] = [];
	writeResults: boolean[] = [];

	write(line: string): boolean {
		this.writes.push(line);
		return this.writeResults.shift() ?? true;
	}

	destroy(): this {
		this.destroyedByClient = true;
		return this;
	}
}

describe("TelemetrySocketClient", () => {
	it("does not write later frames while socket backpressure waits for drain", () => {
		const socket = new FakeSocket();
		socket.writeResults.push(false, true);
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => socket as unknown as Socket,
		});
		clients.push(client);

		client.emit(records[0]);
		socket.emit("connect");
		client.emit(records[1]);

		expect(socket.writes).toEqual([JSON.stringify(records[0]) + "\n"]);
		socket.emit("drain");
		expect(socket.writes).toEqual(records.map((record) => JSON.stringify(record) + "\n"));
	});

	it("frames one compact source record per LF and accepts acknowledgements FIFO", async () => {
		const path = socketPath();
		const received: string[] = [];
		const server = createServer((socket) => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					received.push(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
				}
				if (received.length === 2) {
					socket.write(
						'{"accepted":true,"event_id":"tel_1","sequence":1,"error":null}\n' +
							'{"accepted":true,"event_id":"tel_2","sequence":2,"error":null}\n',
					);
				}
			});
		});
		await listen(server, path);
		const client = new TelemetrySocketClient({ socketPath: path });
		clients.push(client);

		expect(client.emit(records[0])).toBeUndefined();
		expect(client.emit(records[1])).toBeUndefined();
		await waitFor(() => client.health().accepted === 2);

		expect(received).toEqual(records.map((record) => JSON.stringify(record)));
		expect(client.health()).toMatchObject({
			state: "connected",
			queued: 0,
			accepted: 2,
			rejected: 0,
			errors: 0,
			gaps: 0,
		});
	});

	it("counts a rejected LF acknowledgement and removes its queued record", async () => {
		const path = socketPath();
		const server = createServer((socket) => {
			socket.once("data", () => {
				socket.write(
					'{"accepted":false,"event_id":null,"sequence":null,"error":"invalid telemetry record"}\n',
				);
			});
		});
		await listen(server, path);
		const client = new TelemetrySocketClient({ socketPath: path });
		clients.push(client);

		client.emit(records[0]);
		await waitFor(() => client.health().rejected === 1);

		expect(client.health()).toMatchObject({ queued: 0, accepted: 0, rejected: 1 });
	});

	it.each([
		["non-object", "[]"],
		["missing accepted", '{"event_id":"tel_1","sequence":1,"error":null}'],
		["empty accepted event id", '{"accepted":true,"event_id":"","sequence":1,"error":null}'],
		["missing accepted error", '{"accepted":true,"event_id":"tel_1","sequence":1}'],
		["zero accepted sequence", '{"accepted":true,"event_id":"tel_1","sequence":0,"error":null}'],
		["negative accepted sequence", '{"accepted":true,"event_id":"tel_1","sequence":-1,"error":null}'],
		["unsafe accepted sequence", '{"accepted":true,"event_id":"tel_1","sequence":9007199254740992,"error":null}'],
		["non-integer accepted sequence", '{"accepted":true,"event_id":"tel_1","sequence":1.5,"error":null}'],
		["accepted error", '{"accepted":true,"event_id":"tel_1","sequence":1,"error":"bad"}'],
		["rejected event id", '{"accepted":false,"event_id":"tel_1","sequence":null,"error":"bad"}'],
		["rejected sequence", '{"accepted":false,"event_id":null,"sequence":1,"error":"bad"}'],
		["missing rejected error", '{"accepted":false,"event_id":null,"sequence":null,"error":null}'],
	])("treats %s acknowledgement as protocol failure without dropping record", (_name, line) => {
		vi.useFakeTimers();
		const socket = new FakeSocket();
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => socket as unknown as Socket,
		});
		clients.push(client);
		client.emit(records[0]);
		socket.emit("connect");

		socket.emit("data", line + "\n");

		expect(socket.destroyedByClient).toBe(true);
		expect(client.health()).toMatchObject({
			state: "backoff",
			queued: 1,
			accepted: 0,
			rejected: 0,
			errors: 1,
		});
	});

	it("bounds partial acknowledgement buffer at 1 MiB and requeues outstanding record", () => {
		vi.useFakeTimers();
		const socket = new FakeSocket();
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => socket as unknown as Socket,
		});
		clients.push(client);
		client.emit(records[0]);
		client.emit(records[1]);
		socket.emit("connect");

		socket.emit(
			"data",
			'{"accepted":true,"event_id":"tel_1","sequence":1,"error":null}\n' +
				"x".repeat(1024 * 1024 + 1),
		);

		expect(socket.destroyedByClient).toBe(true);
		expect(client.health()).toMatchObject({
			state: "backoff",
			queued: 1,
			accepted: 1,
			errors: 1,
		});
	});

	it("does not reject or throw when socket is unavailable", () => {
		const client = new TelemetrySocketClient({ socketPath: socketPath() });
		clients.push(client);

		expect(() => client.emit(records[0])).not.toThrow();
		expect(client.health().queued).toBe(1);
	});

	it("bounds queue at 1000 records and increments explicit gap count", () => {
		const client = new TelemetrySocketClient({ socketPath: socketPath() });
		clients.push(client);

		for (let index = 0; index < 1_001; index++) client.emit(records[0]);

		expect(client.health()).toMatchObject({ queued: 1_000, gaps: 1 });
	});

	it("caps serialized queued and sent data at exactly 16 MiB", () => {
		vi.useFakeTimers();
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => {
				throw new Error("offline");
			},
		});
		clients.push(client);
		const oneMiBLine = recordWithLineBytes(MIB);

		for (let index = 0; index < 1_000; index++) client.emit(oneMiBLine);

		expect(client.health()).toMatchObject({
			queued: 16,
			queuedBytes: QUEUE_BYTE_CAP,
			gaps: 984,
		});
	});

	it("tracks UTF-8 queue bytes and releases them only after valid acknowledgement", () => {
		vi.useFakeTimers();
		const sockets: FakeSocket[] = [];
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket as unknown as Socket;
			},
		});
		clients.push(client);
		const multibyte: PiTelemetryRecord = {
			...records[0],
			attributes: { payload: "é🙂" },
		};
		const expectedBytes = Buffer.byteLength(`${JSON.stringify(multibyte)}\n`, "utf8");

		client.emit(multibyte);
		sockets[0].emit("connect");
		expect(client.health().queuedBytes).toBe(expectedBytes);

		sockets[0].emit("data", '{"accepted":true}\n');
		expect(client.health()).toMatchObject({ queued: 1, queuedBytes: expectedBytes });

		vi.advanceTimersByTime(250);
		sockets[1].emit("connect");
		sockets[1].emit(
			"data",
			'{"accepted":false,"event_id":null,"sequence":null,"error":"dropped"}\n',
		);
		expect(client.health()).toMatchObject({ queued: 0, queuedBytes: 0, rejected: 1 });
	});

	it("keeps one byte accounting total across disconnect and FIFO requeue", () => {
		vi.useFakeTimers();
		const sockets: FakeSocket[] = [];
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket as unknown as Socket;
			},
		});
		clients.push(client);
		const expectedBytes = records.reduce(
			(total, record) => total + Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8"),
			0,
		);

		for (const record of records) client.emit(record);
		sockets[0].emit("connect");
		expect(client.health().queuedBytes).toBe(expectedBytes);
		sockets[0].emit("close");
		expect(client.health().queuedBytes).toBe(expectedBytes);
		vi.advanceTimersByTime(250);
		sockets[1].emit("connect");
		expect(client.health().queuedBytes).toBe(expectedBytes);

		sockets[1].emit(
			"data",
			'{"accepted":true,"event_id":"tel_1","sequence":1,"error":null}\n',
		);
		expect(client.health().queuedBytes).toBe(
			Buffer.byteLength(`${JSON.stringify(records[1])}\n`, "utf8"),
		);
	});

	it("accounts for adapter failures and their explicit lost-record count", () => {
		const client = new TelemetrySocketClient({ socketPath: socketPath() });
		clients.push(client);
		const subject = client as TelemetrySocketClient & {
			recordFailure?: (lostRecords?: number) => void;
		};

		expect(typeof subject.recordFailure).toBe("function");
		subject.recordFailure?.(3);
		subject.recordFailure?.(0);

		expect(client.health()).toMatchObject({ errors: 2, gaps: 3 });
	});

	it("rejects a serialized source record over 1 MiB without queueing or connecting", () => {
		let connections = 0;
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => {
				connections++;
				return new FakeSocket() as unknown as Socket;
			},
		});
		clients.push(client);

		client.emit({
			...records[0],
			attributes: { payload: "x".repeat(1024 * 1024) },
		});

		expect(connections).toBe(0);
		expect(client.health()).toMatchObject({
			state: "disconnected",
			queued: 0,
			errors: 1,
			gaps: 1,
		});
	});

	it("reconnects after 250 ms, 1 s, 5 s, then caps delay at 30 s", () => {
		vi.useFakeTimers();
		const sockets: FakeSocket[] = [];
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket as unknown as Socket;
			},
		});
		clients.push(client);
		client.emit(records[0]);

		for (const delay of [250, 1_000, 5_000, 30_000, 30_000]) {
			const attempts = sockets.length;
			sockets.at(-1)?.emit("error", new Error("unavailable"));
			expect(client.health().state).toBe("backoff");
			vi.advanceTimersByTime(delay - 1);
			expect(sockets).toHaveLength(attempts);
			vi.advanceTimersByTime(1);
			expect(sockets).toHaveLength(attempts + 1);
			expect(client.health().state).toBe("connecting");
		}
	});

	it("keeps retry progression across connect-close churn before any acknowledgement", () => {
		vi.useFakeTimers();
		const sockets: FakeSocket[] = [];
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket as unknown as Socket;
			},
		});
		clients.push(client);
		client.emit(records[0]);

		for (const [index, delay] of [250, 1_000, 5_000, 30_000, 30_000].entries()) {
			const attempts = sockets.length;
			sockets.at(-1)?.emit("connect");
			sockets.at(-1)?.emit("close");
			expect(client.health()).toMatchObject({ state: "backoff", errors: index + 1 });
			vi.advanceTimersByTime(delay - 1);
			expect(sockets).toHaveLength(attempts);
			vi.advanceTimersByTime(1);
			expect(sockets).toHaveLength(attempts + 1);
		}
	});

	it("resets retry progression only after a valid acknowledgement", () => {
		vi.useFakeTimers();
		const sockets: FakeSocket[] = [];
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket as unknown as Socket;
			},
		});
		clients.push(client);
		client.emit(records[0]);

		sockets[0].emit("error", new Error("unavailable"));
		vi.advanceTimersByTime(250);
		sockets[1].emit("error", new Error("unavailable"));
		vi.advanceTimersByTime(1_000);
		sockets[2].emit("connect");
		sockets[2].emit(
			"data",
			'{"accepted":true,"event_id":"tel_1","sequence":1,"error":null}\n',
		);
		expect(client.health()).toMatchObject({ accepted: 1, queued: 0 });

		client.emit(records[1]);
		sockets[2].emit("close");
		vi.advanceTimersByTime(249);
		expect(sockets).toHaveLength(3);
		vi.advanceTimersByTime(1);
		expect(sockets).toHaveLength(4);
	});

	it("disconnects and requeues when oldest sent record misses one-second ACK deadline", () => {
		vi.useFakeTimers();
		const socket = new FakeSocket();
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => socket as unknown as Socket,
		});
		clients.push(client);

		client.emit(records[0]);
		socket.emit("connect");
		vi.advanceTimersByTime(999);
		expect(client.health()).toMatchObject({ state: "connected", errors: 0, queued: 1 });
		vi.advanceTimersByTime(1);

		expect(socket.destroyedByClient).toBe(true);
		expect(client.health()).toMatchObject({ state: "backoff", errors: 1, queued: 1 });
		expect(vi.getTimerCount()).toBe(1);
	});

	it("does not extend ACK deadline when peer trickles data without LF", () => {
		vi.useFakeTimers();
		const socket = new FakeSocket();
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => socket as unknown as Socket,
		});
		clients.push(client);
		client.emit(records[0]);
		socket.emit("connect");

		vi.advanceTimersByTime(500);
		socket.emit("data", '{"accepted":true,"event_id":"tel_1"');
		vi.advanceTimersByTime(499);
		expect(client.health().state).toBe("connected");
		vi.advanceTimersByTime(1);

		expect(client.health()).toMatchObject({ state: "backoff", errors: 1, queued: 1 });
	});

	it("rearms to next already-sent record's original absolute ACK deadline", () => {
		vi.useFakeTimers();
		const socket = new FakeSocket();
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => socket as unknown as Socket,
		});
		clients.push(client);
		client.emit(records[0]);
		client.emit(records[1]);
		socket.emit("connect");

		vi.advanceTimersByTime(900);
		socket.emit(
			"data",
			'{"accepted":true,"event_id":"tel_1","sequence":1,"error":null}\n',
		);
		expect(client.health()).toMatchObject({ state: "connected", accepted: 1, queued: 1 });
		vi.advanceTimersByTime(99);
		expect(client.health().state).toBe("connected");
		vi.advanceTimersByTime(1);

		expect(client.health()).toMatchObject({ state: "backoff", errors: 1, queued: 1 });
	});

	it.each([
		["forward", 86_400_000],
		["backward", -86_400_000],
	] as const)("keeps absolute ACK deadline on monotonic time when wall clock jumps %s", (
		_direction,
		wallJumpMs,
	) => {
		vi.useFakeTimers();
		vi.setSystemTime(1_700_000_000_000);
		let monotonicNow = 0;
		const socket = new FakeSocket();
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => socket as unknown as Socket,
			monotonicNow: () => monotonicNow,
		});
		clients.push(client);
		client.emit(records[0]);
		client.emit(records[1]);
		socket.emit("connect");

		vi.advanceTimersByTime(900);
		monotonicNow = 900;
		vi.setSystemTime(1_700_000_000_000 + wallJumpMs);
		socket.emit(
			"data",
			'{"accepted":true,"event_id":"tel_1","sequence":1,"error":null}\n',
		);
		expect(client.health()).toMatchObject({ state: "connected", accepted: 1, queued: 1 });

		monotonicNow = 999;
		vi.advanceTimersByTime(99);
		expect(client.health().state).toBe("connected");
		monotonicNow = 1_000;
		vi.advanceTimersByTime(1);
		expect(client.health()).toMatchObject({ state: "backoff", errors: 1, queued: 1 });
	});

	it("clears ACK deadline after final valid acknowledgement and on dispose", () => {
		vi.useFakeTimers();
		const socket = new FakeSocket();
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => socket as unknown as Socket,
		});
		clients.push(client);
		client.emit(records[0]);
		socket.emit("connect");
		expect(vi.getTimerCount()).toBe(1);

		socket.emit(
			"data",
			'{"accepted":true,"event_id":"tel_1","sequence":1,"error":null}\n',
		);
		expect(vi.getTimerCount()).toBe(0);

		client.emit(records[1]);
		expect(vi.getTimerCount()).toBe(1);
		client.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("dispose closes socket and timer, clears queue, and prevents reconnect", () => {
		vi.useFakeTimers();
		const sockets: FakeSocket[] = [];
		const client = new TelemetrySocketClient({
			socketPath: "/tmp/telemetry.sock",
			connect: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket as unknown as Socket;
			},
		});
		clients.push(client);
		client.emit(records[0]);
		sockets[0].emit("error", new Error("unavailable"));

		client.dispose();
		client.emit(records[1]);
		vi.advanceTimersByTime(60_000);

		expect(sockets).toHaveLength(1);
		expect(sockets[0].destroyedByClient).toBe(true);
		expect(client.health()).toMatchObject({ state: "disposed", queued: 0 });
	});
});
