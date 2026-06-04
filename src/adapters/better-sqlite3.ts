import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import { type DbAdapter, type Statement, SETUP_SQL } from "../db-adapter.js";

const require = createRequire(import.meta.url);

type BetterSqlite3RunInfo = unknown;

type BetterSqlite3Statement<Row = unknown> = Statement<Row, BetterSqlite3RunInfo>;

type BetterSqlite3Database = {
	pragma(sql: string): unknown;
	exec(sql: string): void;
	prepare<Row = unknown>(sql: string): BetterSqlite3Statement<Row>;
	transaction<T>(fn: () => T): () => T;
};

type BetterSqlite3Constructor = new (
	dbPath: string,
) => BetterSqlite3Database;

function loadBetterSqlite3(): BetterSqlite3Constructor {
	const mod = require("better-sqlite3") as
		| BetterSqlite3Constructor
		| { default: BetterSqlite3Constructor };
	return typeof mod === "function" ? mod : mod.default;
}

export function openBetterSqlite3(dbPath: string): DbAdapter {
	mkdirSync(dirname(dbPath), { recursive: true });
	const Database = loadBetterSqlite3();
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.pragma("busy_timeout = 5000");
	db.exec(SETUP_SQL);

	return {
		exec: (sql) => db.exec(sql),
		prepare<Row = unknown, RunResult = unknown>(
			sql: string,
		): Statement<Row, RunResult> {
			const stmt = db.prepare<Row>(sql);
			return {
				run: (...params) => stmt.run(...params) as RunResult,
				all: (...params) => stmt.all(...params),
				get: (...params) => stmt.get(...params),
			};
		},
		transaction: <T>(fn: () => T) => db.transaction(fn),
	};
}