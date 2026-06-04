export interface Statement<Row = unknown, RunResult = unknown> {
	run(...params: unknown[]): RunResult;
	all(...params: unknown[]): Row[];
	get(...params: unknown[]): Row | undefined;
}

export interface DbAdapter {
	exec(sql: string): void;
	prepare<Row = unknown, RunResult = unknown>(
		sql: string,
	): Statement<Row, RunResult>;
	transaction<T>(fn: () => T): () => T;
}

export const SETUP_SQL = `
	CREATE TABLE IF NOT EXISTS waiters (
		key TEXT NOT NULL,
		owner_id TEXT PRIMARY KEY,
		session_owner TEXT NOT NULL,
		pid INTEGER NOT NULL,
		enqueued_at INTEGER NOT NULL,
		heartbeat_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS leases (
		key TEXT NOT NULL,
		owner_id TEXT PRIMARY KEY,
		session_owner TEXT NOT NULL,
		pid INTEGER NOT NULL,
		acquired_at INTEGER NOT NULL,
		heartbeat_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS waiters_key_order_idx
		ON waiters (key, enqueued_at, owner_id);
	CREATE INDEX IF NOT EXISTS leases_key_idx
		ON leases (key);
`;