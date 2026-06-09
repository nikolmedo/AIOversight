Run the AI Oversight headless smoke test suite and interpret the results.

Steps:
1. Run `npm run smoke` (this compiles first via `npm run build`, then runs `scripts/smoke.js`)
2. Report the result:
   - If all tests pass: confirm which test groups passed (registry integrity, TranscriptWatcher, JSONL classifiers, WebhookDetector) and state the total count
   - If any test fails: identify the exact failing assertion, explain what it tests, and suggest what likely broke it based on the error message and recent changes
3. If the build step fails before the smoke script runs, report the TypeScript errors and fix them

Context: `scripts/smoke.js` is a headless Node.js integration test that does NOT require Electron. It covers connector registry validation, transcript idle detection, JSONL classifiers for each detector connector, and the webhook HTTP server. It runs against compiled `dist/` output.
