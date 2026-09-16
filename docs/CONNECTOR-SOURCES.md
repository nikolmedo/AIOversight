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

## Anthropic Console (`anthropic`)

- **Source order** (`anthropic/quota.ts`):
  1. Admin API, when an admin key is set: `GET https://api.anthropic.com/v1/organizations/usage_report/messages`, then `GET /v1/organizations/cost_report` (optional, failure is non-fatal).
  2. claude.ai: `sessionKey` cookie read from a local Chromium-based Claude app profile (`readChromiumCookie`, app name `Claude`), then `GET https://claude.ai/api/organizations` and `/api/organizations/{uuid}/usage`.
- **Auth**: `x-api-key: sk-ant-admin01-…` plus `anthropic-version: 2023-06-01`; the cookie source sends `Cookie: sessionKey=…`. Both send an identifying `User-Agent: AIOversight/<version> (...)`.
- **Evidence**: Vendor for the Admin API (platform.claude.com/docs/en/manage-claude/usage-cost-api). The cookie path is not vendor-documented.
- **Last verified**: 2026-09 (docs).
- **Vendor constraints**: not available for individual accounts; Enterprise organizations use the Analytics API instead; poll at most once per minute; data lags about 5 minutes; Anthropic asks for an identifying User-Agent.
- **Known gaps**: the claude.ai cookie path depends on an undocumented endpoint and on a cookie store that only exists for Chromium-based wrappers, not regular browsers.

## Claude Code (`claude-code`)

- **Source** (`claude-code/quota.ts`, `claude-code/browser-session.ts`): a hidden Electron `BrowserWindow` on the persistent partition `persist:claude-quota` loads `https://claude.ai/settings/usage`, resolves the organization, and runs an in-page `fetch('/api/organizations/{uuid}/usage')`. The user signs in once through a visible window opened from the UI. Local spend is estimated separately from transcripts (`~/.claude/projects/**/*.jsonl`) with the shared price table.
- **Auth**: the claude.ai web session in the Electron partition.
- **Evidence**: Live for the rejected alternatives below (2026-09-16); Community for the claude.ai gate.
- **Last verified**: 2026-09-16.
- **Rejected / not used**:
  - `claude /usage` and `claude -p "/usage"` hang when spawned. `/usage` is a TUI-only Ink dialog and there is no headless or JSON mode (anthropics/claude-code#40793, closed unimplemented). The CLI source was deleted. Do not reintroduce it without a non-interactive output mode.
  - `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <claudeAiOauth.accessToken>` and `anthropic-beta: oauth-2025-04-20` returned 200 (Live). Body: `five_hour` and `seven_day` as `{utilization, resets_at}`; `seven_day_opus` / `seven_day_sonnet` (often null); `extra_usage` `{is_enabled, monthly_limit, used_credits, utilization, currency}`; and a newer `limits[]` array of `{kind: session|weekly_all|weekly_scoped, group, percent, severity, resets_at, scope: {model}, is_active}`. **Deliberately not used**: on 2026-02-20 Anthropic stated that using OAuth tokens from Free/Pro/Max accounts in any other product violates the Consumer Terms (theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access). Community reports persistent 429 responses without `User-Agent: claude-code/<version>` (anthropics/claude-code#31021, closed "not planned").
  - Token location, for reference only: macOS Keychain service `Claude Code-credentials`; Windows/Linux `~/.claude/.credentials.json`; `CLAUDE_CONFIG_DIR` relocates it.
  - `~/.claude/stats-cache.json` holds `/stats` aggregates, not rate limits.
- **Community note**: the claude.ai gate is the User-Agent (the desktop app sends `Claude/<ver> ... Electron/...`), not a JavaScript challenge (xsmyile/sissy#131). The `browser-session.ts` header still describes a Cloudflare challenge; treat that as the original assumption.
- **Sanctioned local alternative (not implemented)**: Claude Code pipes JSON to the configured `statusLine` command's stdin, including `rate_limits.five_hour` and `rate_limits.seven_day` with `used_percentage` and `resets_at` (Vendor: code.claude.com/docs/en/statusline). No network and no credentials, but the data is only fresh while a Claude Code session runs, and wiring it means editing the user's `~/.claude/settings.json`. Owner decision pending.

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

- **Vintage**: `PRICING_VINTAGE = '2026-09'`.
- **Evidence**: Vendor (platform.claude.com/docs/en/about-claude/pricing, developers.openai.com/api/docs/pricing).
- Claude rates are keyed by model version, not by family substring. Per 1M tokens, input/output: Opus 4.5 and later $5/$25; Opus 4.1 and earlier $15/$75; Sonnet 5 $2/$10; Sonnet 4.x $3/$15; Haiku 4.5 $1/$5; Fable/Mythos 5.x $10/$50, with cache read $0.25 from 5.1.
- The previous substring table billed Opus 4.8 sessions at 3x their real cost.

## Research references

Community tools used for cross-checking field names and endpoints:

- [steipete/CodexBar](https://github.com/steipete/CodexBar): per-provider notes under `docs/*.md`.
- [robinebers/openusage](https://github.com/robinebers/openusage)
- [ryoppippi/ccusage](https://github.com/ryoppippi/ccusage)
