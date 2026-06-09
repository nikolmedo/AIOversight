Scaffold a new connector for AI Oversight.

The user will tell you what tool/service the connector is for. Before writing any code:
1. Ask: does it need a **detector** (transcript/event watching), a **quota** provider (API usage data), or both?
2. Ask: does it need an interactive **login** flow (OAuth, browser sign-in)?
3. Ask: what config fields does it need (API key, paths, org slug, etc.)?

Then:
1. Read `src/main/connectors/README.md` for the full authoring guide
2. Read an existing connector of the same type as a reference (e.g. `src/main/connectors/anthropic/index.ts` for quota-only, `src/main/connectors/cursor/index.ts` for detector + quota)
3. Create `src/main/connectors/<id>/index.ts` with the Connector object
4. Create supporting files (`detector.ts`, `quota.ts`, etc.) as needed
5. Add the connector to `src/main/connectors/registry.ts`
6. Run `npx tsc --noEmit` — fix any type errors
7. Run `npm run smoke` — if the connector has a detector, add test cases to `scripts/smoke.js` first

Connector id must be kebab-case and stable (it becomes a settings key stored on disk).
All identifiers, comments, and UI copy must be in English.
