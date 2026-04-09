import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import type {
  DeterministicNode,
  BlueprintContext,
  NodeResult,
  NodeOutcome,
  INodeExecutor,
  BlueprintNode,
} from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Executes deterministic (non-LLM) nodes: shell commands, git operations, file operations.
 */
export class DeterministicExecutor implements INodeExecutor {
  async execute(node: BlueprintNode, context: BlueprintContext): Promise<NodeResult> {
    if (node.kind !== 'deterministic') {
      throw new Error(`DeterministicExecutor cannot execute node kind: ${node.kind}`);
    }
    const start = performance.now();
    try {
      const result = await this.dispatch(node, context);
      return { ...result, durationMs: performance.now() - start };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        outcome: 'failure',
        output: {},
        error: message,
        durationMs: performance.now() - start,
      };
    }
  }

  private async dispatch(
    node: DeterministicNode,
    context: BlueprintContext
  ): Promise<Omit<NodeResult, 'durationMs'>> {
    const { op } = node;
    switch (op.type) {
      case 'shell':
        return this.execShell(op, node, context);
      case 'git':
        return this.execGit(op, node, context);
      case 'file':
        return this.execFileOp(op, node, context);
      default:
        return { outcome: 'failure', output: {}, error: `Unknown op type: ${(op as { type: string }).type}` };
    }
  }

  private async execShell(
    op: { type: 'shell'; command: string; args?: string[] },
    node: DeterministicNode,
    context: BlueprintContext
  ): Promise<Omit<NodeResult, 'durationMs'>> {
    const { command, args = [] } = op;
    const env = { ...process.env, ...context.env };

    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: context.cwd,
        env,
        timeout: node.timeoutMs,
      });
      const outcome = this.resolveOutcome(0, node.exitCodeMap);
      return {
        outcome,
        output: { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 },
        summary: `Command "${command}" exited with code 0`,
      };
    } catch (err: unknown) {
      const execErr = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
      const outcome = this.resolveOutcome(exitCode, node.exitCodeMap);
      return {
        outcome,
        output: {
          stdout: (execErr.stdout ?? '').trim(),
          stderr: (execErr.stderr ?? '').trim(),
          exitCode,
        },
        error: execErr.message,
      };
    }
  }

  private async execGit(
    op: { type: 'git'; action: string; params: Record<string, string> },
    node: DeterministicNode,
    context: BlueprintContext
  ): Promise<Omit<NodeResult, 'durationMs'>> {
    const { action, params } = op;
    const gitArgs = this.buildGitArgs(action, params);

    try {
      const { stdout } = await execFileAsync('git', gitArgs, {
        cwd: context.cwd,
        timeout: node.timeoutMs,
      });
      return {
        outcome: 'success',
        output: { stdout: stdout.trim(), action },
        summary: `git ${action} completed`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { outcome: 'failure', output: { action }, error: message };
    }
  }

  private buildGitArgs(action: string, params: Record<string, string>): string[] {
    switch (action) {
      case 'checkout':
        return ['checkout', params['branch'] ?? params['ref'] ?? ''];
      case 'commit':
        return ['commit', '-m', params['message'] ?? 'auto-commit'];
      case 'push':
        return ['push', params['remote'] ?? 'origin', params['branch'] ?? ''];
      case 'branch':
        return ['branch', params['name'] ?? ''];
      case 'worktree_add':
        return ['worktree', 'add', '-b', params['branch'] ?? '', params['path'] ?? '', params['base'] ?? 'HEAD'];
      case 'worktree_remove':
        return ['worktree', 'remove', params['path'] ?? ''];
      default:
        return [action];
    }
  }

  private async execFileOp(
    op: { type: 'file'; action: string; path: string; content?: string; dest?: string },
    _node: DeterministicNode,
    _context: BlueprintContext
  ): Promise<Omit<NodeResult, 'durationMs'>> {
    const { action, path: filePath, content, dest } = op;

    switch (action) {
      case 'read': {
        const data = await readFile(filePath, 'utf-8');
        return { outcome: 'success', output: { content: data }, summary: `Read ${filePath}` };
      }
      case 'write': {
        await writeFile(filePath, content ?? '', 'utf-8');
        return { outcome: 'success', output: { path: filePath }, summary: `Wrote ${filePath}` };
      }
      case 'copy': {
        if (!dest) return { outcome: 'failure', output: {}, error: 'Copy requires a "dest" field' };
        await copyFile(filePath, dest);
        return { outcome: 'success', output: { src: filePath, dest }, summary: `Copied ${filePath} -> ${dest}` };
      }
      case 'delete': {
        await unlink(filePath);
        return { outcome: 'success', output: { path: filePath }, summary: `Deleted ${filePath}` };
      }
      default:
        return { outcome: 'failure', output: {}, error: `Unknown file action: ${action}` };
    }
  }

  private resolveOutcome(
    exitCode: number,
    exitCodeMap?: Record<number, NodeOutcome>
  ): NodeOutcome {
    if (exitCodeMap && exitCode in exitCodeMap) {
      return exitCodeMap[exitCode]!;
    }
    return exitCode === 0 ? 'success' : 'failure';
  }
}
