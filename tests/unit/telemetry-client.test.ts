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

	write(): boolean {
		return true;
	}

	destroy(): this {
		this.destroyedByClient = true;
		return this;
	}
}

describe("TelemetrySocketClient", () => {
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
