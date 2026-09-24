/**
 * Realistic fixture builders for AI Oversight unit tests.
 *
 * Shapes here are derived directly from what the source parsers read
 * (see src/main/connectors/*) — not from imagination. Keep these in sync
 * with the connectors when their parsers change.
 */

// --- Claude Code JSONL transcript lines (~/.claude/projects/<...>/<session>.jsonl) ---

export function claudeCodeUserLine(text: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    timestamp: new Date().toISOString(),
  };
}

export function claudeCodeAssistantTextLine(text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      id: 'msg_01ABCDEF',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text }],
    },
    timestamp: new Date().toISOString(),
  };
}

export function claudeCodeAssistantToolUseLine(toolName: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      id: 'msg_01ABCDEF',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'text', text: `Running ${toolName}...` },
        { type: 'tool_use', id: 'toolu_01XYZ', name: toolName, input: { command: 'ls' } },
      ],
    },
    timestamp: new Date().toISOString(),
  };
}

export function claudeCodeToolResultLine(): Record<string, unknown> {
  return {
    type: 'tool_result',
    tool_use_id: 'toolu_01XYZ',
    content: 'file1.txt\nfile2.txt',
    timestamp: new Date().toISOString(),
  };
}

// --- Cursor JSONL transcript lines (~/.cursor/projects/<...>/agent-transcripts/<session>.jsonl) ---

export function cursorUserLine(text: string): Record<string, unknown> {
  return { role: 'user', message: { content: [{ type: 'text', text }] } };
}

export function cursorAssistantTextLine(text: string): Record<string, unknown> {
  return { role: 'assistant', message: { content: [{ type: 'text', text }] } };
}

export function cursorAssistantToolUseLine(toolName: string): Record<string, unknown> {
  return {
    role: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: toolName, input: { command: 'npm test' } }],
    },
  };
}

export function cursorToolLine(): Record<string, unknown> {
  return { role: 'tool', message: { content: 'Command finished with exit code 0' } };
}

// --- Codex CLI JSONL rollouts (~/.codex/sessions/<date>/<session>.jsonl) ---

export function codexUserMessageLine(text: string): Record<string, unknown> {
  return { type: 'user_message', text };
}

export function codexAssistantMessageLine(text: string): Record<string, unknown> {
  return { type: 'assistant_message', text };
}

export function codexFunctionCallLine(name: string): Record<string, unknown> {
  return { type: 'function_call', name, arguments: '{"command":["ls"]}', call_id: 'call_abc123' };
}

export function codexFunctionCallOutputLine(): Record<string, unknown> {
  return { type: 'function_call_output', call_id: 'call_abc123', output: 'file1.txt\nfile2.txt' };
}

// --- Anthropic Admin API: usage_report/messages ---

export function anthropicUsageReportResponse(): Record<string, unknown> {
  return {
    data: [
      {
        starting_at: '2026-06-01T00:00:00Z',
        ending_at: '2026-06-02T00:00:00Z',
        results: [
          {
            uncached_input_tokens: 12_000,
            output_tokens: 4_500,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 200,
            model: 'claude-sonnet-4-5-20250929',
          },
        ],
      },
      {
        starting_at: '2026-06-02T00:00:00Z',
        ending_at: '2026-06-03T00:00:00Z',
        results: [
          {
            uncached_input_tokens: 8_000,
            output_tokens: 3_000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            model: 'claude-sonnet-4-5-20250929',
          },
        ],
      },
    ],
  };
}

// --- Anthropic Admin API: cost_report ---

export function anthropicCostReportResponse(): Record<string, unknown> {
  return {
    data: [
      {
        starting_at: '2026-06-01T00:00:00Z',
        ending_at: '2026-06-02T00:00:00Z',
        results: [{ amount: { value: '1.25', currency: 'USD' }, description: 'Model usage' }],
      },
      {
        starting_at: '2026-06-02T00:00:00Z',
        ending_at: '2026-06-03T00:00:00Z',
        results: [{ amount: { value: '0.75', currency: 'USD' }, description: 'Model usage' }],
      },
    ],
  };
}

export function anthropicErrorResponse(message: string): Record<string, unknown> {
  return { type: 'error', error: { type: 'authentication_error', message } };
}

// --- OpenAI usage/completions + costs ---

export function openAiUsageCompletionsResponse(): Record<string, unknown> {
  return {
    object: 'page',
    data: [
      {
        object: 'bucket',
        start_time: 1748736000,
        end_time: 1748822400,
        results: [
          {
            object: 'organization.usage.completions.result',
            input_tokens: 50_000,
            output_tokens: 12_000,
            input_cached_tokens: 5_000,
            num_model_requests: 42,
            model: 'gpt-4.1',
          },
        ],
      },
      {
        object: 'bucket',
        start_time: 1748822400,
        end_time: 1748908800,
        results: [
          {
            object: 'organization.usage.completions.result',
            input_tokens: 30_000,
            output_tokens: 8_000,
            input_cached_tokens: 2_000,
            num_model_requests: 18,
            model: 'gpt-4.1',
          },
        ],
      },
    ],
    has_more: false,
  };
}

export function openAiCostsResponse(): Record<string, unknown> {
  return {
    object: 'page',
    data: [
      {
        object: 'bucket',
        start_time: 1748736000,
        end_time: 1748822400,
        results: [{ object: 'organization.costs.result', amount: { value: 2.5, currency: 'usd' } }],
      },
      {
        object: 'bucket',
        start_time: 1748822400,
        end_time: 1748908800,
        results: [{ object: 'organization.costs.result', amount: { value: 1.1, currency: 'usd' } }],
      },
    ],
    has_more: false,
  };
}

export function openAiErrorResponse(message: string): Record<string, unknown> {
  return { error: { message, type: 'invalid_request_error', code: 'invalid_api_key' } };
}

// --- GitHub Copilot: copilot_internal/user ---

export function copilotInternalUserResponse(): Record<string, unknown> {
  return {
    copilot_plan: 'individual',
    chat_enabled: true,
    quota_reset_date: '2026-07-01',
    quota_snapshots: {
      premium_interactions: { entitlement: 300, remaining: 214.5, percent_remaining: 71.5, unlimited: false },
      chat: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: true },
      completions: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: true },
    },
  };
}

/**
 * The AI-Credits era payload, redacted from a live 2026-09-16 probe of
 * `copilot_internal/user` on a `business` plan. Note `credits_used: 0` sitting
 * next to a clearly-metered `quota_remaining: 19496.4` — that combination is
 * why `credits_used` is only ever a fallback.
 */
export function copilotTokenBillingUserResponse(): Record<string, unknown> {
  return {
    copilot_plan: 'business',
    quota_reset_date: '2026-10-01',
    token_based_billing: true,
    quota_snapshots: {
      chat: {
        credits_used: 0,
        entitlement: 0,
        has_quota: true,
        overage_count: 0,
        overage_entitlement: 0,
        overage_permitted: false,
        percent_remaining: 100,
        quota_id: 'chat',
        quota_remaining: 0,
        quota_reset_at: 0,
        remaining: 0,
        token_based_billing: true,
        unlimited: true,
      },
      premium_interactions: {
        credits_used: 504,
        entitlement: 20_000,
        has_quota: true,
        overage_count: 0,
        overage_entitlement: 0,
        overage_permitted: true,
        percent_remaining: 97.4,
        quota_id: 'premium_interactions',
        quota_remaining: 19_496.4,
        remaining: 19_496,
        token_based_billing: true,
        unlimited: false,
      },
    },
  };
}

export function copilotErrorResponse(message: string): Record<string, unknown> {
  return { message, documentation_url: 'https://docs.github.com/rest' };
}

/** `.../copilot/metrics/reports/organization-28-day/latest` — report metadata,
 * not metrics. The body lives behind the signed `download_links`. */
export function copilotReportPointerResponse(downloadUrl: string): Record<string, unknown> {
  return {
    download_links: [downloadUrl],
    report_start_day: '2026-08-20',
    report_end_day: '2026-09-16',
  };
}

/** NDJSON (one record per line), which is what the download link actually
 * serves despite the `.json` extension. */
export function copilotOrgReportNdjson(): string {
  return [
    JSON.stringify({
      report_start_day: '2026-08-20',
      report_end_day: '2026-09-16',
      monthly_active_users: 42,
      day_totals: [
        { date: '2026-09-15', daily_active_users: 12 },
        { date: '2026-09-16', daily_active_users: 15 },
      ],
      totals_by_ai_adoption_phase: [
        { phase_number: 1, total_engaged_users: 6 },
        { phase_number: 2, total_engaged_users: 5 },
      ],
    }),
    '',
  ].join('\n');
}

export function copilotUsersReportNdjson(): string {
  return [
    JSON.stringify({ user_id: 1, user_login: 'dev-one', ai_credits_used: 120.5 }),
    JSON.stringify({ user_id: 2, user_login: 'dev-two', ai_credits_used: 80 }),
  ].join('\n');
}

// --- settings.json shapes ---

/** A "new shape" settings.json as written by the current SettingsStore. */
export function currentSettingsJson(): Record<string, unknown> {
  return {
    showNotifications: true,
    notifyOnWaiting: true,
    notifyOnFinished: false,
    perSessionCooldownMs: 45_000,
    quietHours: { startMinute: 22 * 60 + 30, endMinute: 7 * 60 + 15 },
    quotaPollMinutes: 10,
    showQuotaInTray: true,
    connectors: {
      enabled: {
        cursor: { notifications: true, quota: true },
        'claude-code': { notifications: true, quota: false },
        webhook: { notifications: true, quota: false },
      },
      config: {
        cursor: { idleSeconds: 8, paths: ['~/.cursor/projects/**/agent-transcripts/**/*.jsonl'] },
      },
      pollOverrideMinutes: { cursor: 2 },
    },
    recentEvents: [
      {
        ts: 1_749_500_000_000,
        agent: 'Cursor',
        sessionId: 'cursor:abcd1234',
        message: 'Session abcd1234 finished after 12s of quiet.',
        kind: 'finished',
        source: '/Users/dev/.cursor/projects/p/agent-transcripts/abcd1234/abcd1234.jsonl',
      },
    ],
  };
}

/** A "legacy" pre-connectors settings.json (old `detectors` block, Cursor-only era). */
export function legacySettingsJson(): Record<string, unknown> {
  return {
    detectors: {
      enabled: { cursor: true, 'claude-code': false },
      config: {
        cursor: { idleSeconds: 5, paths: ['~/.cursor/projects/**/agent-transcripts/**/*.jsonl'] },
      },
    },
    cursorQuotaPollMinutes: 3,
    showCursorQuotaInTray: true,
    perSessionCooldownMs: 20_000,
    recentEvents: [],
  };
}

export function corruptedJson(): string {
  return '{ "showNotifications": true, "connectors": { "enabled": ';
}

// --- QuotaSnapshot examples (for tray-format tests) ---

export function quotaSnapshotWithBuckets(): Record<string, unknown> {
  return {
    ok: true,
    fetchedAt: Date.now(),
    buckets: [
      { id: 'five-hour', label: '5-Hour Limit', unit: 'requests', used: 42, limit: 100, remaining: 58, enabled: true },
      { id: 'seven-day', label: '7-Day Limit', unit: 'requests', used: 18, limit: 100, remaining: 82, enabled: true },
    ],
    membershipType: 'Claude (claude.ai)',
    displayMessages: ['5-hour limit resets 2h 15m', '7-day limit resets Mon, Jun 15'],
  };
}

export function quotaSnapshotError(message: string): Record<string, unknown> {
  return { ok: false, fetchedAt: Date.now(), error: message };
}

export function quotaSnapshotWithoutLimits(): Record<string, unknown> {
  return {
    ok: true,
    fetchedAt: Date.now(),
    buckets: [
      { id: 'input-tokens', label: 'Input tokens', unit: 'requests', used: 20_000, limit: null, remaining: null, enabled: true },
    ],
    membershipType: 'anthropic-admin',
    displayMessages: [],
  };
}

// --- claude.ai /api/organizations/{uuid}/usage ---

/**
 * A real claude.ai usage body captured on 2026-09-17 (no personal data).
 * Trimmed to a few of the null/zero codename keys, which the parser must
 * ignore. `limits[]` is the only place the Fable weekly limit appears.
 */
export function claudeUsageLiveResponse(): Record<string, unknown> {
  return {
    five_hour: {
      utilization: 3,
      resets_at: '2026-09-17T08:10:00.352021+00:00',
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
      locked_reason: null,
    },
    seven_day: {
      utilization: 49,
      resets_at: '2026-09-18T15:59:59.352040+00:00',
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
      locked_reason: null,
    },
    seven_day_opus: null,
    seven_day_sonnet: null,
    tangelo: null,
    nimbus_quill: {
      utilization: 0,
      resets_at: null,
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
      locked_reason: null,
    },
    cinder_cove: null,
    extra_usage: {
      is_enabled: false,
      monthly_limit: 4000,
      used_credits: 0,
      utilization: 0,
      currency: 'USD',
      decimal_places: 2,
      disabled_reason: 'out_of_credits',
      user_disabled: false,
      spend_limit_reached: false,
      credits_ever_enabled: true,
      daily: null,
      weekly: null,
    },
    limits: [
      {
        kind: 'session',
        group: 'session',
        percent: 3,
        severity: 'normal',
        resets_at: '2026-09-17T08:10:00.352021+00:00',
        scope: null,
        is_active: false,
      },
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 49,
        severity: 'normal',
        resets_at: '2026-09-18T15:59:59.352040+00:00',
        scope: null,
        is_active: true,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 45,
        severity: 'normal',
        resets_at: '2026-09-18T15:59:59.352216+00:00',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        is_active: false,
      },
    ],
    spend: {
      used: { amount_minor: 0, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 4000, currency: 'USD', exponent: 2 },
      percent: 0,
      severity: 'normal',
      enabled: false,
      disabled_reason: 'out_of_credits',
      cap: { money: null, credits: { amount_minor: 4000, exponent: 2 } },
      balance: null,
      auto_reload: null,
      disclaimer: 'Usage credits cover you when you hit your plan limits.',
      can_purchase_credits: false,
      can_toggle: false,
    },
    member_dashboard_available: false,
    seven_day_breakdown: {
      as_of: '2026-09-17T03:14:05.386821+00:00',
      window_started_at: '2026-09-11T15:59:59.352040+00:00',
      rows: [
        { key: 'claude_code', display_name: 'Claude Code', percent: 93 },
        { key: 'chat', display_name: 'Chats', percent: 1 },
        { key: 'cowork', display_name: 'Cowork', percent: 6 },
        { key: 'other', display_name: 'Other', percent: 0 },
      ],
    },
  };
}
