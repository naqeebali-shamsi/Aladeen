import type { ErrorClass } from '../../session-trace.js';

// Shared error classifier. Lowercases input then walks pattern→class rules
// in order, returning the first match. Built from the union of every
// pattern that previously lived in the four per-ingester copies — this
// gives every ingester slightly better coverage than any one of them
// originally had.
//
// `extraClasses` runs BEFORE the built-in rules so domain-specific
// classifiers (e.g. aladeen-runs's `lint_loop` / `worktree_collision`)
// can shadow the generic `tool_error` default without polluting the
// general patterns shared by every other ingester.

export interface ExtraClassRule {
  pattern: RegExp;
  class: ErrorClass;
}

const BUILTIN_RULES: ReadonlyArray<ExtraClassRule> = [
  { pattern: /rate.?limit|429|too many requests/, class: 'rate_limit' },
  { pattern: /context (length|window).*exceed|too many tokens/, class: 'context_overflow' },
  { pattern: /command not found|not recognized as an internal|is not recognized as|not recognized/, class: 'binary_not_found' },
  { pattern: /permission denied|eacces/, class: 'permission_denied' },
  { pattern: /timed? ?out|etimedout/, class: 'timeout' },
  { pattern: /econnrefused|enotfound|network/, class: 'network' },
  { pattern: /auth|401|403|unauthorized/, class: 'auth' },
  { pattern: /schemaerror|missing key|invalid arguments|parse|syntax|unexpected token/, class: 'parse_error' },
];

export function classifyError(text: string, extraClasses: ReadonlyArray<ExtraClassRule> = []): ErrorClass {
  const t = text.toLowerCase();
  for (const rule of extraClasses) {
    if (rule.pattern.test(t)) return rule.class;
  }
  for (const rule of BUILTIN_RULES) {
    if (rule.pattern.test(t)) return rule.class;
  }
  return 'tool_error';
}
