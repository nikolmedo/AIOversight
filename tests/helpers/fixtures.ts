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

export function copilotErrorResponse(message: string): Record<string, unknown> {
  return { message, documentation_url: 'https://docs.github.com/rest' };
}

export function copilotOrgMetricsResponse(): Array<Record<string, unknown>> {
  return [
    {
      date: '2026-06-08',
      total_active_users: 12,
      total_engaged_users: 9,
      total_acceptances_count: 80,
      total_suggestions_count: 200,
      total_chat_turns: 30,
      copilot_ide_code_completions: {
        editors: [
          {
            name: 'vscode',
            models: [{ name: 'default', total_code_acceptances: 10, total_code_suggestions: 25 }],
          },
        ],
      },
      copilot_ide_chat: {
        editors: [{ name: 'vscode', models: [{ name: 'default', total_chats: 5 }] }],
      },
      copilot_dotcom_chat: { models: [{ name: 'default', total_chats: 2 }] },
      copilot_dotcom_pull_requests: { repositories: [{ name: 'aioversight', total_pr_summaries_created: 3 }] },
    },
    {
      date: '2026-06-09',
      total_active_users: 15,
      total_engaged_users: 11,
      total_acceptances_count: 90,
      total_suggestions_count: 220,
      total_chat_turns: 35,
    },
  ];
}

// --- claude /usage CLI output (real ANSI-colored TUI dump) ---

export function claudeCliUsageOutputWithAnsi(): string {
  return [
    '\x1B[1mClaude Code Usage\x1B[0m',
    '',
    '\x1B[36mCurrent session\x1B[0m',
    '  \x1B[32m███████████░░░░░░░░░\x1B[0m  42% used',
    '  Resets 2h 15m',
    '',
    '\x1B[36mCurrent week\x1B[0m',
    '  \x1B[32m████░░░░░░░░░░░░░░░░\x1B[0m  18% used',
    '  Resets Mon, Jun 15',
    '',
    '\x1B[2mWhat\'s contributing to your usage\x1B[0m',
    'Current session  --  35% used',
    'Resets 2h 15m',
  ].join('\n');
}

export function claudeCliUsageOutputPlain(): string {
  return [
    'Claude Code Usage',
    '',
    'Current session',
    '  42% used',
    '  Resets 2h 15m',
    '',
    'Current week',
    '  18% used',
    '  Resets Mon, Jun 15',
  ].join('\n');
}

export function claudeCliUsageOutputUnexpected(): string {
  return 'Error: not logged in. Run `claude login` first.\n';
}

// --- settings.json shapes ---

/** A "new shape" settings.json as written by the current SettingsStore. */
export function currentSettingsJson(): Record<string, unknown> {
  return {
    showNotifications: true,
    notifyOnWaiting: true,
    notifyOnFinished: false,
    perSessionCooldownMs: 45_000,
    quietHours: { startHour: 22, endHour: 7 },
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
