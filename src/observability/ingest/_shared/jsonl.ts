// Shared JSONL parser. Tolerates corrupt lines silently — callers can
// surface a count via warnings if useful. Returns line numbers (1-based)
// so SourceRef entries on emitted events can point back to the byte range.

export interface RawLine {
  raw: Record<string, unknown>;
  lineNumber: number;
}

export function parseJsonl(text: string): RawLine[] {
  const out: RawLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        out.push({ raw: parsed as Record<string, unknown>, lineNumber: i + 1 });
      }
    } catch {
      // Tolerate corrupt lines — every ingester treats this as "skip and
      // continue" rather than "abort the whole file."
    }
  }
  return out;
}
