import { Connector } from '../types';
import { createOpencodeQuotaProvider, defaultOpencodeDataDirs } from './quota';

const OpencodeConnector: Connector = {
  id: 'opencode',
  name: 'OpenCode',
  vendor: 'OpenCode',
  description:
    'Tracks OpenCode Zen rolling/weekly/monthly quota windows from the official usage API, plus spend and ' +
    'a 30-day history read from OpenCode\'s local session database.',
  enabledByDefault: false,
  quotaEnabledByDefault: true,
  configSchema: [
    {
      key: 'apiKey',
      label: 'OpenCode Zen API key',
      type: 'secret',
      section: 'quota',
      requiresEnabled: 'quota',
      default: '',
      help:
        'Needed for the quota windows. Left blank, the key is looked up in OpenCode\'s own auth.json, then ' +
        'the OPENCODE_API_KEY environment variable; local spend works without it. Stays encrypted on this ' +
        'machine.',
    },
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
