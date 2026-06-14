import type { UserMessageOrigin } from '../../session-trace.js';

// Shared provenance classifier for role=user turns. Agent CLIs funnel three
// different things through the same role=user slot — a human's prompt, harness-
// injected context, and inter-agent/tool protocol traffic — and prompt-quality
// mining must only ever see the human ones (see lesson category `user-prompt`).
//
// This runs at INGEST, where the result is computed once and persisted on
// `user_message.origin`, instead of being re-derived by every downstream
// consumer. The learning-layer detectors read the tag and fall back to this
// same function only for legacy traces written before the field existed, so
// old and new traces agree by construction (no drift between two regex copies).
//
// Grounded in the real 199-session corpus: BOTH codex and claude-code emit all
// three kinds via role=user, with no reliable structural flag (no `isMeta` on
// the records carrying these shapes), so the well-structured TEXT SHAPE is the
// signal. Matching is deliberately conservative — only EXACT known tags and
// headers, never a blanket "starts with '<' or '#'", so a human pasting HTML or
// opening with a markdown heading is never mis-tagged as machine chatter.
// When in doubt the verdict is 'human': a missed injected shape is a tolerable
// false negative (the detectors are outcome-conditioned and need >=2 sessions),
// whereas mis-tagging a human ask would silently hide a real prompt.

// Inter-agent / tool coordination frames (multi-agent teammate & subagent
// traffic, tool-use error envelopes). Leading `</?` so closing tags match too.
const PROTOCOL_TAG_RE =
  /^<\/?(?:teammate-message|subagent_notification|task-notification|tool_use_error)\b/i;
// Bare JSON dispatch envelope: opens with `{` and carries a machine key within
// the first ~200 chars. Window-bounded to avoid scanning a huge pasted blob.
const PROTOCOL_JSON_RE =
  /^\{[\s\S]{0,200}?"(?:type|role|requestId|tool_use_id|agent_path|agent_id|agent_name)"\s*:/;

// Harness-injected context occupying the user slot. `local-command[\w-]*`
// covers the family (`<local-command-caveat>`, `<local-command-stdout>`, ...).
const INJECTED_TAG_RE =
  /^<\/?(?:local-command[\w-]*|environment_context|system-reminder|command-name|command-message|command-args|user-prompt-submit-hook|task|objective|skill|image|user_action|turn_aborted|INSTRUCTIONS)\b/i;
// Slash-command / context dumps the CLIs render as markdown headings.
const INJECTED_HEADING_RE = /^#\s+(?:AGENTS\.md|CLAUDE\.md|In app browser)\b/i;
// Distinctive injected prefixes that are not tags or headings.
const INJECTED_PREFIX_RE = /^(?:Base directory for this skill:|The user interrupted the previous)/i;

export function classifyUserMessageOrigin(text: string): UserMessageOrigin {
  const t = text.trimStart();
  // An empty role=user turn is never a human ask; bucket it with machine noise.
  if (t === '') return 'injected';

  if (PROTOCOL_TAG_RE.test(t) || PROTOCOL_JSON_RE.test(t)) return 'protocol';

  if (
    INJECTED_TAG_RE.test(t)
    || INJECTED_HEADING_RE.test(t)
    || INJECTED_PREFIX_RE.test(t)
    // Claude Code embeds <INSTRUCTIONS>…</INSTRUCTIONS> after a heading line,
    // so this one is matched anywhere, not just at the start.
    || t.includes('<INSTRUCTIONS>')
  ) return 'injected';

  return 'human';
}
