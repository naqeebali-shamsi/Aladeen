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

interface AgenticExecutorOptions {
  contextAssembler?: ContextAssembler;
  modelRouter?: ModelRouter;
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

  constructor(options: AgenticExecutorOptions = {}) {
    this.contextAssembler = options.contextAssembler;
    this.modelRouter = options.modelRouter;
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
function resolveTemplate(template: string, store: Record<string, unknown>): string {
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

function injectContext(
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
