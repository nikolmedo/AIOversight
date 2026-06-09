Run the TypeScript type-checker and report the result.

Steps:
1. Run `npx tsc --noEmit`
2. If zero errors: confirm the project type-checks clean
3. If there are errors: list each one with file path, line number, and a one-line explanation of what's wrong, then fix all of them

Context: this project uses TypeScript strict mode as its only linter (no ESLint). `npx tsc --noEmit` is the canonical way to verify correctness after any change. Always run this before declaring a task done.
