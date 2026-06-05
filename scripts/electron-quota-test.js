// Quick sanity check: run with `electron scripts/electron-quota-test.js`
//
// Iterates every connector with a quota provider, instantiates it with the
// stored config + secrets via the same SecretStore the app uses, and prints
// each resulting QuotaSnapshot. Exits 0 if at least one succeeds, 1 otherwise.

const path = require('path');
const { app } = require('electron');

app.whenReady().then(async () => {
  const { ALL_CONNECTORS } = require('../dist/main/connectors/registry');
  const { ConnectorRuntime } = require('../dist/main/connectors/runtime');
  const { SecretStore } = require('../dist/main/connectors/secret-store');
  const { SettingsStore } = require('../dist/main/settings-store');

  const settings = new SettingsStore();
  const secrets = new SecretStore();
  const runtime = new ConnectorRuntime(secrets);
  const cfg = settings.get().connectors;

  let okAny = false;
  let failAny = false;

  for (const def of ALL_CONNECTORS) {
    if (!def.quota) continue;
    const enabled = cfg.enabled[def.id]?.quota;
    const cfgFor = runtime.mergeDefaults(def, cfg.config[def.id] ?? {});
    const ctx = runtime.contextFor(def);
    console.log(`\n=== ${def.id} (${def.vendor}) ${enabled ? '' : '[disabled]'} ===`);
    try {
      const provider = def.quota.create(cfgFor, ctx);
      const snap = await provider.fetch();
      console.log(JSON.stringify(snap, null, 2));
      if (snap.ok) okAny = true;
      else failAny = true;
    } catch (err) {
      failAny = true;
      console.error(`[${def.id}] crashed:`, err);
    }
  }

  process.exit(okAny || !failAny ? 0 : 1);
});
