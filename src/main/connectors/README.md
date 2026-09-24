# Connectors

A **connector** is a self-contained integration with one external AI tool. Each connector lives in its own subdirectory and exports a single `Connector` object. Everything the app needs to know about a provider — configuration, detection, quota fetching, authentication, and UI hints — is declared in that object. No other file should reference a connector by its string id.

---

## Directory layout

```
src/main/connectors/
├── registry.ts          # import and register connectors here
├── runtime.ts           # detector lifecycle (do not edit per connector)
├── quota-service.ts     # quota polling (do not edit per connector)
├── secret-store.ts      # encrypted credential storage (do not edit per connector)
├── types.ts             # shared types (Connector, ConnectorContext, …)
├── types-parity.ts      # compile-time guard: renderer copies of the types stay in sync
├── shared/              # helpers reused across connectors
│   ├── transcript-watcher.ts
│   ├── jsonl-spend-scanner.ts
│   ├── model-pricing.ts  # single per-token rate table (PRICING_VINTAGE)
│   └── chromium-cookies.ts
└── <id>/
    ├── index.ts         # required — exports default Connector
    ├── detector.ts      # optional — notification detector
    ├── quota.ts         # optional — quota provider
    └── …               # any other files the connector needs
```

---

## Adding a new connector

1. Create `src/main/connectors/<id>/index.ts` with the `Connector` object (see template below).
2. Add supporting files (`detector.ts`, `quota.ts`, etc.) as needed.
3. Open `src/main/connectors/registry.ts` and:
   - Import the connector: `import MyConnector from './<id>';`
   - Add it to `ALL_CONNECTORS`: `export const ALL_CONNECTORS: Connector[] = [..., MyConnector];`

That's it. The runtime, quota service, settings store, and UI all iterate `ALL_CONNECTORS` generically.

Tests: detector classifiers go in `scripts/smoke.js` (`npm run smoke`); quota providers get `tests/unit/quota-providers/<id>.test.ts` (`npm test`), using `tests/helpers/fake-context.ts` for the `ConnectorContext`.

---

## The `Connector` interface

### Required fields

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Stable, kebab-case identifier. Used as the settings key — never change it after release. |
| `name` | `string` | Human-readable display name shown in the Integrations list and detail drawer. |
| `vendor` | `string` | Company / author name. The Integrations page groups connectors by vendor. |
| `description` | `string` | One or two sentences shown below the connector name. |
| `enabledByDefault` | `boolean` | Whether notifications are on for new installs. Set `false` for connectors that require manual setup. |
| `configSchema` | `ConnectorConfigField[]` | UI form fields. See [Config fields](#config-fields) below. |

### Optional capabilities

#### `detector` — notification detection

```ts
detector?: {
  create(config: Record<string, unknown>, ctx: ConnectorContext): Detector;
}
```

Declare when the connector can detect agent activity (tool calls, finished turns) and emit desktop notifications. The runtime calls `detector.create(...)` when notifications are enabled and calls `detector.start()` / `detector.stop()` on the returned object.

`Detector` interface: `{ start(): void | Promise<void>; stop(): void | Promise<void> }`

Use `shared/transcript-watcher.ts` for JSONL-based tools (cursor, claude-code, codex-cli pattern).

---

#### `quota` — usage polling

```ts
quota?: {
  defaultIntervalMinutes: number;
  create(config: Record<string, unknown>, ctx: ConnectorContext): QuotaProvider;
}
```

Declare when the connector can fetch a usage snapshot. `defaultIntervalMinutes` is the fallback when neither a per-connector override nor the global poll interval is set. The service never polls more often than once a minute.

`QuotaProvider` interface: `{ fetch(): Promise<QuotaSnapshot> }`

`QuotaSnapshot` must be either:
- `{ ok: true, fetchedAt, buckets, displayMessages, … }` — success. Optional: `authMethod`, `trayLine`, `source`, `spend` (spend tiles), plan/billing-cycle fields
- `{ ok: false, fetchedAt, error, source?, needsLogin?, retryAfterMs?, appNotRunning? }` — failure

Rules for providers:

- **`null` means unmeasured.** A bucket's `used` / `limit` / `remaining` (and a spend tile's `costCents` / `tokens`) is `null` when the connector does not know the value; the UI shows "No data". Use `0` only when the value was measured and is genuinely zero.
- **`needsLogin: true` shows a sign-in button only if the connector declares `login`.** A connector whose sign-in happens outside the app (e.g. `codex login`, `grok login`) may still set it, but gets no button — its `error` string must carry the actual instruction.
- **`retryAfterMs`** — set it when the vendor asks you to back off (e.g. HTTP 429 `Retry-After`). The poller will not fetch this connector again before the delay elapses; a manual refresh still goes through. Without it, the service applies its own exponential backoff after failures (capped at 30 minutes).
- **`appNotRunning: true`** — set it only when the data source is a desktop app that is not running (Antigravity's language server, for example), and put a short, actionable notice in `error` ("Antigravity isn't running. Open it to see its quota."). It is an expected state, not an error: the tray popup and tooltip leave the connector out, the settings window shows the notice in neutral styling with status "App not running", and the poller does not count it as a failure (no backoff, and an earlier failure streak is cleared), so data appears within one poll interval after the app opens. An app that is running but does not answer is a real error; do not set the flag then. Do not use it for sources that are files on disk or remote APIs.
- **Bound your requests.** The service abandons a `fetch()` that takes longer than 45 s and records it as a timeout failure, but it cannot cancel it. Put a timeout on each HTTP call (existing connectors use 15 s) so a hung request does not hold resources.
- **Never refresh or rewrite another tool's credentials.** Read a CLI's or IDE's token files, but do not redeem refresh tokens or write back to files like `~/.codex/auth.json` or `~/.grok/auth.json` — the owning tool manages them. On a 401/403, return `needsLogin: true` with an error telling the user to sign in with that tool.
- **Estimated spend** — price tokens through `shared/model-pricing.ts` (`costCentsFor`) rather than keeping a private rate table. An unknown model prices to `null`, not `0`. A connector that returns `spend[]` also sets `quota.reportsSpend: true`: the spend views give each flagged connector its own colour in registry order (six slots, checked in `tests/unit/registry.test.ts`), independent of which snapshots are currently ok. Without the flag its colour falls back to the id hash and can collide with another provider.

---

#### `quotaEnabledByDefault` — quota on by default

```ts
quotaEnabledByDefault?: boolean;
```

When `true`, the quota toggle is enabled out of the box for new installs. Use only for connectors that work without any extra configuration (e.g. Cursor, which reads a local SQLite file). Default: `false`.

---

#### `login` — interactive authentication

```ts
login?: {
  label: string;
  handler: (ctx: ConnectorContext, onComplete: () => void) => void;
}
```

Declare when the app itself can run the sign-in (browser window, OAuth device flow). When the quota provider returns `needsLogin: true`, the UI shows a button labelled `label` — without `login`, no button is shown. When the user clicks it, the runtime calls `handler(ctx, onComplete)`. Call `onComplete()` when authentication finishes so the quota panel refreshes immediately.

The handler receives a `ConnectorContext` with full `setSecret` access — persist tokens there rather than relying on external state.

---

#### `integrateInfo` — Webhook page hint

```ts
integrateInfo?: {
  type: 'http-notify';
  hostKey: string;   // configSchema key whose value is the bind host
  portKey: string;   // configSchema key whose value is the port
  tokenKey?: string; // configSchema key whose value is the optional auth token
}
```

Declare when the connector exposes a local HTTP server that external tools can POST to. The settings window's Advanced → Webhook page uses this to auto-generate a curl example from the current config values. Only one connector should declare this at a time — the page uses the first match.

---

#### `brandColor` — accent color

```ts
brandColor?: string; // hex: #rgb, #rgba, #rrggbb or #rrggbbaa
```

Optional brand accent used in the UI. When omitted or not a well-formed hex color, the renderer picks a categorical palette slot (`--cat-N`): in registry order among `quota.reportsSpend` connectors, otherwise from a hash of the id.

---

## `ConnectorContext` API

The runtime injects a `ConnectorContext` into every `detector.create`, `quota.create`, and `login.handler` call. All secrets and logs are automatically namespaced to the connector's id.

| Method | Description |
|---|---|
| `emit(event)` | Fire an `AgentEvent` (waiting / finished) from a detector. The runtime fills in `detectorId` and `detectedAt`. |
| `log(level, message, meta?)` | Structured log. Levels: `'debug'`, `'info'`, `'warn'`, `'error'`. Surfaces on the Advanced → Logs page. |
| `resolvePath(p)` | Expand `~`, `$HOME`, `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%` in a path string. |
| `cacheDir` | Property, not a method: absolute path to a directory for on-disk caches, shared by all connectors. The runtime does not create it; the first writer does. |
| `secret(key)` | Read an encrypted secret stored under `<id>::<key>`. Returns `null` when absent. |
| `setSecret(key, value)` | Persist an encrypted secret under `<id>::<key>`. Use from `login.handler` to store OAuth tokens. |

---

## Config fields

Each `ConnectorConfigField` in `configSchema` renders one form row in the settings UI.

| Property | Required | Description |
|---|---|---|
| `key` | yes | Settings key. |
| `label` | yes | UI label text. |
| `type` | yes | `'string'` · `'number'` · `'boolean'` · `'paths'` · `'secret'` · `'enum'` |
| `default` | yes | Value used when the user has not set anything. |
| `help` | no | Short help text shown below the input. |
| `section` | no | `'notifications'` (default) · `'quota'` · `'general'` |
| `requiresEnabled` | no | `'notifications'` or `'quota'` — hides the field unless that toggle is on. |
| `options` | `enum` only | `Array<{ value: string; label: string }>` |

**`'secret'` fields** are encrypted via Electron's `safeStorage` and never round-tripped to the renderer. The UI only knows whether a value exists and offers **Set** / **Clear** buttons. Access secrets at runtime via `ctx.secret(key)` and `ctx.setSecret(key, value)`.

---

## Minimal connector example

```ts
// src/main/connectors/my-tool/index.ts
import { Connector } from '../types';
import { createMyToolQuotaProvider } from './quota';

const MyToolConnector: Connector = {
  id: 'my-tool',
  name: 'My Tool',
  vendor: 'Acme Corp',
  description: 'Shows your Acme usage quota.',
  enabledByDefault: false,
  configSchema: [
    {
      key: 'apiKey',
      label: 'API key',
      type: 'secret',
      section: 'quota',
      requiresEnabled: 'quota',
      default: '',
      help: 'Found in your Acme dashboard under Settings → API.',
    },
  ],
  quota: {
    defaultIntervalMinutes: 15,
    create: createMyToolQuotaProvider,
  },
};

export default MyToolConnector;
```

Register it:

```ts
// src/main/connectors/registry.ts
import MyToolConnector from './my-tool';
export const ALL_CONNECTORS: Connector[] = [
  // ... existing connectors
  MyToolConnector,
];
```

No other file needs to change.
