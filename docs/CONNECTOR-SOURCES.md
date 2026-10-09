# Connector data sources

Registry of where each quota connector gets its numbers, how confident we are in each source, and what the alternatives are. The list of connectors follows `ALL_CONNECTORS` in `src/main/connectors/registry.ts`; `generic-jsonl` and `webhook` have no quota provider and are not listed.

Most of these endpoints are undocumented and change without notice. Read the relevant section before changing a connector, and update it (including the "Last verified" date) when you re-check a source.

## Evidence grades

| Grade | Meaning |
|---|---|
| **Live** | Probed against the real service from a dev machine, with a real account, on the date given. |
| **Vendor** | Taken from the vendor's own docs or the vendor's own source code (for example a merged PR in the vendor's repository). |
| **Community** | Taken from a single community project or issue (or a small number that agree), not confirmed by the vendor or a live probe. |

Connector source files use a matching shorthand in their header comments: `[C]` for community, `[D]` for vendor docs or vendor forum.

## How to re-verify

1. Read the connector's `src/main/connectors/<id>/quota.ts` header. It lists the source order and the confidence of each field.
2. Probe the endpoint with the same headers the code sends, using your own credentials. Never commit tokens, response bodies containing account data, or credential file contents.
   - In Git Bash, `gh api /path` gets rewritten to a filesystem path. Use `gh api path` (no leading slash) or set `MSYS_NO_PATHCONV=1`.
3. Compare the response shape with the parser and with the unit tests in `tests/unit/quota-providers/<id>.test.ts`.
4. Update this file: the grade (only use **Live** for what you actually probed), the date, and any new gap.

---

## Cursor (`cursor`)

- **Source order** (`cursor/quota.ts`):
  1. `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, Connect protocol (`Connect-Protocol-Version: 1`, body `{}`).
  2. `GET https://cursor.com/api/usage-summary` with the browser session cookie.
  3. Legacy `/auth/usage` request counters (counts requests, not dollars; kept last).
  - CSV export (`cursor.com/api/dashboard/export-usage-events-csv`) for spend.
- **Auth**: bearer JWT read from Cursor's `state.vscdb`, key `cursorAuth/accessToken` (the value may be UTF-16LE). The cookie source uses `WorkosCursorSessionToken={sub}::{jwt}`.
- **Evidence**: Community.
- **Last verified**: 2026-09 (research only, no live probe).
- **Field notes**: `GetCurrentPeriodUsage` amounts are in cents; `billingCycleStart` / `billingCycleEnd` are epoch milliseconds delivered as strings. The Stripe and CSV endpoints report dollars.
- **Known gaps**:
  - `api2.cursor.sh/auth/usage-summary` (formerly called first) appears in no source. It is inferred dead; it was not live-tested.
  - `cursor.com/api/usage-summary` intermittently returns a Vercel WAF HTML page with HTTP 403.
  - `export-usage-events-csv` lost its cost column on 2026-08-01 (forum.cursor.com, topic 167193). The replacement, `POST cursor.com/api/dashboard/get-filtered-usage-events`, is not implemented because no request/response contract was available.
- **Official alternative**: the Admin API `api.cursor.com/teams/*` (key prefix `crsr_`) is Teams/Enterprise only. There is no API for individual plans.
- **Not installed**: with no state database at the platform default and no session cookie, the snapshot is `notDetected: true` (neutral "Not installed" state, no backoff). A custom `stateDbPath` that does not exist stays a real error.

## Anthropic Console (`anthropic`)

- **Source order** (`anthropic/quota.ts`):
  1. Admin API, when an admin key is set: `GET https://api.anthropic.com/v1/organizations/usage_report/messages` (`bucket_width=1d&limit=31&group_by[]=model`), then `GET /v1/organizations/cost_report` (`bucket_width=1d&limit=31`; optional). Both page with `has_more` / `next_page` (sent back as `page`); after 5 pages with `has_more` still set the usage report fails with an error instead of showing a partial period, and the cost report drops spend.
  2. claude.ai: `sessionKey` cookie read from a local Chromium-based Claude app profile (`readChromiumCookie`, app name `Claude`), then `GET https://claude.ai/api/organizations` and `/api/organizations/{uuid}/usage`, parsed by `parseClaudeUsage` (shared with `claude-code`): `limits[]` first, then `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet`; an error when no limit is recognized.
- **Auth**: `x-api-key: sk-ant-admin01-…` plus `anthropic-version: 2023-06-01`; the cookie source sends `Cookie: sessionKey=…`. Both send an identifying `User-Agent: AIOversight/<version> (...)`. The admin key comes from platform.claude.com/settings/admin-keys (admin role only; the expiry is chosen at creation). 401 means invalid, expired or revoked; 403 means a key without access.
- **Evidence**: Vendor for the Admin API; the cookie path is not vendor-documented. Sources (2026-10-09): platform.claude.com/docs/en/api/beta/organization/usage_report/retrieve_messages, `.../cost_report/retrieve`, platform.claude.com/docs/en/manage-claude/usage-cost-api and `.../admin-api-keys`.
- **Last verified**: 2026-10-09 (docs).
- **Field notes**: usage results carry `uncached_input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`. Cost results carry `amount` as a decimal string in cents (`"123.45"` is $1.23) and `currency` (always USD today); non-USD rows are skipped. A partially failed cost fetch drops the spend tile; a 429 on the cost report drops only the spend bucket.
- **Vendor constraints**: not available for individual accounts; Claude Enterprise organizations need an Analytics API key, which is not supported; Claude Platform on AWS has no programmatic endpoint; the cost report excludes Priority Tier; poll at most once per minute; data lags about 5 minutes; Anthropic asks for an identifying User-Agent.
- **Known gaps**: the claude.ai cookie path depends on an undocumented endpoint and on a cookie store that only exists for Chromium-based wrappers, not regular browsers.

## Claude Code (`claude-code`)

- **Source** (`claude-code/quota.ts`, `claude-code/browser-session.ts`): a hidden Electron `BrowserWindow` on the persistent partition `persist:claude-quota` loads `https://claude.ai/settings/usage`, resolves the organization, and runs an in-page `fetch('/api/organizations/{uuid}/usage')`. The user signs in once through a visible window opened from the UI. Local spend is estimated separately from transcripts (`~/.claude/projects/**/*.jsonl`, plus `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl` when set) with the shared price table, and is attached even when claude.ai needs sign-in.
- **Parsing** (`parseClaudeUsage` in `claude-code/quota.ts`):
  - **Primary: `limits[]`**, one bucket per entry, with no hardcoded model or kind list. Fields: `kind`, `group`, `percent` (0-100), `severity`, `resets_at` (ISO), `scope` (`null` or `{model: {id, display_name}, surface}`), `is_active`. Kinds observed on 2026-09-17: `session`, `weekly_all`, and `weekly_scoped` with a model scope (`Fable`, `id: null`). `group` sets the window (`session` 5h, `weekly` 7d); an unknown group gets `resetsAt` but no `windowMs`, so the meter uses static thresholds instead of a guessed pace.
  - **Labels and ids** come from the data. `session` and `weekly_all` keep `five-hour` / `seven-day`; a weekly model scope named Opus or Sonnet keeps `weekly-opus` / `weekly-sonnet`; anything else gets `<kind>-model-<slug>` or `<kind>-surface-<slug>` (the slug uses `scope.model.id` when non-null, else the display name), deduplicated with a numeric suffix. Ids key the persisted bucket prefs, so they must not change. If Anthropic starts filling `scope.model.id` for Fable, that bucket's id changes once and its saved prefs reset.
  - `severity` and `is_active` are not used. `is_active: true` sat on `weekly_all` (49%) rather than the higher-looking Fable entry, which suggests "the binding limit", but that meaning is unconfirmed.
  - **Fallback: the named keys** `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` (`{utilization, resets_at}`), read only when `limits[]` is missing, empty, or yields no bucket. When `limits[]` is used they are skipped because they repeat the same data.
  - **Ignored on purpose: codename keys** (`nimbus_quill`, `tangelo`, `cinder_cove`, `seven_day_omelette`, `seven_day_cowork`, `seven_day_oauth_apps`, ...). They are `null` or `{utilization: 0, resets_at: null}`, have no label, and Anthropic adds and renames them freely. `limits[]` is where a real new limit appears.
  - **Money: `spend`** (`used` / `limit` as `{amount_minor, currency, exponent}`, `percent`, `enabled`, `disabled_reason`, `cap`, ...) is the same extra-usage money as `extra_usage` (both reported 0 of 4000 minor USD units, `disabled_reason: out_of_credits`). One `extra-usage` bucket in cents comes from `spend` when it is in USD, otherwise from `extra_usage`. The live `extra_usage` shape is `{monthly_limit, used_credits, currency, decimal_places, ...}`; the older `used`/`limit` keys the parser used to read are not in the current payload.
  - **`seven_day_breakdown.rows[]`** (`{key, display_name, percent}`, share of the week's usage by surface) becomes one display message, for example `This week: Claude Code 93% · Cowork 6% · Chats 1%`, without 0% rows.
- **Local transcripts** (`claude-code/quota.ts`, `claude-code/detector.ts`, `shared/jsonl-spend-scanner.ts`):
  - Claude Code writes one `assistant` line per content block (thinking, text, tool_use), each repeating the request's `message.usage` with a growing `output_tokens`. Spend dedupes per `message.id` + `requestId` within a file (the scanner remembers a 64-entry window per file; `CACHE_VERSION` 4) and keeps the line with the largest `output_tokens`. Local check on 2026-10-09: 7-day spend $580.15 before dedupe, $330.58 after.
  - Cache writes are priced from `usage.cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`; any part of the flat `cache_creation_input_tokens` the split does not cover is billed as 5-minute writes. `usage.speed === "fast"` applies the fast-mode rate. `usage.iterations[]` entries with `type: "advisor_message"` are not in the top-level usage and are priced separately at their own `model`.
  - Claude Code appends metadata lines after the last assistant turn (`queue-operation`, `system` with subtype `stop_hook_summary` or `turn_duration`, `last-prompt`, `bridge-session`, `ai-title`, `pr-link`, `file-history-snapshot`, `permission-mode`, and others), so the notification watcher classifies the newest line whose status is not `unknown`, not the literal last line. Subagent transcripts (`<project>/<session-id>/subagents/agent-<id>.jsonl`, lines with `isSidechain: true`) are skipped for notifications but still scanned for spend.
  - Main session files also carry `cost-state` lines (`totalCostUSD`, `modelUsage`). They are not used.
- **Auth**: the claude.ai web session in the Electron partition.
- **Evidence**: Live. On 2026-09-17 the claude.ai `/api/organizations/{uuid}/usage` response, fetched through the app's `persist:claude-quota` session, included `limits[]` (3 entries: `session`, `weekly_all`, `weekly_scoped` with model `Fable`), `spend`, `seven_day_breakdown`, and the same top-level keys as `api.anthropic.com/api/oauth/usage` returned the same day. Live for the rejected alternatives below (2026-09-16); Community for the claude.ai gate.
- **Last verified**: 2026-10-09 for the local transcript handling; 2026-09-17 for the claude.ai payload.
- **Rejected / not used**:
  - `claude /usage` and `claude -p "/usage"` hang when spawned. `/usage` is a TUI-only Ink dialog and there is no headless or JSON mode (anthropics/claude-code#40793, closed unimplemented). The CLI source was deleted. Do not reintroduce it without a non-interactive output mode.
  - `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <claudeAiOauth.accessToken>` and `anthropic-beta: oauth-2025-04-20` returned 200 (Live). Body: `five_hour` and `seven_day` as `{utilization, resets_at}`; `seven_day_opus` / `seven_day_sonnet` (often null); `extra_usage` `{is_enabled, monthly_limit, used_credits, utilization, currency}`; and a newer `limits[]` array of `{kind: session|weekly_all|weekly_scoped, group, percent, severity, resets_at, scope: {model}, is_active}`. **Deliberately not used**: on 2026-02-20 Anthropic stated that using OAuth tokens from Free/Pro/Max accounts in any other product violates the Consumer Terms (theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access). Community reports persistent 429 responses without `User-Agent: claude-code/<version>` (anthropics/claude-code#31021, closed "not planned").
  - Token location, for reference only: macOS Keychain service `Claude Code-credentials`; Windows/Linux `~/.claude/.credentials.json`; `CLAUDE_CONFIG_DIR` relocates it.
  - `~/.claude/stats-cache.json` holds `/stats` aggregates, not rate limits.
- **Community note**: the claude.ai gate is the User-Agent (the desktop app sends `Claude/<ver> ... Electron/...`), not a JavaScript challenge (xsmyile/sissy#131). The `browser-session.ts` header still describes a Cloudflare challenge; treat that as the original assumption.
- **Sanctioned local alternative (not implemented)**: Claude Code pipes JSON to the configured `statusLine` command's stdin, including `rate_limits.five_hour` and `rate_limits.seven_day` with `used_percentage` and `resets_at`, and `spend_limit` (`used_percentage`, `resets_at`; from v2.1.284 also `used_usd`, `limit_usd`, `period`, gateway only). It still lacks the Fable `weekly_scoped` limit (Vendor: code.claude.com/docs/en/statusline, checked 2026-10-09). No network and no credentials, but the data is only fresh while a Claude Code session runs, and wiring it means editing the user's `~/.claude/settings.json`. Owner decision pending.

## OpenAI (`openai`)

- **Source** (`openai/quota.ts`): `GET https://api.openai.com/v1/organization/usage/completions` (grouped by model), then `GET /v1/organization/costs` (optional).
- **Auth**: `Authorization: Bearer <admin key>`.
- **Evidence**: Vendor (developers.openai.com).
- **Last verified**: 2026-09 (docs).
- **Field notes**: `costs` only supports `1d` buckets. Pagination is cursor-based (`has_more` / `next_page`). "Priority processing" was renamed Fast mode on 2026-07-30 and is billed at 2x.

## Codex CLI (`codex-cli`)

- **Source** (`codex-cli/quota.ts`): `GET https://chatgpt.com/backend-api/wham/usage`. Local spend is estimated from Codex session/rollout JSONL files.
- **Auth**: `Authorization: Bearer <access token>` and `ChatGPT-Account-Id`, read from Codex's `auth.json` (`$CODEX_HOME`, `~/.codex`, `%APPDATA%\codex`). Read-only: the connector never refreshes or rewrites `auth.json`.
- **Evidence**: Vendor (openai/codex source: `codex-rs/codex-backend-openapi-models`, `app-server/tests/suite/v2/rate_limits.rs`).
- **Last verified**: 2026-09 (source).
- **Wire shape**: `rate_limit.primary_window` / `secondary_window` as `{used_percent, limit_window_seconds, reset_after_seconds, reset_at}`, plus `additional_rate_limits[]`, `credits`, and `rate_limit_reset_credits.available_count`. Since about July 2026 the primary window may be the weekly one, so windows are classified by duration (`classifyWindow`), not by position.
- **OAuth facts**: client id `app_EMoamEEZ73f0CkXaXp7hrann`, token URL `https://auth.openai.com/oauth/token`. Refresh tokens rotate, and replaying a used one is a permanent error. Codex's `storage.rs` writes `auth.json` with no lock. Both are why this connector never refreshes.
- **Known gaps**: with `cli_auth_credentials_store = keyring`, `auth.json` may not exist even though the user is signed in.
- **Not installed**: with no `$CODEX_HOME` and none of the default Codex folders, the snapshot is `notDetected: true` (neutral "Not installed" state, no backoff). A folder without `auth.json` keeps the detailed sign-in message.
- **Better local alternative (not implemented)**: spawn `codex app-server` and call JSON-RPC `account/rateLimits/read` (plus the `account/rateLimits/updated` push). Codex then owns auth refresh.

## GitHub Copilot (`github-copilot`)

- **Source** (`github-copilot/quota.ts`):
  - Personal quota: `GET https://api.github.com/copilot_internal/user` (internal, unsupported).
  - Org enrichment (optional, non-fatal): `GET /orgs/{org}/copilot/metrics/reports/organization-28-day/latest` and `.../users-28-day/latest`, then the signed NDJSON behind `download_links`; org billing via `/organizations/{org}/settings/billing/usage/summary`.
- **Token order**: the connector's own device-flow token; `apps.json` / `hosts.json` from `github-copilot` config; `oauth_token` in `gh`'s `hosts.yml`; then `gh auth token`.
- **Evidence**: Live (2026-09-16) for `copilot_internal/user`, the `gh` token behavior and the metrics endpoints.
- **Last verified**: 2026-09-16.
- **Live findings**:
  - `copilot_internal/user` works with a plain `gh` CLI token and no editor-spoofing headers. It returns `quota_snapshots.{premium_interactions, chat, completions}` with AI Credits fields (`credits_used`, fractional `quota_remaining`, `token_based_billing`, `overage_permitted`, `unlimited`) and `quota_reset_date`.
  - A normally authenticated `gh` writes no `oauth_token` into `hosts.yml` (the token is in the OS keyring), so the connector falls back to `gh auth token`.
  - `GET /orgs/{org}/copilot/metrics` returns 404: sunset on 2026-04-02 (github.blog changelog, 2026-01-29). The replacement reports endpoint requires org admin (403 otherwise) and `X-GitHub-Api-Version: 2026-03-10`.
- **Other facts**: Copilot switched to AI Credits on 2026-06-01 (1 credit = $0.01). The device-flow client id `Iv1.b507a08c87ecfe98` (`copilot-login.ts`) is required for `copilot_internal`. `X-GitHub-Api-Version: 2025-04-01` is not a real REST version and was removed.
- **Official alternative**: `GET /users/{username}/settings/billing/premium_request/usage` exists, but needs the `user` scope (a default `gh` token has `gist, read:org, repo, workflow` and gets 404) and is a billing report, not remaining quota.

## OpenRouter (`openrouter`)

- **Source** (`openrouter/quota.ts`): `GET https://openrouter.ai/api/v1/credits` (balance and lifetime usage), then `GET /api/v1/key` (optional: per-key limit, `usage_daily` / `usage_weekly` / `usage_monthly`, `limit_remaining`).
- **Auth**: `Authorization: Bearer <API key>` from the connector secret or `OPENROUTER_API_KEY`.
- **Evidence**: Vendor (openrouter.ai/docs).
- **Last verified**: 2026-09 (docs).
- **Known gaps**: the docs say `/api/v1/credits` needs a management key and returns 403 otherwise. The connector treats `/credits` as required and reports 401/403 as "API key invalid", so a regular inference key can fail the whole snapshot even though `/key` would answer.

## Z.ai (`zai`)

- **Source** (`zai/quota.ts`): `GET https://api.z.ai/api/monitor/usage/quota/limit`.
- **Auth**: `Authorization: Bearer <key>` first; on 401 it retries once with the raw key and `Accept-Language`. Which form is correct is unconfirmed.
- **Evidence**: Community (two independent tools agree on field names).
- **Last verified**: 2026-09 (research only).
- **Wire shape**: `data.level` is the plan; `data.limits[]` has `type` (`TOKENS_LIMIT` | `CREDIT_LIMIT` | `TIME_LIMIT`), `unit` (3 = 5-hour, 6 = weekly), `usage` = the cap, `currentValue` = consumed, `percentage`, `nextResetTime` (epoch ms).
- **Known gaps**: a China host `open.bigmodel.cn` exists (Community) but is not configurable in this connector. `biz/subscription/list` had no source and was removed.

## OpenCode (`opencode`)

- **Source** (`opencode/quota.ts`): `GET https://opencode.ai/zen/go/v1/usage` for quota windows; local spend from OpenCode's SQLite database(s) (`opencode*.db`, `session` table).
- **Auth**: `Authorization: Bearer <OpenCode Go API key>`, from the connector secret or OpenCode's `auth.json`.
- **Evidence**: Community, from a merged vendor PR (anomalyco/opencode#16513).
- **Last verified**: 2026-09 (source).
- **Wire shape**: `usage.{rolling, weekly, monthly}.{status, percent, resetsAt}`. No dollar amounts.
- **Not installed**: with no API key and no data folder at the default locations, the snapshot is `notDetected: true` (neutral "Not installed" state, no backoff). User-configured folders that do not exist stay an error.
- **Known gaps**: which `auth.json` provider id holds the key (`opencode` or `opencode-go`) and its value field (assumed `key`) are unconfirmed; both ids are probed.

## Grok CLI (`grok`)

- **Source** (`grok/quota.ts`): `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` and `/v1/settings` (plan name). Exact spend from `~/.grok/sessions/**/updates.jsonl`.
- **Auth**: the access token from `~/.grok/auth.json` (or `$GROK_HOME`), plus the required header `x-xai-token-auth: xai-grok-cli`. Read-only: no refresh, no rewrite.
- **Evidence**: Community.
- **Last verified**: 2026-09 (research only).
- **Facts**: `auth.json` keys are issuer strings `https://auth.x.ai::<client_id>`, each mapping to `{key, refresh_token, expires_at, ...}`. The OIDC token endpoint is `https://auth.x.ai/oauth2/token`. Spend rows are `turn_completed` entries; `costUsdTicks / 1e10` is USD.

## Devin (`devin`)

- **Source** (`devin/quota.ts`): `POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus` (Connect unary JSON).
- **Auth**: the API key from Devin's `credentials.toml` (candidate paths include `%APPDATA%\devin\`). `api_server_url` can override the host.
- **Evidence**: Vendor for the service name (Exafunction/codeium#148); Community for request metadata and response fields.
- **Last verified**: 2026-09 (research only).
- **Facts**: request metadata must carry `ide_name: "chisel"` (otherwise `permission_denied`) and semver-shaped versions (otherwise HTTP 500). Quota percent fields are omitted when their value is zero.

## Antigravity (`antigravity`)

- **Source** (`antigravity/quota.ts`): Antigravity's local language server, only while the app runs. RPC `RetrieveUserQuotaSummary`, with legacy `GetUserStatus` as fallback.
- **Discovery**: there is no fixed port. Find the `language_server*` process whose command line contains `--app_data_dir antigravity`, and read `--csrf_token` and `--extension_server_port` from its arguments. A small port scan remains as a last resort.
- **Closed app**: when no language-server process is found and the port scan finds nothing, the snapshot is `appNotRunning: true` with "Antigravity isn't running. Open it to see its quota." A process that is found but does not answer is a real error. Default poll interval is 5 minutes (the global `quotaPollMinutes`, default 5, takes precedence when set).
- **Auth**: header `X-Codeium-Csrf-Token`.
- **Evidence**: Community (several tools agree).
- **Last verified**: 2026-09 (research only).
- **Facts**: `remainingFraction` is the remaining share, so used = `1 - remainingFraction`.
- **Known gaps**: https to `127.0.0.1` fails certificate validation in `net.fetch` (self-signed certificate). No bypass was added, on purpose (security decision).

---

## Local spend pricing (`shared/model-pricing.ts`)

- **Vintage**: `PRICING_VINTAGE = '2026-10'`. Last verified 2026-10-09.
- **Evidence**: Vendor (platform.claude.com/docs/en/about-claude/pricing, platform.claude.com/docs/en/release-notes/overview, developers.openai.com/api/docs/pricing).
- Claude rates are keyed by model version, not by family substring. Per 1M tokens:

| Model | Input | Output | 5m write | 1h write | Cache read |
|---|---|---|---|---|---|
| Opus 5.5 | $4 | $20 | $5 | $8 | $0.20 |
| Opus 4.5 to 5 | $5 | $25 | $6.25 | $10 | $0.50 |
| Opus 4 to 4.1 | $15 | $75 | $18.75 | $30 | $1.50 |
| Sonnet 5.5 | $2 | $10 | $2.50 | $4 | $0.10 |
| Sonnet 5 | $2 | $10 | $2.50 | $4 | $0.20 |
| Sonnet 4 to 4.6 | $3 | $15 | $3.75 | $6 | $0.30 |
| Haiku 5.5 | $0.10 | $0.50 | $0.125 | $0.20 | $0.01 |
| Haiku 4.5 | $1 | $5 | $1.25 | $2 | $0.10 |
| Haiku 3.5 | $0.80 | $4 | $1 | $1.60 | $0.08 |
| Fable / Mythos 5.1 | $10 | $50 | $12.50 | $20 | $0.25 |
| Fable / Mythos 5 | $10 | $50 | $12.50 | $20 | $1 |

- **Haiku 5.5** costs 5x in every category when the prompt (input + cache reads + cache writes, output excluded) is over 100,000 tokens.
- **Fast mode** is 2x on Opus 5.5, Opus 5 and Opus 4.8 only (it errors on 4.7; 4.6 bills fast requests at standard rates).
- **Known gaps**: `inference_geo: "us"` (1.1x) is not modelled, since no transcript the repo reads records it. Sonnet 5.5 cache reads logged 2026-09-28 to 2026-10-06 were billed at $0.20, but the dateless table prices them at $0.10.
- The previous substring table billed Opus 4.8 sessions at 3x their real cost.

## Research references

Community tools used for cross-checking field names and endpoints:

- [steipete/CodexBar](https://github.com/steipete/CodexBar): per-provider notes under `docs/*.md`.
- [robinebers/openusage](https://github.com/robinebers/openusage)
- [ryoppippi/ccusage](https://github.com/ryoppippi/ccusage)
