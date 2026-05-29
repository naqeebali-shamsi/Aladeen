import os from 'node:os';
import type { Scrubbing } from './session-trace.js';

// Scrubbing strips secrets/PII from text before it enters a SessionTrace.
// Versioned so re-ingesting source artifacts with a newer scrubber produces
// strictly better traces. Inline markers look like [REDACTED:<reason>] for
// trivial grep + replay.

export const SCRUBBER_VERSIONS = {
  secret: '1',
  'path-home': '1',
  'env-value': '1',
  pii: '1',
  'shell-output': '1',
  'file-content': '1',
} as const;

// High-confidence secret patterns. False negatives are acceptable here (a
// stronger pass can be added later and re-run); false positives are not, so
// we keep patterns conservative.
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{32,}\b/g },
  { name: 'github-pat', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: 'github-pat-classic', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

export interface ScrubberOptions {
  // Override home directory for testing. Defaults to os.homedir().
  homeDir?: string;
  // Cap on tool/shell output length per scrubbed string. Default 2000.
  maxOutputChars?: number;
  // When true, leave shell output untruncated. Useful for tests only.
  preserveOutput?: boolean;
}

export interface ScrubResult {
  text: string;
  appliedPasses: Array<{ reason: keyof typeof SCRUBBER_VERSIONS; count: number }>;
}

export class Scrubber {
  private readonly homeDir: string;
  private readonly maxOutputChars: number;
  private readonly preserveOutput: boolean;

  constructor(opts: ScrubberOptions = {}) {
    this.homeDir = opts.homeDir ?? os.homedir();
    this.maxOutputChars = opts.maxOutputChars ?? 2000;
    this.preserveOutput = opts.preserveOutput ?? false;
  }

  // Scrub a message string (user input, agent reply, error message).
  scrubMessage(input: string): ScrubResult {
    return this.run(input, { truncate: false });
  }

  // Scrub shell/tool output. Same passes plus length cap.
  scrubOutput(input: string): ScrubResult {
    return this.run(input, { truncate: true });
  }

  // Scrub a path: strip home dir, leave the rest intact (paths are
  // high-signal for replay and rarely contain secrets).
  scrubPath(input: string): string {
    return this.replaceHome(input);
  }

  // Scrub the values of a structured tool-call args object. Keys stay,
  // values get message-level scrubbing. Non-string values pass through.
  scrubArgs(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string') {
        out[k] = this.run(v, { truncate: false }).text;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // Declarative summary of which passes the scrubber would apply. Stored in
  // SessionTrace.scrubbing so consumers know what was attempted.
  manifest(): Scrubbing {
    return {
      passes: [
        { reason: 'secret', version: SCRUBBER_VERSIONS.secret },
        { reason: 'path-home', version: SCRUBBER_VERSIONS['path-home'] },
        { reason: 'shell-output', version: SCRUBBER_VERSIONS['shell-output'] },
      ],
    };
  }

  private run(input: string, opts: { truncate: boolean }): ScrubResult {
    const counts: Record<keyof typeof SCRUBBER_VERSIONS, number> = {
      secret: 0,
      'path-home': 0,
      'env-value': 0,
      pii: 0,
      'shell-output': 0,
      'file-content': 0,
    };

    let text = input;

    for (const { re } of SECRET_PATTERNS) {
      text = text.replace(re, () => {
        counts.secret += 1;
        return '[REDACTED:secret]';
      });
    }

    const beforeHome = text;
    text = this.replaceHome(text);
    if (text !== beforeHome) counts['path-home'] += 1;

    if (opts.truncate && !this.preserveOutput && text.length > this.maxOutputChars) {
      const dropped = text.length - this.maxOutputChars;
      text = text.slice(0, this.maxOutputChars) + `\n[REDACTED:shell-output truncated ${dropped} chars]`;
      counts['shell-output'] += 1;
    }

    const appliedPasses = (Object.entries(counts) as Array<[keyof typeof SCRUBBER_VERSIONS, number]>)
      .filter(([, n]) => n > 0)
      .map(([reason, count]) => ({ reason, count }));

    return { text, appliedPasses };
  }

  private replaceHome(input: string): string {
    if (!this.homeDir) return input;
    // Handle both posix and win32 separators in the home path. Compare
    // case-insensitively on win32 since drive letters and user folders are
    // typically not case-sensitive.
    const candidates = new Set<string>([
      this.homeDir,
      this.homeDir.replace(/\\/g, '/'),
      this.homeDir.replace(/\//g, '\\'),
    ]);
    let out = input;
    for (const c of candidates) {
      if (!c) continue;
      // Case-insensitive global replace without rebuilding a regex from
      // unsanitized input.
      const idx = (s: string) => s.toLowerCase().indexOf(c.toLowerCase());
      let i = idx(out);
      while (i !== -1) {
        out = out.slice(0, i) + '~' + out.slice(i + c.length);
        i = idx(out);
      }
    }
    return out;
  }
}
