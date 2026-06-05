// Headless smoke test for the connector framework. Runs without Electron so we
// can validate the watching/idle/webhook logic in CI or locally in seconds.
//
//   npm run build && node scripts/smoke.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { TranscriptWatcher } = require('../dist/main/connectors/shared/transcript-watcher.js');
const { ALL_CONNECTORS, findConnector } = require('../dist/main/connectors/registry.js');

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function makeCtx(captured, overrides) {
  return {
    emit: e => captured.push(e),
    log: (lvl, msg, meta) => process.env.DEBUG && console.log(`  [${lvl}] ${msg}`, meta ?? ''),
    resolvePath: p => p,
    secret: () => null,
    ...(overrides || {}),
  };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --------------------------------------------------------------------------
// ConnectorRegistry sanity
// --------------------------------------------------------------------------
function testRegistry() {
  console.log('Registry: built-in connectors are present');
  const expectedIds = [
    'cursor',
    'anthropic',
    'claude-code',
    'openai',
    'codex-cli',
    'github-copilot',
    'generic-jsonl',
    'webhook',
  ];
  for (const id of expectedIds) {
    check(`registry has ${id}`, !!findConnector(id), `missing ${id}`);
  }
  // Cursor must have both detector and quota.
  const cursor = findConnector('cursor');
  check('cursor has detector + quota', !!cursor.detector && !!cursor.quota);
  // Webhook is notifications-only.
  const webhook = findConnector('webhook');
  check('webhook has detector but no quota', !!webhook.detector && !webhook.quota);
  // Anthropic / OpenAI / Copilot are quota-only.
  for (const id of ['anthropic', 'openai', 'github-copilot']) {
    const def = findConnector(id);
    check(`${id} has quota`, !!def.quota);
    check(`${id} has no detector`, !def.detector);
  }
  // Schema fields are well-formed.
  for (const def of ALL_CONNECTORS) {
    for (const f of def.configSchema) {
      const okType = ['string', 'number', 'boolean', 'paths', 'secret', 'enum'].includes(f.type);
      check(`${def.id}.${f.key} field type valid`, okType, `type=${f.type}`);
    }
  }
}

// --------------------------------------------------------------------------
// TranscriptWatcher: status classification + kind dispatch
// --------------------------------------------------------------------------
async function testTranscriptWatcher() {
  console.log('TranscriptWatcher: status -> kind dispatch');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-smoke-'));
  const file = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(file, '');

  const captured = [];
  const watcher = new TranscriptWatcher(
    {
      agentName: 'TestAgent',
      detectorId: 'test',
      patterns: [path.join(tmp, '*.jsonl')],
      idleMs: 600,
      extractStatus: line => {
        if (!line) return 'unknown';
        if (line.role === 'user') return 'user';
        if (line.role === 'assistant') {
          return line.tool ? 'pending' : 'final';
        }
        return 'unknown';
      },
      extractSnippet: line => line && line.text,
    },
    makeCtx(captured),
  );
  await watcher.start();
  await sleep(150);

  fs.appendFileSync(file, JSON.stringify({ role: 'user', text: 'do the thing' }) + '\n');
  await sleep(900);
  check('user-only message does not fire', captured.length === 0,
        `got ${captured.length} events: ${JSON.stringify(captured)}`);

  fs.appendFileSync(file, JSON.stringify({ role: 'assistant', text: 'Done. Anything else?' }) + '\n');
  await sleep(1200);
  check('assistant text-only fires once', captured.length === 1,
        `got ${captured.length} events`);
  if (captured[0]) {
    check('text-only event kind is finished', captured[0].kind === 'finished',
          `kind=${captured[0].kind}`);
    check('text-only event has snippet', /Done/.test(captured[0].message));
    check('text-only event has sessionId namespaced', /^test:/.test(captured[0].sessionId));
  }

  await sleep(1000);
  check('does not re-notify same kind on same mtime', captured.length === 1,
        `got ${captured.length} events after extra idle`);

  fs.appendFileSync(file, JSON.stringify({ role: 'user', text: 'now run it' }) + '\n');
  await sleep(400);
  fs.appendFileSync(
    file,
    JSON.stringify({ role: 'assistant', text: 'Running…', tool: 'bash' }) + '\n',
  );
  await sleep(2500);
  check('assistant with pending tool fires waiting', captured.length === 2,
        `got ${captured.length} events after tool turn`);
  if (captured[1]) {
    check('tool-pending event kind is waiting', captured[1].kind === 'waiting',
          `kind=${captured[1].kind}`);
  }

  await watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// Per-connector classifier: Cursor + Claude Code + Codex CLI shape recognition
// --------------------------------------------------------------------------
function testConnectorClassifiers() {
  console.log('Connector classifiers: pending vs final');
  const noopCtx = makeCtx([]);

  const cursor = findConnector('cursor').detector
    .create({ paths: [], idleSeconds: 4 }, noopCtx).opts.extractStatus;
  check('Cursor: assistant + tool_use -> pending',
        cursor({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'edit' }] } }) === 'pending');
  check('Cursor: assistant + text only -> final',
        cursor({ role: 'assistant', message: { content: [{ type: 'text', text: 'All set.' }] } }) === 'final');
  check('Cursor: user -> user',
        cursor({ role: 'user', message: { content: [] } }) === 'user');
  check('Cursor: tool role -> tool',
        cursor({ role: 'tool', message: {} }) === 'tool');

  const claude = findConnector('claude-code').detector
    .create({ paths: [], idleSeconds: 4 }, noopCtx).opts.extractStatus;
  check('Claude Code: type=user -> user',
        claude({ type: 'user' }) === 'user');
  check('Claude Code: type=tool_use -> tool',
        claude({ type: 'tool_use' }) === 'tool');
  check('Claude Code: assistant + tool_use in content -> pending',
        claude({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }) === 'pending');
  check('Claude Code: assistant + text only -> final',
        claude({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }) === 'final');

  const codex = findConnector('codex-cli').detector
    .create({ paths: [], idleSeconds: 4 }, noopCtx).opts.extractStatus;
  check('Codex: function_call -> pending',
        codex({ type: 'function_call', name: 'shell' }) === 'pending');
  check('Codex: function_call_output -> tool',
        codex({ type: 'function_call_output' }) === 'tool');
  check('Codex: assistant_message -> final',
        codex({ type: 'assistant_message', text: 'done' }) === 'final');
  check('Codex: user_message -> user',
        codex({ type: 'user_message' }) === 'user');
}

// --------------------------------------------------------------------------
// Webhook: kind handling
// --------------------------------------------------------------------------
async function testWebhook() {
  console.log('Webhook: POST /notify emits events with the right kind');
  const captured = [];
  const port = 53129 + Math.floor(Math.random() * 100);
  const def = findConnector('webhook');
  const detector = def.detector.create(
    { host: '127.0.0.1', port, token: 'sek' },
    makeCtx(captured),
  );
  await detector.start();
  await sleep(150);

  const post = (body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'POST', host: '127.0.0.1', port, path: '/notify',
        headers: { 'Content-Type': 'application/json', ...headers } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });

  let res = await post({ agent: 'Copilot', message: 'Allow run?' });
  check('rejects without token', res.status === 401, `status ${res.status}`);

  res = await post(
    { agent: 'Copilot', message: 'Allow run?' },
    { 'X-AI-Oversight-Token': 'sek' },
  );
  check('accepts with token', res.status === 200, `status ${res.status}, body ${res.body}`);
  check('emits one webhook event', captured.length === 1, `got ${captured.length} events`);
  if (captured[0]) {
    check('event has agent', captured[0].agent === 'Copilot');
    check('event has message', captured[0].message === 'Allow run?');
    check('sessionId prefixed', /^webhook:/.test(captured[0].sessionId));
    check('default kind is waiting', captured[0].kind === 'waiting',
          `kind=${captured[0].kind}`);
  }

  res = await post(
    { agent: 'Copilot', kind: 'finished', message: 'Build complete' },
    { 'X-AI-Oversight-Token': 'sek' },
  );
  check('accepts kind=finished', res.status === 200,
        `status ${res.status}, body ${res.body}`);
  check('webhook fired second event', captured.length === 2,
        `got ${captured.length} events`);
  if (captured[1]) {
    check('explicit kind=finished propagates', captured[1].kind === 'finished',
          `kind=${captured[1].kind}`);
  }

  res = await post(
    { agent: 'Copilot', kind: 'frobulated', message: 'oops' },
    { 'X-AI-Oversight-Token': 'sek' },
  );
  check('invalid kind falls back to waiting',
        captured.length === 3 && captured[2].kind === 'waiting',
        `kind=${captured[2] && captured[2].kind}`);

  const health = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
  check('GET /health returns ok', health.status === 200 && /"ok":true/.test(health.body));

  await detector.stop();
}

function testIcons() {
  console.log('Icons: generated PNG files exist');
  for (const f of ['tray-icon.png', 'tray-icon@2x.png', 'icon.png']) {
    const p = path.join(__dirname, '..', 'assets', f);
    const exists = fs.existsSync(p);
    const size = exists ? fs.statSync(p).size : 0;
    check(`${f} exists & non-empty`, exists && size > 100, `size=${size}`);
  }
}

(async () => {
  testIcons();
  testRegistry();
  testConnectorClassifiers();
  await testTranscriptWatcher();
  await testWebhook();
  console.log('---');
  if (failures === 0) {
    console.log('All smoke checks passed.');
    process.exit(0);
  } else {
    console.log(`${failures} check(s) failed.`);
    process.exit(1);
  }
})().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
