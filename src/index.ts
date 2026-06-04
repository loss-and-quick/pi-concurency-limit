import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { openBetterSqlite3 } from "./adapters/better-sqlite3.js";
import { openBunSqlite } from "./adapters/bun-sqlite.js";
import { DEFAULT_DB_PATH, Limiter } from "./limiter.js";

const SETTINGS_KEY = "concurrencyLimits";
const DEFAULT_ERROR_STATUS_CODES = [429];
const DEFAULT_NOTIFY_COOLDOWN_MS = 60_000;
const LOG_ENABLED = process.env["PI_CONCURRENCY_LIMIT_LOG"] === "1";

type LimitConfig = {
	default?: unknown;
	providers?: Record<string, unknown>;
	models?: Record<string, unknown>;
	errorStatusCodes?: unknown;
	notifyCooldownMs?: unknown;
};

type Pending = {
	key: string;
	limit: number;
	leaseOwnerId: string;
	acquiredAt: number;
	release: () => Promise<void>;
	status?: number;
	configuredErrorStatus?: boolean;
};

function ts(): string {
	const d = new Date();
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	const ms = String(d.getMilliseconds()).padStart(3, "0");
	return `${hh}:${mm}:${ss}.${ms}`;
}

function log(message: string): void {
	if (LOG_ENABLED) console.warn(`[pi-concurrency-limit] ${ts()} ${message}`);
}

function toLimit(raw: unknown, source: string): number | undefined {
	if (raw === undefined || raw === null) return undefined;
	const num = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(num) || num <= 0) {
		log(
			`ignoring invalid concurrency value ${JSON.stringify(raw)} from ${source}`,
		);
		return undefined;
	}
	return Math.floor(num);
}

function toPositiveInt(raw: unknown, source: string, fallback: number): number {
	if (raw === undefined || raw === null) return fallback;
	const num = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(num) || num <= 0) {
		log(`ignoring invalid ${source} value ${JSON.stringify(raw)}`);
		return fallback;
	}
	return Math.floor(num);
}

function toStatusCodeSet(raw: unknown, source: string): Set<number> {
	const values = raw === undefined ? DEFAULT_ERROR_STATUS_CODES : raw;
	if (!Array.isArray(values)) {
		log(`ignoring ${source}: expected an array of HTTP status codes`);
		return new Set(DEFAULT_ERROR_STATUS_CODES);
	}
	const codes = new Set<number>();
	for (const value of values) {
		const code = typeof value === "number" ? value : Number(value);
		if (!Number.isInteger(code) || code < 100 || code > 599) {
			log(
				`ignoring invalid HTTP status code ${JSON.stringify(value)} from ${source}`,
			);
			continue;
		}
		codes.add(code);
	}
	return codes.size > 0 ? codes : new Set(DEFAULT_ERROR_STATUS_CODES);
}

function parseSettingsConfig(
	text: string,
	source: string,
): LimitConfig | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			log(`ignoring ${source}: expected a JSON object`);
			return undefined;
		}
		const rawConfig = (parsed as Record<string, unknown>)[SETTINGS_KEY];
		if (rawConfig === undefined) return undefined;
		if (
			!rawConfig ||
			typeof rawConfig !== "object" ||
			Array.isArray(rawConfig)
		) {
			log(`ignoring ${source}.${SETTINGS_KEY}: expected an object`);
			return undefined;
		}
		const config = rawConfig as Record<string, unknown>;
		const providers =
			config.providers &&
			typeof config.providers === "object" &&
			!Array.isArray(config.providers)
				? (config.providers as Record<string, unknown>)
				: undefined;
		const models =
			config.models &&
			typeof config.models === "object" &&
			!Array.isArray(config.models)
				? (config.models as Record<string, unknown>)
				: undefined;
		return {
			default: config.default,
			providers,
			models,
			errorStatusCodes: config.errorStatusCodes,
			notifyCooldownMs: config.notifyCooldownMs,
		};
	} catch (err) {
		log(`ignoring ${source}: ${(err as Error).message}`);
		return undefined;
	}
}

function isBunRuntime(): boolean {
	const versions = process.versions as NodeJS.ProcessVersions & {
		bun?: string;
	};
	return typeof versions.bun === "string";
}

function openLimiterDb() {
	return isBunRuntime()
		? openBunSqlite(DEFAULT_DB_PATH)
		: openBetterSqlite3(DEFAULT_DB_PATH);
}

export default function (pi: ExtensionAPI): void {
	const limiter = new Limiter(openLimiterDb());
	const pendingByOwner = new Map<string, Pending>();
	const settingsCache = new Map<
		string,
		{ mtimeMs: number; config: LimitConfig | undefined }
	>();
	const notifyState = new Map<string, { lastAt: number; suppressed: number }>();
	let requestCounter = 0;

	function readScopedConfig(path: string): LimitConfig | undefined {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			return undefined;
		}
		const cached = settingsCache.get(path);
		if (cached && cached.mtimeMs === mtimeMs) return cached.config;
		let config: LimitConfig | undefined;
		try {
			config = parseSettingsConfig(readFileSync(path, "utf8"), path);
		} catch (err) {
			log(`ignoring ${path}: ${(err as Error).message}`);
			config = undefined;
		}
		settingsCache.set(path, { mtimeMs, config });
		return config;
	}

	function readMergedConfig(ctx: ExtensionContext): LimitConfig {
		const globalConfig = readScopedConfig(
			join(homedir(), ".pi", "agent", "settings.json"),
		);
		const projectConfig = readScopedConfig(
			join(ctx.cwd, ".pi", "settings.json"),
		);
		return {
			default: projectConfig?.default ?? globalConfig?.default,
			providers: {
				...(globalConfig?.providers ?? {}),
				...(projectConfig?.providers ?? {}),
			},
			models: {
				...(globalConfig?.models ?? {}),
				...(projectConfig?.models ?? {}),
			},
			errorStatusCodes:
				projectConfig?.errorStatusCodes ?? globalConfig?.errorStatusCodes,
			notifyCooldownMs:
				projectConfig?.notifyCooldownMs ?? globalConfig?.notifyCooldownMs,
		};
	}

	function configuredErrorStatusCodes(ctx: ExtensionContext): Set<number> {
		const config = readMergedConfig(ctx);
		return toStatusCodeSet(
			config.errorStatusCodes,
			`${SETTINGS_KEY}.errorStatusCodes`,
		);
	}

	function notifyConfiguredErrorStatus(
		ctx: ExtensionContext,
		pending: Pending,
		status: number,
	): void {
		if (!ctx.hasUI) return;

		const config = readMergedConfig(ctx);
		const cooldownMs = toPositiveInt(
			config.notifyCooldownMs,
			`${SETTINGS_KEY}.notifyCooldownMs`,
			DEFAULT_NOTIFY_COOLDOWN_MS,
		);

		const notifyKey = `${pending.key}:${status}`;
		const now = Date.now();
		const state = notifyState.get(notifyKey) ?? { lastAt: 0, suppressed: 0 };

		if (state.lastAt && now - state.lastAt < cooldownMs) {
			state.suppressed += 1;
			notifyState.set(notifyKey, state);
			return;
		}

		const suffix =
			state.suppressed > 0 ? ` (+${state.suppressed} suppressed)` : "";
		state.lastAt = now;
		state.suppressed = 0;
		notifyState.set(notifyKey, state);

		ctx.ui.notify(
			`Concurrency limit: ${pending.key} returned HTTP ${status}${suffix}`,
			"warning",
		);
	}

	function resolveLimit(
		ctx: ExtensionContext,
		key: string,
		provider: string,
	): number | undefined {
		const config = readMergedConfig(ctx);
		let raw = config.default;
		let source = "default";
		if (config.providers && provider in config.providers) {
			raw = config.providers[provider];
			source = `providers.${provider}`;
		}
		if (config.models && key in config.models) {
			raw = config.models[key];
			source = `models.${key}`;
		}
		if (raw === undefined) return undefined;
		return toLimit(raw, `${SETTINGS_KEY}.${source}`);
	}

	function modelKey(
		ctx: ExtensionContext,
	): { key: string; provider: string } | undefined {
		const model = ctx.model;
		if (!model) return undefined;
		const provider = String(model.provider);
		return { key: `${provider}/${model.id}`, provider };
	}

	function ownerKey(ctx: ExtensionContext): string {
		return ctx.sessionManager.getSessionFile() ?? "ephemeral-session";
	}

	function nextLeaseOwnerId(owner: string): string {
		requestCounter += 1;
		return `${process.pid}:${Date.now()}:${requestCounter}:${owner}`;
	}

	function classifyRelease(pending: Pending, reason: string): string {
		if (pending.status === undefined) return `${reason}:no-response`;
		if (pending.configuredErrorStatus) {
			return `${reason}:error-status:${pending.status}`;
		}
		if (pending.status >= 500) return `${reason}:http-5xx:${pending.status}`;
		if (pending.status >= 400) return `${reason}:http-4xx:${pending.status}`;
		return `${reason}:status:${pending.status}`;
	}

	async function releaseForOwner(owner: string, reason: string): Promise<void> {
		const held = pendingByOwner.get(owner);
		if (!held) return;
		pendingByOwner.delete(owner);
		const classifiedReason = classifyRelease(held, reason);
		const heldMs = Date.now() - held.acquiredAt;
		await held.release();
		const after = await limiter.stats(held.key, held.limit);
		log(
			`release  owner=${owner} key=${held.key} heldMs=${heldMs} reason=${classifiedReason}` +
				` -> active=${after.active}/${after.limit} queued=${after.queued}`,
		);
	}

	async function releaseAll(reason: string): Promise<void> {
		for (const owner of [...pendingByOwner.keys()]) {
			await releaseForOwner(owner, reason);
		}
	}

	pi.on("before_provider_request", async (_event, ctx) => {
		const ids = modelKey(ctx);
		if (!ids) return;
		const { key, provider } = ids;
		const owner = ownerKey(ctx);

		const limit = resolveLimit(ctx, key, provider);
		if (limit === undefined) return;

		await releaseForOwner(owner, "defensive-before-acquire");

		const leaseOwnerId = nextLeaseOwnerId(owner);
		const before = await limiter.stats(key, limit, leaseOwnerId);
		const willWait = before.active >= limit || before.queued > 0;
		log(
			`request  owner=${owner} key=${key} limit=${limit}` +
				` active=${before.active}/${before.limit} queued=${before.queued}` +
				(willWait ? " -> WAITING" : " -> immediate"),
		);

		const t0 = Date.now();
		const release = await limiter.acquire(
			key,
			limit,
			leaseOwnerId,
			owner,
			ctx.signal,
		);
		const waitMs = Date.now() - t0;
		pendingByOwner.set(owner, {
			key,
			limit,
			leaseOwnerId,
			acquiredAt: Date.now(),
			release,
		});

		const after = await limiter.stats(key, limit, leaseOwnerId);
		log(
			`acquired owner=${owner} key=${key} waitMs=${waitMs}` +
				` active=${after.active}/${after.limit} queued=${after.queued}`,
		);
	});

	pi.on("after_provider_response", (event, ctx) => {
		const owner = ownerKey(ctx);
		const pending = pendingByOwner.get(owner);
		if (!pending) return;
		const errorCodes = configuredErrorStatusCodes(ctx);
		pending.status = event.status;
		pending.configuredErrorStatus = errorCodes.has(event.status);
		log(
			`response owner=${owner} key=${pending.key} status=${event.status}` +
				(pending.configuredErrorStatus ? " configuredError=true" : ""),
		);
		if (pending.configuredErrorStatus) {
			notifyConfiguredErrorStatus(ctx, pending, event.status);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		await releaseForOwner(ownerKey(ctx), "message_end");
	});

	pi.on("agent_end", async () => {
		await releaseAll("agent_end");
	});

	pi.on("session_shutdown", async (event) => {
		await releaseAll(`session_shutdown:${event.reason}`);
	});
}
