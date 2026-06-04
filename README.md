# pi-concurency-limit

Pi extension that enforces per-model **cross-process** concurrency limits.

It queues provider requests by concrete model key:

- `provider/model`
- example: `anthropic/claude-sonnet-4`

## Scope

This implementation is **cross-process on the local machine**.

It uses a shared SQLite database at:

- `~/.pi/agent/state/concurrency-limit.db`

That means separate Pi processes on the same machine coordinate through shared leases and a FIFO waiter queue.

It is still **not distributed** across multiple machines or containers that do not share the same filesystem.

## Install / use

This package follows the Pi **package with dependencies** layout from the official docs:

```text
pi-concurency-limit/
├── package.json
├── package-lock.json
├── node_modules/
└── src/
    ├── adapters/
    │   ├── better-sqlite3.ts
    │   └── bun-sqlite.ts
    ├── db-adapter.ts
    ├── index.ts
    └── limiter.ts
```

Pi loads the TypeScript sources directly via the package manifest. The extension entrypoint is:

- Node.js runtime: uses `better-sqlite3`
- Bun runtime: uses native `bun:sqlite`

Both runtimes share the same SQL schema through `src/db-adapter.ts`, and `src/limiter.ts` only depends on the injected adapter.

- `./src/index.ts`

If used as a package, `package.json` already exposes:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Configuration

Configuration lives in Pi settings files:

- global: `~/.pi/agent/settings.json`
- project: `.pi/settings.json`

Use a namespaced block like this:

```json
{
  "concurrencyLimits": {
    "default": 2,
    "errorStatusCodes": [429],
    "notifyCooldownMs": 60000,
    "providers": {
      "anthropic": 3,
      "openai": 4
    },
    "models": {
      "anthropic/claude-sonnet-4": 1,
      "openai/gpt-5": 2
    }
  }
}
```

Project settings override global settings.

Inside the merged config, precedence is:

1. `default`
2. `providers[provider]`
3. `models[provider/model]`

That means resolution is: global/default → provider → model.

`errorStatusCodes` is optional. Default: `[429]`.

`notifyCooldownMs` is optional. Default: `60000`.

Pi does not expose rich typed provider errors or retry events to extensions, so this extension classifies failures by HTTP status code only. The configured `errorStatusCodes` list is used for status classification/logging and release reasons.

When a configured error status is seen, the extension also emits a UI warning notification. Notifications are throttled per `provider/model + status`, and suppressed repeats are summarized in the next notification instead of spamming the UI.

## Behavior

- acquires a slot in `before_provider_request`
- stores shared waiters and leases in SQLite
- releases the slot on `message_end` for assistant messages
- uses `agent_end` and `session_shutdown` as safety-net releases
- uses FIFO queueing through `src/limiter.ts`
- opens SQLite through a runtime-specific adapter in `src/adapters/`
- refreshes lease heartbeats while a request is in flight
- prunes stale waiters/leases from dead or expired processes
- never injects custom concurrency fields into provider payloads
- does not read any separate extension JSON config file or env dict

## Debug logging

Enable logs with:

```bash
PI_CONCURRENCY_LIMIT_LOG=1
```

## Development

Pi loads the extension directly from `src/index.ts`; no build output is required.

Optional local check:

```bash
npm run typecheck
```
