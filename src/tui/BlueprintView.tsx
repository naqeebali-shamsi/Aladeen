import * as React from 'react';
import { useState, useEffect, useCallback } from 'react';
import { Box, Text } from 'ink';
import type {
  Blueprint,
  ExecutionState,
  RunnerHooks,
} from '../engine/types.js';
import { BlueprintRunner, type RunnerOptions } from '../engine/runner.js';

interface BlueprintViewProps {
  blueprint: Blueprint;
  resumeState?: ExecutionState;
  repoRoot: string;
  runnerOptions?: RunnerOptions;
}

const BlueprintView: React.FC<BlueprintViewProps> = ({ blueprint, resumeState, repoRoot, runnerOptions }) => {
  const [state, setState] = useState<ExecutionState | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev.slice(-30), msg]);
  }, []);

  useEffect(() => {
    const hooks: RunnerHooks = {
      onNodeStart: (nodeId, node) => {
        addLog(`[start] ${node.label} (${nodeId})`);
      },
      onNodeComplete: (nodeId, result) => {
        const icon = result.outcome === 'success' ? '[ok]' : result.outcome === 'retry' ? '[retry]' : '[fail]';
        addLog(`${icon} ${nodeId}: ${result.summary ?? result.outcome} (${Math.round(result.durationMs)}ms)`);
        if (result.error) {
          addLog(`  error: ${result.error.slice(0, 200)}`);
        }
      },
      onEscalation: (reason) => {
        addLog(`[ESCALATION] ${reason}`);
      },
      onStateChange: (s) => {
        setState({ ...s });
      },
    };

    const runner = new BlueprintRunner({ repoRoot, hooks, ...runnerOptions });

    const execute = async () => {
      try {
        if (resumeState) {
          await runner.resume(resumeState, blueprint);
        } else {
          await runner.run(blueprint);
        }
      } catch (err) {
        addLog(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
      }
      setDone(true);
    };

    execute();
  }, [blueprint, resumeState, repoRoot, runnerOptions, addLog]);

  const nodeCount = blueprint.nodes.length;
  const completedCount = state
    ? Object.values(state.nodeExecutions).filter((e) => e.status === 'completed').length
    : 0;
  const failedCount = state
    ? Object.values(state.nodeExecutions).filter((e) => e.status === 'failed').length
    : 0;
  const gateFailures = state?.quality?.gateOutcomes
    ? Object.entries(state.quality.gateOutcomes).filter(([, outcome]) => outcome !== 'success')
    : [];

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Text bold color="yellow">{blueprint.name}</Text>
        <Text dimColor> v{blueprint.version}</Text>
      </Box>

      {/* Progress */}
      <Box marginBottom={1}>
        <Text color="cyan">Progress: </Text>
        <Text bold>{completedCount}/{nodeCount}</Text>
        <Text dimColor> nodes complete</Text>
        {failedCount > 0 && <Text color="red"> | {failedCount} failed</Text>}
        {state?.totalRetries ? <Text color="yellow"> | {state.totalRetries} retries</Text> : null}
        {state?.runPolicy?.mode ? <Text dimColor> | mode: {state.runPolicy.mode}</Text> : null}
      </Box>

      {gateFailures.length > 0 && (
        <Box marginBottom={1}>
          <Text color="red">Gate failures: {gateFailures.map(([id]) => id).join(', ')}</Text>
        </Box>
      )}

      {/* Node list */}
      <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1} marginBottom={1}>
        <Text bold color="white">Nodes</Text>
        {blueprint.nodes.map((node) => {
          const exec = state?.nodeExecutions[node.id];
          const status = exec?.status ?? 'pending';
          const icon = statusIcon(status);
          const color = statusColor(status);
          const isCurrent = state?.currentNodeId === node.id;

          return (
            <Box key={node.id}>
              <Text color={color}>
                {icon} {node.label}
              </Text>
              {isCurrent && <Text color="yellow"> {'<-'}</Text>}
              {exec && exec.attempts > 1 && (
                <Text dimColor> (attempt {exec.attempts})</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Log output */}
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} height={12}>
        <Text bold color="white">Log</Text>
        {logs.slice(-8).map((line, i) => (
          <Text key={i} wrap="truncate-end" color={logColor(line)}>{line}</Text>
        ))}
      </Box>

      {/* Status bar */}
      <Box marginTop={1} paddingX={1} justifyContent="space-between">
        <Box>
          <Text dimColor>Status: </Text>
          <Text bold color={finalStatusColor(state?.status ?? 'pending')}>
            {(state?.status ?? 'pending').toUpperCase()}
          </Text>
        </Box>
        {state?.escalationReason && (
          <Text color="red">{state.escalationReason}</Text>
        )}
        {done && (
          <Text dimColor>Run complete. {state?.runId ? `Run ID: ${state.runId.slice(0, 8)}` : ''}</Text>
        )}
      </Box>
    </Box>
  );
};

function statusIcon(status: string): string {
  switch (status) {
    case 'completed': return '[ok]';
    case 'running':   return '[..]';
    case 'failed':    return '[x]';
    case 'skipped':   return '[--]';
    default:          return '[ ]';
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'completed': return 'green';
    case 'running':   return 'yellow';
    case 'failed':    return 'red';
    case 'skipped':   return 'gray';
    default:          return 'white';
  }
}

function logColor(line: string): string {
  if (line.startsWith('[ESCALATION]') || line.startsWith('[FATAL]')) return 'red';
  if (line.startsWith('[fail]')) return 'red';
  if (line.startsWith('[retry]')) return 'yellow';
  if (line.startsWith('[ok]')) return 'green';
  if (line.startsWith('[start]')) return 'cyan';
  return 'white';
}

function finalStatusColor(status: string): string {
  switch (status) {
    case 'completed': return 'green';
    case 'running':   return 'yellow';
    case 'failed':    return 'red';
    case 'escalated': return 'red';
    default:          return 'white';
  }
}

export default BlueprintView;
