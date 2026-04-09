# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `GROUND_RULES.md` — project commands, workflow, quality bar, and references.
- ESLint flat config (`eslint.config.mjs`) and `npm run lint` / `npm run typecheck` scripts.
- Vitest (`vitest.config.ts`), `npm run test` runs `vitest run`, and a smoke test for `validateBlueprint` (`src/engine/validate.test.ts`).
- `.gitignore` — `node_modules/`, `dist/`, `logs/`, `.aladeen/` run cache, env secrets.
- Local-first harness: engine (runner, context assembler, contracts, verifiers), `src/cli.tsx`, Ink TUI, isolation/runtime helpers, `implement-feature` blueprint and sample JSON blueprints under `blueprints/`.
- Scripts (`scripts/run-blueprint.ts`), product specs (`LOCAL_FIRST_*`, `BLUEPRINT_DESIGN.md`, `RESEARCH_FINDINGS.md`), and `CLAUDE_CODE_CLEANUP_HARNESS_SOP/`.

### Changed

- Minor lint-driven cleanups in adapters, TUI, engine, and runtime types.
- Adapters and `tsconfig` aligned with the React/CLI entry (`src/index.tsx`); legacy `src/index.ts` removed.
- `PRD.md` and `progress.txt` updated to match current direction.
