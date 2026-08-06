import { Connector } from '../types';
import { createDevinQuotaProvider } from './quota';

const DevinConnector: Connector = {
  id: 'devin',
  name: 'Devin',
  vendor: 'Cognition',
  description:
    'Reads Devin\'s local credentials.toml (Windsurf API key) to track weekly/daily quota usage and extra ' +
    'balance from the configured Connect-RPC server.',
  enabledByDefault: false,
  configSchema: [],
  quota: {
    defaultIntervalMinutes: 15,
    create: createDevinQuotaProvider,
  },
};

export default DevinConnector;
