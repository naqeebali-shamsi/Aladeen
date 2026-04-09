# Project ground rules

How we work on Aladeen: quality gates, workflow, and scope discipline.

## Commands

Run these before pushing or opening a PR (or at stable checkpoints):

| Command | Purpose |
|--------|---------|
| `npm run build` | Full TypeScript compile to `dist/` (`tsc`) |
| `npm run typecheck` | Typecheck only, no emit (`tsc --noEmit`) — fast feedback |
| `npm run lint` | ESLint on `src/**/*.ts` and `src/**/*.tsx` |
| `npm run test` | Automated tests — wire when a test runner is added |

**Minimum bar today:** `npm run lint` + `npm run typecheck` (and `npm run build` when you need to verify emit). **`test`** is still a placeholder until a test runner is added.

## Workflow

- **Subagents:** Use subagents for parallelizable or isolated subtasks (exploration, research, long refactors split by area). Keep the main thread for integration, API shape, and cross-cutting decisions.
- **Changelog:** Update `CHANGELOG.md` for user-visible behavior, CLI changes, breaking changes, or anything release notes should mention. Skip changelog-only noise for internal refactors with no outward effect (optional one-line under “Internal” if helpful).
- **Commits:** Commit only at **stable, passing** checkpoints (build/typecheck green; tests green when they exist). Prefer small, focused commits over large mixed bags.
- **Patterns:** Follow existing project patterns. When in doubt, reference canonical files (`src/engine/types.ts`, `src/engine/runner.ts`, `src/cli.tsx`) instead of inventing new conventions.
- **Scope:** Change only what the task requires. No drive-by refactors or unrelated files in the same commit unless necessary for the checkpoint to pass.
- **Docs:** Do not add or edit markdown docs unless the task asks for them or they are required for the change (e.g. `CHANGELOG.md`, ground rules).

## Quality bar

- **Type safety:** `strict` TypeScript; fix new errors, don’t paper over with `any` unless justified in a tight spot.
- **Secrets:** Never commit API keys, tokens, or `.env` contents. Redact in logs and examples.
- **Local-first:** Respect local-only and bounded-retry assumptions in `LOCAL_FIRST_AUTONOMY_SPEC.md` when touching the harness path.

## Git

- Branch from the agreed integration branch; keep PRs reviewable in size.
- If a change needs follow-up, track it explicitly (issue or backlog item) rather than half-finished code on `main`.

## References

- Product/spec: `PRD.md`, `LOCAL_FIRST_AUTONOMY_SPEC.md`
- Roadmap: `LOCAL_FIRST_DELIVERY_ROADMAP.md`
- Cleanup discipline (personal/tooling): `CLAUDE_CODE_CLEANUP_HARNESS_SOP/`
