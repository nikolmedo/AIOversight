import * as http from 'http';
import { Connector, ConnectorContext, Detector, EventKind } from '../types';

/**
 * HTTP webhook "detector". This is the universal escape hatch — any tool that
 * AI Oversight can't introspect natively (GitHub Copilot, Gemini /
 * Antigravity, custom shell scripts, MCP tools, IDE hooks, etc.) can POST a
 * single JSON payload and we'll surface a desktop notification.
 *
 * Bound to 127.0.0.1 only — never reachable from the network.
 */
class WebhookDetector implements Detector {
  private server: http.Server | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly token: string | null,
    private readonly ctx: ConnectorContext,
  ) {}

  start(): void {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('error', err => {
      this.ctx.log('error', `[webhook] failed to bind ${this.host}:${this.port}`, {
        err: String(err),
      });
    });
    this.server.listen(this.port, this.host, () => {
      this.ctx.log('info', `[webhook] listening on http://${this.host}:${this.port}/notify`);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'aioversight' }));
      return;
    }
    if (req.method !== 'POST' || (req.url !== '/notify' && req.url !== '/')) {
      res.writeHead(404).end();
      return;
    }
    if (this.token) {
      const provided = req.headers['x-ai-oversight-token'];
      if (provided !== this.token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid token' }));
        return;
      }
    }

    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > 16 * 1024) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
        return;
      }

      const agent = String(body.agent ?? 'External agent').slice(0, 80);
      const kind: EventKind = body.kind === 'finished' ? 'finished' : 'waiting';
      const defaultMsg = kind === 'finished' ? 'has finished' : 'is waiting for your approval';
      const message = String(body.message ?? defaultMsg).slice(0, 500);
      const sessionId = String(body.sessionId ?? body.id ?? `${agent}:${Date.now()}`).slice(0, 200);
      const title = body.title ? String(body.title).slice(0, 120) : undefined;
      const source = body.source ? String(body.source).slice(0, 500) : undefined;

      this.ctx.emit({ sessionId: `webhook:${sessionId}`, agent, kind, message, title, source });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, kind }));
    });
  }
}

const WebhookConnector: Connector = {
  id: 'webhook',
  name: 'HTTP webhook (universal)',
  vendor: 'Custom',
  description:
    'Local HTTP endpoint any tool can POST to (Copilot, Antigravity, MCP hooks, scripts).',
  enabledByDefault: true,
  configSchema: [
    {
      key: 'host',
      label: 'Bind host',
      type: 'string',
      section: 'notifications',
      requiresEnabled: 'notifications',
      default: '127.0.0.1',
      help:
        'Leave as 127.0.0.1 unless you know what you are doing — listening on 0.0.0.0 exposes the endpoint to your network.',
    },
    {
      key: 'port',
      label: 'Port',
      type: 'number',
      section: 'notifications',
      requiresEnabled: 'notifications',
      default: 53127,
    },
    {
      key: 'token',
      label: 'Shared token (optional)',
      type: 'string',
      section: 'notifications',
      requiresEnabled: 'notifications',
      default: '',
      help: 'When set, requests must include `X-AI-Oversight-Token: <token>`.',
    },
  ],
  detector: {
    create(config, ctx) {
      const host = (config.host as string | undefined) || '127.0.0.1';
      const port = Number(config.port ?? 53127);
      const tokenRaw = (config.token as string | undefined) || '';
      return new WebhookDetector(host, port, tokenRaw.trim() || null, ctx);
    },
  },
  integrateInfo: { type: 'http-notify', hostKey: 'host', portKey: 'port', tokenKey: 'token' },
};

export default WebhookConnector;
