import { Connector } from '../types';
import { createOpencodeQuotaProvider, defaultOpencodeDataDirs } from './quota';

const OpencodeConnector: Connector = {
  id: 'opencode',
  name: 'OpenCode',
  vendor: 'OpenCode',
  description:
    'Reads OpenCode\'s local session data (opencode*.db, no API calls) to estimate session/weekly/monthly ' +
    'spend against reference dollar caps, plus a 30-day spend history for the Total Spend card.',
  enabledByDefault: false,
  quotaEnabledByDefault: true,
  configSchema: [
    {
      key: 'dataDirs',
      label: 'OpenCode data directories',
      type: 'paths',
      section: 'quota',
      requiresEnabled: 'quota',
      default: defaultOpencodeDataDirs(),
      help:
        'Directories to search for OpenCode\'s auth.json and opencode*.db files. Defaults follow XDG ' +
        'conventions plus Windows fallbacks. $OPENCODE_DATA_DIR and $XDG_DATA_HOME are also checked ' +
        'automatically when set.',
    },
  ],
  quota: {
    defaultIntervalMinutes: 15,
    create: createOpencodeQuotaProvider,
  },
};

export default OpencodeConnector;
