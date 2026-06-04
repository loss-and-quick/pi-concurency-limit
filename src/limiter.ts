import { homedir } from "node:os";
import { join } from "node:path";

import { type DbAdapter } from "./db-adapter.js";

export type Release = () => Promise<void>;

export type LimiterStats = {
	active: number;
	queued: number;
	limit: number;
	position?: number;
};

type EntryRow = {
	ownerId: string;
	pid: number;
	heartbeatAt: number;
};

export const DEFAULT_DB_PATH = join(
	homedir(),
	".pi",
	"agent",
	"state",
	"concurrency-limit.db",
);
const WAIT_POLL_MS = 250;
const QUEUE_HEARTBEAT_MS = 5_000;
const LEASE_HEARTBEAT_MS = 15_000;
const STALE_ENTRY_MS = 5 * 60_000;

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error;
}

function isAbortError(err: unknown): boolean {
	return (
		(err instanceof DOMException && err.name === "AbortError") ||
		(isNodeError(err) && err.name === "AbortError")
	);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		if (isNodeError(err) && err.code === "EPERM") return true;
		return false;
	}
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class Limiter {
	private readonly db: DbAdapter;

	constructor(db: DbAdapter) {
		this.db = db;
	}

	async acquire(
		key: string,
		limit: number,
		ownerId: string,
		sessionOwner: string,
		signal?: AbortSignal,
	): Promise<Release> {
		const enqueuedAt = Date.now();
		let released = false;
		let heartbeat: NodeJS.Timeout | undefined;
		let lastQueueHeartbeat = 0;

		const release = async () => {
			if (released) return;
			released = true;
			if (heartbeat) clearInterval(heartbeat);
			this.deleteOwnerRows(key, ownerId);
		};

		try {
			for (;;) {
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				const now = Date.now();
				const touchHeartbeat = now - lastQueueHeartbeat >= QUEUE_HEARTBEAT_MS;
				const result = this.tryAcquire({
					key,
					limit,
					ownerId,
					sessionOwner,
					enqueuedAt,
					touchHeartbeat,
					now,
				});

				if (touchHeartbeat) lastQueueHeartbeat = now;

				if (result.acquired) {
					heartbeat = setInterval(() => {
						try {
							this.refreshLease(key, ownerId);
						} catch {
							// Ignore periodic heartbeat errors; stale cleanup recovers.
						}
					}, LEASE_HEARTBEAT_MS);
					heartbeat.unref?.();
					return release;
				}

				await delay(WAIT_POLL_MS, signal);
			}
		} catch (err) {
			if (heartbeat) clearInterval(heartbeat);
			try {
				this.deleteOwnerRows(key, ownerId);
			} catch (cleanupErr) {
				if (!isAbortError(cleanupErr)) throw cleanupErr;
			}
			throw err;
		}
	}

	async stats(
		key: string,
		limit: number,
		ownerId?: string,
	): Promise<LimiterStats> {
		return this.readStats(key, limit, ownerId);
	}

	private tryAcquire(args: {
		key: string;
		limit: number;
		ownerId: string;
		sessionOwner: string;
		enqueuedAt: number;
		touchHeartbeat: boolean;
		now: number;
	}): { acquired: boolean } {
		return this.db.transaction(() => {
			this.pruneStaleEntries(args.key, args.now);
			this.db
				.prepare(
					`INSERT OR IGNORE INTO waiters (
							key, owner_id, session_owner, pid, enqueued_at, heartbeat_at
						) VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					args.key,
					args.ownerId,
					args.sessionOwner,
					process.pid,
					args.enqueuedAt,
					args.now,
				);
			if (args.touchHeartbeat) {
				this.db
					.prepare(
						`UPDATE waiters
							 SET heartbeat_at = ?, session_owner = ?, pid = ?
							 WHERE owner_id = ?`,
					)
					.run(args.now, args.sessionOwner, process.pid, args.ownerId);
			}

			const ordered = this.db
				.prepare<{ ownerId: string }>(
					`SELECT owner_id AS ownerId
						 FROM waiters
						 WHERE key = ?
						 ORDER BY enqueued_at ASC, owner_id ASC`,
				)
				.all(args.key);
			const position =
				ordered.findIndex((entry) => entry.ownerId === args.ownerId) + 1;
			const active = this.countRows("leases", args.key);

			if (position === 1 && active < args.limit) {
				this.db
					.prepare(
						`INSERT OR REPLACE INTO leases (
								key, owner_id, session_owner, pid, acquired_at, heartbeat_at
							) VALUES (?, ?, ?, ?, ?, ?)`,
					)
					.run(
						args.key,
						args.ownerId,
						args.sessionOwner,
						process.pid,
						args.now,
						args.now,
					);
				this.db
					.prepare(`DELETE FROM waiters WHERE owner_id = ?`)
					.run(args.ownerId);
				return { acquired: true };
			}

			return { acquired: false };
		})();
	}

	private readStats(
		key: string,
		limit: number,
		ownerId?: string,
	): LimiterStats {
		return this.db.transaction(() => {
			const now = Date.now();
			this.pruneStaleEntries(key, now);
			const active = this.countRows("leases", key);
			const queued = this.countRows("waiters", key);
			let position: number | undefined;
			if (ownerId) {
				const ordered = this.db
					.prepare<{ ownerId: string }>(
						`SELECT owner_id AS ownerId
						 FROM waiters
						 WHERE key = ?
						 ORDER BY enqueued_at ASC, owner_id ASC`,
					)
					.all(key);
				const found = ordered.findIndex((entry) => entry.ownerId === ownerId);
				position = found >= 0 ? found + 1 : undefined;
			}
			return { active, queued, limit, position };
		})();
	}

	private refreshLease(key: string, ownerId: string): void {
		this.db.transaction(() => {
			this.pruneStaleEntries(key, Date.now());
			this.db
				.prepare(
					`UPDATE leases SET heartbeat_at = ?, pid = ? WHERE owner_id = ?`,
				)
				.run(Date.now(), process.pid, ownerId);
		})();
	}

	private deleteOwnerRows(key: string, ownerId: string): void {
		this.db.transaction(() => {
			this.pruneStaleEntries(key, Date.now());
			this.db.prepare(`DELETE FROM leases WHERE owner_id = ?`).run(ownerId);
			this.db.prepare(`DELETE FROM waiters WHERE owner_id = ?`).run(ownerId);
		})();
	}

	private pruneStaleEntries(key: string, now: number): void {
		this.pruneTable("waiters", key, now);
		this.pruneTable("leases", key, now);
	}

	private pruneTable(
		table: "waiters" | "leases",
		key: string,
		now: number,
	): void {
		const rows = this.db
			.prepare<EntryRow>(
				`SELECT owner_id AS ownerId, pid, heartbeat_at AS heartbeatAt
				 FROM ${table}
				 WHERE key = ?`,
			)
			.all(key);
		const deleteRow = this.db.prepare(
			`DELETE FROM ${table} WHERE owner_id = ?`,
		);
		for (const row of rows) {
			if (this.isFreshEntry(row, now)) continue;
			deleteRow.run(row.ownerId);
		}
	}

	private isFreshEntry(row: EntryRow, now: number): boolean {
		if (!isPidAlive(row.pid)) return false;
		return now - row.heartbeatAt <= STALE_ENTRY_MS;
	}

	private countRows(table: "waiters" | "leases", key: string): number {
		const row = this.db
			.prepare<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE key = ?`)
			.get(key);
		return row?.count ?? 0;
	}
}
