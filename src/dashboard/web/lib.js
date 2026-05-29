// Shared client helpers. No framework, no build — plain ES module.

// THE chart primitive: a width in px whose magnitude is log-scaled, so a
// power-law (45 … 1) and a spike (4197 vs 4) both stay legible in one row set.
export function logWidth(n, max, min = 40, span = 320) {
  if (max <= 0) return min;
  return min + span * (Math.log10(n + 1) / Math.log10(max + 1));
}

export function fmtMs(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d${String(h % 24).padStart(2, '0')}h`;
}

export function fmtCompact(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function pct(x) { return `${(x * 100).toFixed(1)}%`; }

export function basename(p) {
  const cleaned = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return i >= 0 ? cleaned.slice(i + 1) : cleaned;
}

// Escape untrusted session content (asks, outputs, paths) before innerHTML.
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const STATUS_GLYPH = {
  completed: '●', gave_up: '○', errored: '▲', running: '▸',
  interrupted: '◌', unknown: '·', anomaly: '⚠',
};

export const ERR_GLYPH = {
  worktree_collision: '⟳', tool_error: '⚠', timeout: '⏱', auth: '⚿',
  parse_error: '≠', binary_not_found: '⌀', rate_limit: '⇊',
  permission_denied: '⊘', network: '⚡', context_overflow: '∿',
  lint_loop: '⟲', model_refusal: '✋', unknown: '·',
};

export const CLI_PIC = {
  codex: '▤', 'claude-code': '◫', opencode: '◧', aladeen: '◩',
  gemini: '◪', openclaw: '◨',
};

export function cliColor(name) {
  const v = { codex: 'var(--cli-codex)', 'claude-code': 'var(--cli-claude-code)', opencode: 'var(--cli-opencode)', aladeen: 'var(--cli-aladeen)' };
  return v[name] || 'var(--primary)';
}
