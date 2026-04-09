# Product Requirements Document (PRD)
## Aladeen: Multi-CLI Orchestration Layer

- Version: 0.1 (Draft)
- Date: March 2, 2026
- Author: Research synthesis for Aladeen
- Status: Proposed

## 1. Executive Summary
Aladeen is a cross-platform orchestration layer and terminal-native interface for running multiple AI coding CLIs in parallel, starting with Claude Code, Gemini CLI, and Codex CLI.

The product solves a workflow fragmentation problem: each provider CLI has different authentication, runtime, network, sandbox, and policy behaviors. Aladeen standardizes launch, routing, observability, and UI control without bypassing provider-native constraints.

## 2. Problem Statement
Engineering teams increasingly mix provider CLIs for quality, cost, policy, and model diversity. Today this creates operational overhead:

- Different auth flows (browser OAuth, API keys, cloud-provider credentials).
- Different OS/runtime support (notably Windows and WSL constraints).
- Different sandbox/approval models.
- Different enterprise network/proxy requirements.
- No unified TUI for side-by-side execution and comparison.

Result: wasted setup time, brittle scripts, and frequent failures in enterprise environments.

## 3. Product Vision
Provide one reliable, policy-aware TUI control plane that can:

- Launch and manage multiple provider CLIs consistently.
- Route prompts to one or many providers.
- Normalize output and errors.
- Surface provider-specific blockers before runtime.
- Work on Windows and UNIX-like systems with first-class PTY behavior.

## 4. Goals and Non-Goals
### 4.1 Goals
- Unified orchestration for Claude Code, Gemini CLI, Codex CLI.
- Cross-platform operation: macOS, Linux, and Windows (including WSL workflows where required).
- Enterprise-ready network/auth preflight checks.
- Fast, keyboard-centric, multiplexed TUI.
- Extensible adapter system for future providers.

### 4.2 Non-Goals
- Re-implementing provider models/APIs directly.
- Circumventing provider terms, authentication controls, or safety limits.
- Replacing advanced provider-specific UX completely.

## 5. Target Users
- Solo developers comparing model/provider behavior quickly.
- Platform/dev-tools teams standardizing AI CLI usage.
- Enterprise engineering orgs behind proxies/firewalls.

## 6. Research Findings (as of March 2, 2026)
### 6.1 Provider Constraint Matrix
| Area | Claude Code | Gemini CLI | Codex CLI |
|---|---|---|---|
| Platform support | Native install docs include macOS/Linux + Windows setup paths; WSL is part of supported setup docs | Explicit docs for Linux/macOS/Windows | Install docs state macOS/Linux and Windows via WSL2 |
| Auth modes | Claude.ai login, Console/API key workflows, cloud providers (Bedrock/Vertex/Foundry) | Login with Google, Gemini API key, Vertex AI, headless env-based auth | ChatGPT account sign-in flow or OpenAI API key |
| Enterprise network | Explicit network config docs: proxies, custom CA, mTLS, allowlist domains | Enterprise and troubleshooting docs include proxies/custom cert handling | Config and auth docs emphasize model-provider and auth setup; enterprise proxy details are less centralized than Claude docs |
| Sandbox/security model | Permissions, sandboxing, and enterprise admin controls documented | Built-in sandboxing modes and trusted-folder model documented | Config includes approval and sandbox policy controls |
| Notable hard blockers | SOCKS proxy unsupported; regional/provider model availability can block runs | Missing headless env vars, regional availability, auth flow restrictions in locked-down environments | Windows support path depends on WSL2; OAuth/browser callback constraints in locked-down environments |

### 6.2 Known High-Risk Communication Blockers
1. Auth flow mismatch (interactive browser flow in non-interactive/headless/corporate contexts).
2. Proxy/certificate policy mismatch (TLS interception, missing CA chain, unsupported proxy type).
3. Regional/model/entitlement mismatches (provider or cloud model availability, plan limits).
4. Quota/rate-limit throttling causing intermittent failures.
5. Upstream CLI changes (flags/output formats) causing adapter drift.

### 6.3 Multiplexer and PTY Findings
- `tmux` offers stable session/window/pane primitives and control mode (`-C`) for machine-driven orchestration.
- Zellij adds modern pane/layout UX and plugin model (WASM), with strong UX for multiplexed workflows.
- Windows requires ConPTY/VT-correct handling for terminal fidelity.
- `node-pty` is widely used and cross-platform, but has important caveats:
  - Same privilege level as parent process.
  - Not thread-safe.
  - Modern Windows depends on ConPTY (no legacy winpty path).

## 7. Product Principles
- Provider-native first: do not hide real provider constraints.
- Fail fast: detect blockers before session start.
- Deterministic orchestration: explicit state machine per provider session.
- Safe-by-default logging and secrets handling.
- Keyboard-first UX with low cognitive overhead.

## 8. Functional Requirements
### FR-1 Provider Adapter Layer
- Implement adapters for `claude`, `gemini`, `codex` commands.
- Each adapter exposes:
  - `preflight()`
  - `startSession()`
  - `sendInput()`
  - `interrupt()`
  - `stop()`
  - `health()`
  - `capabilities()`
- Adapter metadata includes:
  - Supported OS modes.
  - Auth requirements.
  - Network requirements.
  - Sandbox/policy knobs.

### FR-2 Preflight Diagnostics
Before launch, Aladeen must validate:
- Binary presence/version.
- Required env vars for selected auth mode.
- Shell/PTY compatibility for host OS.
- Network allowlist/proxy reachability checks.
- Writable workspace and home paths.

### FR-3 Unified Session Orchestration
- Start/stop/restart provider sessions independently.
- Group sessions into a workspace.
- Route one prompt to many providers (fan-out).
- Support per-provider prompt transforms.

### FR-4 Output Normalization
- Normalize streamed output into a canonical event schema:
  - `stdout_chunk`
  - `stderr_chunk`
  - `tool_event`
  - `status_event`
  - `final_response`
- Preserve raw stream for debugging/replay.

### FR-5 TUI Workspace
- Layout modes:
  - Single provider focus.
  - Split compare (2-3 panes).
  - Broadcast command center.
- Core interactions:
  - Provider switch.
  - Prompt broadcast/selective send.
  - Interrupt current run.
  - Session timeline replay.

### FR-6 Policy Engine
- Global and provider-specific guardrails:
  - Allow/deny command patterns.
  - Max runtime per task.
  - Network access policy visibility.
- Show policy causes in-line when blocked.

### FR-7 Multiplexer Integration
- Mode A: internal PTY management (default).
- Mode B: external multiplexer bridge (`tmux` first).
- Preserve detach/reattach semantics for long-running sessions.

### FR-8 Persistence and Recovery
- Persist workspace session graph.
- Recover crashed Aladeen process and reattach where possible.
- Store recent prompts and provider responses with redaction.

### FR-9 Extensibility
- Adapter SDK contract for new CLI providers.
- Capability declaration to avoid hardcoded feature assumptions.

## 9. Non-Functional Requirements
### NFR-1 Performance
- TUI startup target: under 2s on warm run.
- Input-to-render latency target: under 150ms for streamed output.

### NFR-2 Reliability
- Session crash isolation: one provider failure must not collapse workspace.
- 99%+ successful session startup in validated environments.

### NFR-3 Security
- Never log secrets/tokens in plain text.
- Secret storage via OS keychain when available, encrypted fallback otherwise.
- Redact env vars and auth headers in diagnostics.

### NFR-4 Cross-Platform
- Validate behaviors on:
  - macOS (latest-2 major)
  - Ubuntu LTS
  - Windows 11 (native and WSL paths as required by provider)

### NFR-5 Accessibility
- Full keyboard navigation.
- High-contrast palette mode.
- Configurable keybindings and reduced animation mode.

## 10. UX Requirements for TUI
- Dense but legible information hierarchy:
  - Top status rail: provider health/auth/network state.
  - Center panes: live session outputs.
  - Bottom command composer: target selector + prompt.
- Explicit state badges per provider:
  - `ready`, `auth_needed`, `network_blocked`, `rate_limited`, `running`, `errored`.
- Error UX must include:
  - Detection reason.
  - actionable fix command(s).
  - docs link.

## 11. Architecture (Proposed)
### 11.1 Components
- `orchestrator-core`: session lifecycle + routing.
- `provider-adapters/*`: Claude/Gemini/Codex integrations.
- `pty-runtime`: cross-platform PTY abstraction.
- `policy-engine`: guardrails and command controls.
- `state-store`: workspace/session persistence.
- `tui-client`: rendering and keyboard interaction.

### 11.2 Event Model (Canonical)
- All provider streams translated to canonical events.
- Preserve source metadata for debugging.
- Event bus used by TUI + logger + replay.

### 11.3 Adapter Strategy
- Provider-specific shell command contracts, not brittle screen scraping heuristics.
- Preflight checks provider-by-provider.
- Version fingerprinting for compatibility warnings.

## 12. Enterprise/Firewall Strategy
### 12.1 Minimum Network Diagnostics
- DNS resolve and TLS handshake checks for required domains.
- Proxy env detection (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`).
- Custom CA path validation (`NODE_EXTRA_CA_CERTS` where relevant).

### 12.2 Provider-Specific Readiness Checks
- Claude:
  - Validate required allowlist domains.
  - Warn if SOCKS proxy configured.
- Gemini:
  - Validate selected auth mode (interactive vs headless) and required env vars.
  - Check cert/proxy setup in enterprise mode.
- Codex:
  - Validate auth mode (ChatGPT login vs API key).
  - On Windows, verify WSL path assumptions before session launch.

## 13. Risk Register and Mitigations
| Risk | Severity | Mitigation |
|---|---|---|
| Browser OAuth blocked by enterprise policy | High | Headless/API-key/Cloud-auth fallback paths and explicit mode selection |
| Proxy incompatibility (esp. SOCKS for Claude) | High | Preflight proxy type detection + prescriptive remediation |
| TLS interception/custom CA breakage | High | CA validation and guided setup (`NODE_EXTRA_CA_CERTS`) |
| Windows PTY inconsistencies | High | ConPTY-aware runtime layer + Windows-specific test matrix |
| Upstream CLI breaking changes | High | Adapter version checks + compatibility matrix + canary CI |
| Rate limit spikes | Medium | Provider-aware retry/backoff and surfaced quota errors |
| Secret leakage in logs | High | Redaction middleware + secure sinks only |

## 14. Delivery Plan
### Phase 0: Foundation (2 weeks)
- Adapter interface.
- PTY runtime baseline.
- Basic TUI shell.

### Phase 1: MVP (4-6 weeks)
- Claude/Gemini/Codex adapters.
- Preflight diagnostics.
- Split-pane compare UI.
- Session persistence v1.

### Phase 2: Enterprise Hardening (3-4 weeks)
- Network/cert/proxy diagnostics.
- Policy engine.
- Recovery and replay.
- Telemetry with redaction.

### Phase 3: Scale and Extensibility (3 weeks)
- Adapter SDK.
- tmux bridge mode.
- Team config profiles.

## 15. Success Metrics
- Session startup success rate after preflight: >= 99% in supported environments.
- Mean time to diagnose launch failure: < 60 seconds.
- Prompt fan-out success (3 providers) without manual intervention: >= 95%.
- User-reported setup friction reduction: >= 40% vs baseline.

## 16. Open Questions
- Preferred implementation stack for core runtime (Rust vs Node/TypeScript).
- Desired level of external multiplexer dependency (`tmux` optional vs required for long sessions).
- Scope of policy enforcement in v1 (advisory vs hard-block).
- Whether Aladeen should manage provider login flows directly or only detect and delegate.

## 17. Source Notes
Research was synthesized from provider docs and platform references available as of March 2, 2026. Requirements above include inferred integration choices where provider docs do not prescribe orchestration behavior directly.

## 18. References
- Claude Code setup: https://docs.anthropic.com/en/docs/claude-code/setup
- Claude Code authentication: https://docs.anthropic.com/en/docs/claude-code/authentication
- Claude Code network config: https://docs.anthropic.com/en/docs/claude-code/network-config
- Claude Code on Amazon Bedrock: https://docs.anthropic.com/en/docs/claude-code/amazon-bedrock
- Claude Code on Google Vertex AI: https://docs.anthropic.com/en/docs/claude-code/google-vertex-ai
- Anthropic supported countries: https://www.anthropic.com/supported-countries
- Gemini CLI docs home: https://google-gemini.github.io/gemini-cli/
- Gemini CLI authentication: https://google-gemini.github.io/gemini-cli/docs/get-started/authentication.html
- Gemini CLI headless mode: https://google-gemini.github.io/gemini-cli/docs/cli/headless-mode.html
- Gemini CLI sandboxing: https://google-gemini.github.io/gemini-cli/docs/cli/sandbox.html
- Gemini CLI configuration: https://google-gemini.github.io/gemini-cli/docs/cli/configuration.html
- Gemini CLI troubleshooting: https://google-gemini.github.io/gemini-cli/docs/troubleshooting.html
- Gemini API rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- Gemini available regions/policy references: https://ai.google.dev/gemini-api/docs/available-regions
- Codex repository: https://github.com/openai/codex
- Codex install docs: https://raw.githubusercontent.com/openai/codex/main/docs/install.md
- Codex auth docs: https://developers.openai.com/codex/auth
- Codex config reference: https://developers.openai.com/codex/config-reference
- Codex sandboxing/security: https://developers.openai.com/codex/security
- Codex Windows guide: https://developers.openai.com/codex/windows
- tmux man page: https://man7.org/linux/man-pages/man1/tmux.1.html
- Zellij project: https://github.com/zellij-org/zellij
- Windows ConPTY: https://learn.microsoft.com/en-us/windows/console/createpseudoconsole
- Windows VT sequences: https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences
- node-pty: https://github.com/microsoft/node-pty

## 19. Local-First Autonomous PR Harness (V1 Addendum)
### 19.1 Positioning
Aladeen V1 local-first mode targets solo developers who need autonomous feature delivery without cloud model spend. The harness runs entirely with local model providers and deterministic quality gates.

### 19.2 V1 Promise
- Input: feature request.
- Output: PR-ready local branch.
- Constraints:
  - local-only inference
  - bounded retries and bounded run time
  - deterministic pass gates (typecheck, lint, tests, repo policy)

### 19.3 Reuse Strategy
To avoid re-implementation risk in V1:
- Graphify-style graph context can be used as the structure-aware retrieval layer.
- MemPalace-style persistent memory can be used for long-horizon decision recall.
- Paperclip-inspired governance patterns (budgeting and run trace discipline) guide policy design.

### 19.4 V1 Non-Goals
- Multi-user company orchestration.
- Cloud fallback routing.
- Full enterprise control-plane features.
