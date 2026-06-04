import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import { type DbAdapter, type Statement, SETUP_SQL } from "../db-adapter.js";

const require = createRequire(import.meta.url);

type BunSqliteRunInfo = unknown;

type BunSqliteDatabase = {
	exec(sql: string): void;
	prepare<Row = unknown>(sql: string): {
		run(...params: unknown[]): BunSqliteRunInfo;
		all(...params: unknown[]): Row[];
		get(...params: unknown[]): Row | null;
	};
	transaction<T>(fn: () => T): () => T;
};

type BunSqliteConstructor = new (dbPath: string) => BunSqliteDatabase;

function loadBunSqlite(): BunSqliteConstructor {
	try {
		const mod = require("bun:sqlite") as
			| { Database: BunSqliteConstructor }
			| BunSqliteConstructor;
		return typeof mod === "function" ? mod : mod.Database;
	} catch (error) {
		throw new Error("openBunSqlite requires the Bun runtime", {
			cause: error,
		});
	}
}

export function openBunSqlite(dbPath: string): DbAdapter {
	mkdirSync(dirname(dbPath), { recursive: true });
	const Database = loadBunSqlite();
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");
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
				get: (...params) => (stmt.get(...params) as Row | null) ?? undefined,
			};
		},
		transaction: <T>(fn: () => T) => db.transaction(fn),
	};
}