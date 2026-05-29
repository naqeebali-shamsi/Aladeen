import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SessionTraceSchema,
  RunDigestSchema,
  type SessionTrace,
  type RunDigest,
} from './session-trace.js';

// On-disk layout under <repoRoot>/.aladeen/ingested/:
//   sessions/<sessionId>.trace.json    -- SessionTrace
//   digests/<sessionId>.digest.json    -- RunDigest
//
// Both are versioned by schemaVersion in the trace itself; storage is
// dumb passthrough. Migrations belong upstream of writes, not here.

export class IngestStorage {
  constructor(private readonly repoRoot: string) {}

  private get baseDir(): string {
    return path.join(this.repoRoot, '.aladeen', 'ingested');
  }

  private get sessionsDir(): string {
    return path.join(this.baseDir, 'sessions');
  }

  private get digestsDir(): string {
    return path.join(this.baseDir, 'digests');
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(this.digestsDir, { recursive: true });
  }

  async writeTrace(trace: SessionTrace): Promise<string> {
    await this.ensureDirs();
    const filePath = path.join(this.sessionsDir, `${sanitizeForFs(trace.sessionId)}.trace.json`);
    await writeFile(filePath, JSON.stringify(trace, null, 2), 'utf-8');
    return filePath;
  }

  async writeDigest(digest: RunDigest): Promise<string> {
    await this.ensureDirs();
    const filePath = path.join(this.digestsDir, `${sanitizeForFs(digest.sessionId)}.digest.json`);
    await writeFile(filePath, JSON.stringify(digest, null, 2), 'utf-8');
    return filePath;
  }

  async listDigests(): Promise<RunDigest[]> {
    let entries: string[];
    try {
      entries = await readdir(this.digestsDir);
    } catch {
      return [];
    }
    const out: RunDigest[] = [];
    for (const name of entries) {
      if (!name.endsWith('.digest.json')) continue;
      const filePath = path.join(this.digestsDir, name);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = RunDigestSchema.safeParse(JSON.parse(raw));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // Skip unreadable / corrupt digests.
      }
    }
    return out;
  }

  async loadTrace(sessionId: string): Promise<SessionTrace | null> {
    const filePath = path.join(this.sessionsDir, `${sanitizeForFs(sessionId)}.trace.json`);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = SessionTraceSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

// SessionId may contain a provider prefix like "opencode:ses_xxx" — the
// colon is illegal on Windows (NTFS interprets it as an alternate data
// stream). Replace any character not in [A-Za-z0-9._-] with '_'. Stable
// 1:1 within a single provider's id space.
export function sanitizeForFs(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}
