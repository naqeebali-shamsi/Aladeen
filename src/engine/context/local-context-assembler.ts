import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContextAssembler, ContextBundle } from '../contracts.js';
import type { BlueprintContext } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Assembles optional context for agentic nodes: repo git digest, Graphify report
 * (if present), and optional MemPalace snippet via `MEMPALACE_CONTEXT_FILE`.
 */
export class LocalContextAssembler implements ContextAssembler {
  constructor(
    private readonly opts?: {
      maxGraphChars?: number;
      maxDigestChars?: number;
    }
  ) {}

  async assemble(params: {
    nodeId: string;
    prompt: string;
    context: BlueprintContext;
  }): Promise<ContextBundle> {
    const maxGraph = this.opts?.maxGraphChars ?? 8000;
    const maxDigest = this.opts?.maxDigestChars ?? 4000;
    const store = params.context.store;
    const repoRoot =
      typeof store['repoRoot'] === 'string'
        ? (store['repoRoot'] as string)
        : params.context.cwd;

    const repoDigest = await this.buildRepoDigest(params.context.cwd, maxDigest);
    const graphContext = await this.tryReadGraphReport(repoRoot, maxGraph);

    let memoryContext: string | undefined;
    const memPath = process.env['MEMPALACE_CONTEXT_FILE'];
    if (memPath) {
      try {
        memoryContext = (await readFile(memPath, 'utf-8')).slice(0, maxGraph);
      } catch {
        memoryContext = undefined;
      }
    }

    return {
      repoDigest,
      graphContext,
      memoryContext,
      metadata: { nodeId: params.nodeId },
    };
  }

  private async buildRepoDigest(cwd: string, max: number): Promise<string | undefined> {
    try {
      const { stdout: st } = await execFileAsync('git', ['status', '--short'], {
        cwd,
        maxBuffer: 512 * 1024,
      });
      let diffStat = '';
      try {
        const { stdout: d } = await execFileAsync('git', ['diff', '--stat', 'HEAD'], {
          cwd,
          maxBuffer: 512 * 1024,
        });
        diffStat = d;
      } catch {
        // Fresh worktree may have no HEAD diff yet
      }
      const combined = `git status --short:\n${st.trim()}\n\ngit diff --stat HEAD:\n${diffStat.trim()}`;
      return combined.slice(0, max);
    } catch {
      return undefined;
    }
  }

  private async tryReadGraphReport(repoRoot: string, max: number): Promise<string | undefined> {
    const candidates = [
      path.join(repoRoot, 'graphify-out', 'GRAPH_REPORT.md'),
      path.join(repoRoot, 'GRAPH_REPORT.md'),
    ];
    for (const p of candidates) {
      try {
        const text = await readFile(p, 'utf-8');
        return text.slice(0, max);
      } catch {
        continue;
      }
    }
    return undefined;
  }
}
