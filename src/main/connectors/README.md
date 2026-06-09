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
├── shared/              # helpers reused across connectors
│   ├── transcript-watcher.ts
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

---

## The `Connector` interface

### Required fields

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Stable, kebab-case identifier. Used as the settings key — never change it after release. |
| `name` | `string` | Human-readable display name shown in the UI card header. |
| `vendor` | `string` | Company / author name, shown as a pill in the UI. |
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

Declare when the connector can fetch a usage snapshot. `defaultIntervalMinutes` is the fallback when the user has not set a custom interval.

`QuotaProvider` interface: `{ fetch(): Promise<QuotaSnapshot> }`

`QuotaSnapshot` must be either:
- `{ ok: true, fetchedAt, buckets, displayMessages, … }` — success
- `{ ok: false, fetchedAt, error, needsLogin? }` — failure; set `needsLogin: true` to show a login button

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

Declare when the quota provider can return `needsLogin: true`. The UI shows a button labelled `label`. When the user clicks it, the runtime calls `handler(ctx, onComplete)`. Call `onComplete()` when authentication finishes so the quota panel refreshes immediately.

The handler receives a `ConnectorContext` with full `setSecret` access — persist tokens there rather than relying on external state.

---

#### `integrateInfo` — Integrate tab hint

```ts
integrateInfo?: {
  type: 'http-notify';
  hostKey: string;   // configSchema key whose value is the bind host
  portKey: string;   // configSchema key whose value is the port
  tokenKey?: string; // configSchema key whose value is the optional auth token
}
```

Declare when the connector exposes a local HTTP server that external tools can POST to. The Integrate tab uses this to auto-generate a curl example from the current config values. Only one connector should declare this at a time.

---

## `ConnectorContext` API

The runtime injects a `ConnectorContext` into every `detector.create`, `quota.create`, and `login.handler` call. All secrets and logs are automatically namespaced to the connector's id.

| Method | Description |
|---|---|
| `emit(event)` | Fire an `AgentEvent` (waiting / finished) from a detector. The runtime fills in `detectorId` and `detectedAt`. |
| `log(level, message, meta?)` | Structured log. Levels: `'debug'`, `'info'`, `'warn'`, `'error'`. Surfaces in the Logs tab. |
| `resolvePath(p)` | Expand `~`, `$HOME`, `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%` in a path string. |
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

**`'secret'` fields** are encrypted via Electron's `safeStorage` and never round-tripped to the renderer. The UI shows `(set)` when a value exists. Access secrets at runtime via `ctx.secret(key)` and `ctx.setSecret(key, value)`.

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
