import { Connector } from '../types';
import { createCopilotQuotaProvider } from './quota';
import { startCopilotLogin } from './copilot-login';

const CopilotConnector: Connector = {
  id: 'github-copilot',
  name: 'GitHub Copilot',
  vendor: 'GitHub',
  description:
    'Shows your personal Copilot premium-request quota. Sign in once with your browser — ' +
    'no PAT required. Optionally add an org slug to also surface team usage metrics ' +
    '(requires manage_billing:copilot on that org).',
  enabledByDefault: false,
  configSchema: [
    {
      key: 'copilotOauthToken',
      label: 'GitHub Copilot session',
      type: 'secret',
      section: 'quota',
      requiresEnabled: 'quota',
      default: '',
      help:
        'Set automatically by "Sign in to GitHub Copilot" below — you rarely need to touch this. ' +
        'Click Clear to sign out and reconnect with a different account.',
    },
    {
      key: 'org',
      label: 'Org slug (optional)',
      type: 'string',
      section: 'quota',
      requiresEnabled: 'quota',
      default: '',
      help:
        'Leave blank to show only your personal quota. Set to an org slug (e.g. "my-company") ' +
        'to also pull team usage metrics — your account must be an admin of that org and the ' +
        'sign-in scope must include manage_billing:copilot (automatic when you sign in).',
    },
  ],
  quota: {
    defaultIntervalMinutes: 60,
    create: createCopilotQuotaProvider,
  },
  login: {
    label: 'Sign in to GitHub Copilot',
    handler: (ctx, cb) => startCopilotLogin(ctx, cb),
  },
};

export default CopilotConnector;
