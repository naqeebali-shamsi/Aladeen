import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgenticNode,
  BlueprintContext,
  NodeResult,
  INodeExecutor,
  BlueprintNode,
} from './types.js';
import type { ContextAssembler, ModelRouter } from './contracts.js';
import {
  CompletionDetector,
  HEADLESS_CONFIGS,
  type HeadlessOptions,
  type HeadlessResult,
} from './completion.js';

const execFileAsync = promisify(execFile);

/**
 * Default file-change check: returns true if `git status --short` in `cwd`
 * reports any modifications. Used to enforce node.requiresFileChanges so a
 * chatty/refusing agent can't silently pass as "completed."
 */
async function defaultHasUncommittedChanges(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short'], { cwd });
    return stdout.trim().length > 0;
  } catch {
    // If git isn't available or cwd isn't a repo, be conservative: assume the
    // agent did something. Better to pass through than block legitimate work.
    return true;
  }
}

interface AgenticExecutorOptions {
  contextAssembler?: ContextAssembler;
  modelRouter?: ModelRouter;
  /** Test seam — override the git-status probe used for requiresFileChanges. */
  hasUncommittedChanges?: (cwd: string) => Promise<boolean>;
}

/**
 * Executes agentic nodes using headless CLI mode (CompletionDetector).
 *
 * Process exit IS the completion signal. No PTY parsing, no quiescence
 * heuristics. The existing PTY-based adapters remain for the interactive TUI;
 * this executor is purpose-built for blueprint execution.
 */
export class AgenticExecutor implements INodeExecutor {
  private detector = new CompletionDetector();
  private readonly contextAssembler?: ContextAssembler;
  private readonly modelRouter?: ModelRouter;
  private readonly hasUncommittedChanges: (cwd: string) => Promise<boolean>;

  constructor(options: AgenticExecutorOptions = {}) {
    this.contextAssembler = options.contextAssembler;
    this.modelRouter = options.modelRouter;
    this.hasUncommittedChanges = options.hasUncommittedChanges ?? defaultHasUncommittedChanges;
  }

  async execute(node: BlueprintNode, context: BlueprintContext): Promise<NodeResult> {
    if (node.kind !== 'agentic') {
      throw new Error(`AgenticExecutor cannot execute node kind: ${node.kind}`);
    }
    const start = performance.now();

    // Verify the adapter has a headless config
    if (!HEADLESS_CONFIGS[node.adapterId]) {
      return {
        outcome: 'failure',
        output: {},
        error: `No headless config for adapter: "${node.adapterId}". Supported: ${Object.keys(HEADLESS_CONFIGS).join(', ')}`,
        durationMs: performance.now() - start,
      };
    }

    // Resolve prompt template with store values and optional context assembly.
    const promptBase = resolveTemplate(node.prompt, context.store);
    const assembled = this.contextAssembler
      ? await this.contextAssembler.assemble({
        nodeId: node.id,
        prompt: promptBase,
        context,
      })
      : {};
    const modelRoute = this.modelRouter
      ? await this.modelRouter.route({
        tier: 'generator',
        prompt: promptBase,
        context,
      })
      : undefined;
    const prompt = injectContext(promptBase, assembled, modelRoute?.modelId);

    const options: HeadlessOptions = {
      cwd: context.cwd,
      env: context.env,
      allowedTools: context.allowedTools.length > 0 ? context.allowedTools : undefined,
      timeoutMs: node.timeoutMs,
      outputFormat: 'json',
    };

    const result = await this.detector.execute(node.adapterId, prompt, options);

    // requiresFileChanges: enforce that "spawn exit 0" implies "files changed."
    // Without this, agents that ask clarifying questions or refuse to act get
    // marked successful — silent hallucination of completion.
    if (result.success && node.requiresFileChanges) {
      const changed = await this.hasUncommittedChanges(context.cwd);
      if (!changed) {
        const durationMs = performance.now() - start;
        return {
          outcome: 'retry',
          output: {
            response: result.response,
            sessionId: result.sessionId,
            usage: result.usage,
          },
          error: `Agent reported success but no files changed in ${context.cwd}. Likely refused, asked for clarification, or ran without write tools.`,
          summary: `Agentic node "${node.label}" produced no file changes`,
          durationMs,
        };
      }
    }

    const durationMs = performance.now() - start;
    return this.toNodeResult(result, node, durationMs);
  }

  /**
   * Cancel the currently running agent process.
   */
  cancel(): void {
    this.detector.cancel();
  }

  private toNodeResult(
    result: HeadlessResult,
    node: AgenticNode,
    durationMs: number
  ): NodeResult {
    if (result.success) {
      return {
        outcome: 'success',
        output: {
          response: result.response,
          sessionId: result.sessionId,
          usage: result.usage,
        },
        summary: `Agentic node "${node.label}" completed successfully`,
        durationMs,
      };
    }

    // Non-zero exit. Decide between retry and failure:
    // - Timeout or spawn failure -> failure (retrying won't help)
    // - Agent error (exit 1) -> retry (the agent might do better next time)
    const isRetryable = result.exitCode > 0 && !result.error?.includes('Timed out');

    return {
      outcome: isRetryable ? 'retry' : 'failure',
      output: {
        response: result.response,
        sessionId: result.sessionId,
        exitCode: result.exitCode,
      },
      error: result.error,
      summary: `Agentic node "${node.label}" ${isRetryable ? 'needs retry' : 'failed'}: ${result.error?.slice(0, 100) ?? 'unknown'}`,
      durationMs,
    };
  }
}

/**
 * Replace {{key}} and {{store.key}} placeholders in a prompt template
 * with values from the context store.
 */
export function resolveTemplate(template: string, store: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    const trimmed = key.trim();
    // Support both "key" and "store.key" syntax
    const lookupKey = trimmed.startsWith('store.') ? trimmed.slice(6) : trimmed;
    const value = store[lookupKey];
    if (value === undefined || value === null) return `{{${trimmed}}}`;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

export function injectContext(
  prompt: string,
  assembled: {
    graphContext?: string;
    memoryContext?: string;
    repoDigest?: string;
  },
  modelId?: string
): string {
  const sections: string[] = [prompt];
  if (assembled.repoDigest) {
    sections.push(`\n[Repo Digest]\n${assembled.repoDigest}`);
  }
  if (assembled.graphContext) {
    sections.push(`\n[Graph Context]\n${assembled.graphContext}`);
  }
  if (assembled.memoryContext) {
    sections.push(`\n[Memory Context]\n${assembled.memoryContext}`);
  }
  if (modelId) {
    sections.push(`\n[Model Route]\nUse local model route: ${modelId}`);
  }
  return sections.join('\n');
}
