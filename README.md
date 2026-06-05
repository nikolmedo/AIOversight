# AIOversight

![alt text](github-cover.png)

AIOversight is a lightweight, framework-agnostic monitoring tool designed to give you full visibility over your autonomous AI agents. Stop constantly checking terminal logs—AIOversight acts as your agent's control tower, notifying you when tasks are complete or when a human-in-the-loop interaction is required, while keeping a strict eye on your API spend.


## Features

* **Instant Execution Alerts:** Get notified the exact moment your AI agents finish long-running tasks or background workflows.
* **Human-in-the-Loop Interventions:** Receive real-time prompts whenever an agent pauses to request user approval, feedback, or manual input.
* **Universal Token & Quota Tracking:** Monitor remaining credits, token consumption, and monthly quotas across any LLM provider or orchestration framework.
* **Vendor-Agnostic Design:** Built to integrate seamlessly with any framework (LangChain, CrewAI, AutoGPT, custom scripts) and any model provider (OpenAI, Anthropic, Google Gemini, local models).

## How it Works

1. **Trigger:** Your agent script dispatches an event via webhook or SDK.
2. **Notify:** AIOversight alerts you (via Desktop, Push, Slack, or Discord) if the agent finishes or needs input.
3. **Track:** The dashboard updates your remaining AI quota and token budget dynamically.

## Built-in connectors

| Connector | Notifications | Quota | Auth used for quota |
| --- | --- | --- | --- |
| **Cursor IDE** | Watches `~/.cursor/projects/**/agent-transcripts/**/*.jsonl`. | ✓ | IDE access token (`state.vscdb`) → `WorkosCursorSessionToken` cookie fallback. |
| **Anthropic Console** | — | ✓ | Admin API key (`sk-ant-admin01-…`) → `claude.ai` session cookie fallback. |
| **Claude Code** (Anthropic CLI) | Watches `~/.claude/projects/**/*.jsonl`. | — | (Use the Anthropic connector for usage.) |
| **OpenAI / ChatGPT** | — | ✓ | Admin API key against `/v1/organization/usage/*` and `/costs`. |
| **Codex CLI** (OpenAI) | Watches `~/.codex/sessions/**/*.jsonl`. | — | (Use the OpenAI connector for usage.) |
| **GitHub Copilot** | — | ✓ | PAT + org slug against `/orgs/{org}/copilot/usage`. Org-admin only — individual plans are not exposed by GitHub. |
| **Custom JSONL** | Glob paths you provide. | — | — |
| **HTTP webhook** | Local `127.0.0.1:53127/notify` endpoint. Universal escape hatch for Copilot, Gemini / Antigravity, Aider, Cline, MCP servers, CI… | — | — |

The app runs entirely on your machine. API keys / cookies / PATs are encrypted with Electron's `safeStorage` (Keychain on macOS, DPAPI on Windows) and stored in a `secrets.json` separate from the main settings.

## Why a heuristic for notifications?

Each tool signals "I'm waiting on the human" or "I'm done" differently and most of them don't expose a stable API for it. The shared signal that *does* exist is: **the conversation log stops growing.** AIOversight tails the transcript and looks at the last line:

- Assistant turn with a pending `tool_use` block → `waiting`.
- Assistant turn with text only (a final answer) → `finished`.

Both kinds have independent on/off toggles in **General → Notifications**. You can tune the idle threshold per connector.

For tools whose state we can't see from disk (notably GitHub Copilot Chat in VS Code, and various IDE-embedded agents), the **HTTP webhook** is a one-line integration: register a hook in the agent and have it `POST` to the local endpoint, optionally with `"kind":"finished"`.

## Install (from source)

```bash
git clone <this-repo>
cd AIOversight
npm install
npm run dev          # builds + launches Electron
```

Look for the bell icon in your menu bar (macOS) or system tray (Windows). **Left-click** opens a popup with one row per enabled quota integration plus an *Open settings…* button. **Right-click** (or secondary click) opens the context menu (pause / settings / quit).

## Build distributable installers

```bash
npm run package:mac   # produces .dmg + .zip in release/
npm run package:win   # produces .exe (NSIS) + portable .exe in release/
```

Cross-compilation for Windows from macOS works only if Wine is installed; otherwise build on each target OS.

## Settings UI

- **Integrations** — one card per connector grouped by vendor. Each card has independent collapsible **Notifications** and **Quota** subsections. The Notifications subsection only appears for connectors that have a detector; Quota only appears for connectors that have a provider. API key / PAT fields are masked, encrypted at rest, and never round-tripped to the renderer.
- **Recent events** — last 50 fired notifications with a `waiting` / `finished` pill and source file.
- **Logs** — diagnostic output from each connector, the runtime, and the notifier.
- **General** — master notifications switch, independent waiting / finished toggles, per-session cooldown, default quota poll interval, "Show quota summary in tray" toggle, and quiet hours.
- **Webhook recipe** — copy-paste curl example for the universal HTTP webhook, with your current host / port / token filled in.

Settings are persisted in the OS-standard userData directory:
- macOS: `~/Library/Application Support/AI Oversight/{settings,secrets}.json`
- Windows: `%APPDATA%/AI Oversight/{settings,secrets}.json`

`secrets.json` is encrypted; `settings.json` never contains keys, tokens, or cookies.

## Webhook protocol

```
POST http://127.0.0.1:53127/notify
Content-Type: application/json
X-AI-Oversight-Token: <token>      # only if you set one in the UI

{
  "agent":     "Copilot",                        // required
  "message":   "Allow npm install?",             // required
  "kind":      "waiting",                        // "waiting" (default) | "finished"
  "sessionId": "vscode-workspace-abc",           // optional; used for de-dup
  "title":     "Copilot wants to run a command", // optional
  "source":    "/Users/me/projects/myapp"        // optional; clicking the
                                                 // notification reveals this
                                                 // path in Finder/Explorer
}
```

Health check: `GET /health` → `{"ok":true,"service":"aioversight"}`.

### Example: Claude Code hooks (waiting + finished)

In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "curl -sX POST http://127.0.0.1:53127/notify -H 'Content-Type: application/json' -d '{\"agent\":\"Claude Code\",\"kind\":\"waiting\",\"message\":\"Tool approval requested\"}' >/dev/null"
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "curl -sX POST http://127.0.0.1:53127/notify -H 'Content-Type: application/json' -d '{\"agent\":\"Claude Code\",\"kind\":\"finished\",\"message\":\"Turn complete\"}' >/dev/null"
      }]
    }]
  }
}
```

### Example: shell-script wrapper for any CLI agent (fires `finished` on exit)

```bash
#!/usr/bin/env bash
# Wrap any CLI agent so its OS-process exit fires a "finished" notification.
# Usage: ./watch-exit.sh claude --resume my-session
agent="$1"; shift
"$agent" "$@"
status=$?
curl -sX POST http://127.0.0.1:53127/notify \
  -H "Content-Type: application/json" \
  -d "{\"agent\":\"$agent\",\"kind\":\"finished\",\"message\":\"exited with status $status\"}"
```

## Adding a new connector

A connector is a single folder. Minimum viable example — a notifications-only watcher for tool *XYZ* that streams a JSONL transcript:

```
src/main/connectors/xyz/
  index.ts        # default-exports a Connector definition
  detector.ts     # uses TranscriptWatcher with an extractStatus heuristic
```

**`index.ts`:**

```ts
import { Connector } from '../types';
import { createXyzDetector } from './detector';

const XyzConnector: Connector = {
  id: 'xyz',
  name: 'XYZ Agent',
  vendor: 'XYZ Inc.',
  description: 'Watches XYZ transcripts for waiting / finished turns.',
  enabledByDefault: false,
  configSchema: [
    { key: 'paths', label: 'Transcript paths', type: 'paths',
      section: 'notifications', requiresEnabled: 'notifications', default: [] },
    { key: 'idleSeconds', label: 'Idle threshold (seconds)', type: 'number',
      section: 'notifications', requiresEnabled: 'notifications', default: 6 },
  ],
  detector: { create: createXyzDetector },
};

export default XyzConnector;
```

Then register it once in `src/main/connectors/registry.ts`:

```ts
import XyzConnector from './xyz';
export const ALL_CONNECTORS: Connector[] = [
  // …existing entries…
  XyzConnector,
];
```

That's it. The settings UI auto-discovers the new card from `configSchema`, the runtime starts the detector when the user enables Notifications, and the notifier dispatches its events through the same cooldown / quiet-hours pipeline as everything else.

### Adding a quota provider

Add `quota: { defaultIntervalMinutes, create }` to your `Connector` and a `quota.ts` that returns a `QuotaProvider`. Inside `fetch()`:

- Read non-secret config from the `config` argument.
- Read API keys / tokens via `ctx.secret(key)` — they're encrypted by `SecretStore`.
- Return a `QuotaSnapshot` (`buckets[]`, optional `billingCycleStart`/`End`, optional `displayMessages`).

Declare each credential as a `type: 'secret'` field in `configSchema` with `section: 'quota'`. The UI will render a masked password input with Save / Clear buttons; the secret never round-trips back to the renderer.

`QuotaService` polls every enabled provider on its own interval (you set `defaultIntervalMinutes`; the user can override per-connector). The first bucket in your snapshot is the primary one shown both in the tray popup and in the menu-bar tooltip line.

## Architecture

```
┌──────────────────┐   ┌──────────────────┐   ┌────────────┐
│  Connectors      │──▶│  ConnectorRuntime│──▶│  Notifier  │──▶ OS
│  cursor/         │   │  (start/stop +   │   │  (cooldown │   notifications
│  anthropic/      │   │   event bus)     │   │  + quiet h.)│
│  openai/ ...     │   └──────────────────┘   └────────────┘
│                  │
│                  │   ┌──────────────────┐   ┌────────────┐
│                  │──▶│  QuotaService    │──▶│   Tray +   │
│                  │   │  (per-connector  │   │   popup    │
│                  │   │   polling cache) │   │            │
└──────────────────┘   └──────────────────┘   └────────────┘
        ▲                       ▲                  ▲
        │                       │                  │
   secrets via              IPC channels        Integrations
   SecretStore              connectors:* /      tab
   (safeStorage)            quota:*
```

## License

Apache License 2.0
