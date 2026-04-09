# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `GROUND_RULES.md` — project commands, workflow, quality bar, and references.
- ESLint flat config (`eslint.config.mjs`) and `npm run lint` / `npm run typecheck` scripts.
- Vitest (`vitest.config.ts`), `npm run test` runs `vitest run`, and a smoke test for `validateBlueprint` (`src/engine/validate.test.ts`).

### Changed

- Minor lint-driven cleanups in adapters, TUI, engine, and runtime types.
