
import * as React from 'react';
import { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { registry, IProviderAdapter } from '../adapters/index.js';
import type { Blueprint, ExecutionState } from '../engine/types.js';
import type { RunnerOptions } from '../engine/runner.js';
import BlueprintView from './BlueprintView.js';

interface ProviderStatus {
  id: string;
  name: string;
  status: 'idle' | 'starting' | 'running' | 'errored' | 'stopped';
}

type TuiMode = 'navigation' | 'input' | 'broadcast';
type LayoutMode = 'focused' | 'split';

export interface AppProps {
  blueprint?: Blueprint;
  resumeState?: ExecutionState;
  repoRoot?: string;
  /** Optional runner options (e.g. local-first context assembler + model router). */
  runnerOptions?: RunnerOptions;
}

const AladeenApp: React.FC<AppProps> = ({ blueprint, resumeState, repoRoot, runnerOptions }) => {
  // If a blueprint is provided, render the blueprint execution view
  if (blueprint) {
    return (
      <BlueprintView
        blueprint={blueprint}
        resumeState={resumeState}
        repoRoot={repoRoot ?? process.cwd()}
        runnerOptions={runnerOptions}
      />
    );
  }

  return <AdapterView />;
};

const AdapterView: React.FC = () => {
  const { exit } = useApp();
  const adapters = registry.listAdapters();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [outputs, setOutputs] = useState<Record<string, string[]>>({});
  const [providerStatuses, setProviderStatuses] = useState<Record<string, ProviderStatus['status']>>({});
  const [mode, setMode] = useState<TuiMode>('navigation');
  const [layout, setLayout] = useState<LayoutMode>('focused');
  const [currentInput, setCurrentInput] = useState('');

  const currentAdapter = adapters[selectedIdx];

  const logMessage = (adapterId: string, msg: string) => {
    setOutputs((prev: Record<string, string[]>) => ({
      ...prev,
      [adapterId]: [...(prev[adapterId] || []), msg].slice(-100) // Keep last 100 lines for each
    }));
  };

  useInput((input, key) => {
    // Global Quit
    if (mode === 'navigation' && input === 'q') {
      exit();
      return;
    }

    // Mode Transitions
    if (mode === 'navigation') {
      if (input === 'i') {
        setMode('input');
        return;
      }
      if (input === 'b') {
        setMode('broadcast');
        return;
      }
      if (input === 'v') {
        setLayout((prev: LayoutMode) => (prev === 'focused' ? 'split' : 'focused'));
        return;
      }
    }

    if ((mode === 'input' || mode === 'broadcast') && key.escape) {
      setMode('navigation');
      return;
    }

    // Navigation Logic
    if (mode === 'navigation') {
      if (key.upArrow) {
        setSelectedIdx((prev: number) => (prev > 0 ? prev - 1 : adapters.length - 1));
      }
      if (key.downArrow) {
        setSelectedIdx((prev: number) => (prev < adapters.length - 1 ? prev + 1 : 0));
      }
      if (key.return) {
        startSession(currentAdapter);
      }
    }

    // Input/Broadcast Mode Logic
    if (mode === 'input' || mode === 'broadcast') {
      if (key.return) {
        if (currentInput.trim()) {
           if (mode === 'broadcast') {
             broadcastCommand(currentInput);
           } else {
             sendCommand(currentAdapter, currentInput);
           }
           setCurrentInput('');
        }
        return;
      }

      if (key.backspace || key.delete) {
        setCurrentInput((prev: string) => prev.slice(0, -1));
        return;
      }

      // Add characters
      if (input && !key.ctrl && !key.meta && !key.escape && !key.tab) {
          setCurrentInput((prev: string) => prev + input);
      }
    }
  });

  const startSession = async (adapter: IProviderAdapter) => {
    if (providerStatuses[adapter.id] === 'running') {
      logMessage(adapter.id, '[Aladeen] Session already running');
      return;
    }

    setProviderStatuses((prev: Record<string, ProviderStatus['status']>) => ({ ...prev, [adapter.id]: 'starting' }));
    logMessage(adapter.id, `[Aladeen] Launching binary: ${adapter.name}...`);

    try {
      const result = await adapter.startSession({ cwd: process.cwd() });
      setProviderStatuses((prev: Record<string, ProviderStatus['status']>) => ({ ...prev, [adapter.id]: 'running' }));
      
      result.pty.onData((raw: string) => {
        // ANSI cleaning is basic but keeps it readable
        const esc = String.fromCharCode(27);
        const clean = raw.replace(new RegExp(`${esc}\\[[0-9;]*[a-zA-Z]`, 'g'), '').trim();
        if (clean) {
          logMessage(adapter.id, clean);
        }
      });

      result.pty.onExit(() => {
        setProviderStatuses((prev: Record<string, ProviderStatus['status']>) => ({ ...prev, [adapter.id]: 'stopped' }));
        logMessage(adapter.id, '[Aladeen] Process exited');
      });
    } catch (err) {
      setProviderStatuses((prev: Record<string, ProviderStatus['status']>) => ({ ...prev, [adapter.id]: 'errored' }));
      logMessage(adapter.id, `[Aladeen] Startup Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const sendCommand = async (adapter: IProviderAdapter, cmd: string) => {
    if (providerStatuses[adapter.id] !== 'running') {
       logMessage(adapter.id, `[Aladeen] Cannot send: ${adapter.name} is not running.`);
       return;
    }
    logMessage(adapter.id, `> ${cmd}`);
    await adapter.sendInput(cmd + '\n');
  };

  const broadcastCommand = async (cmd: string) => {
    const active = adapters.filter(a => providerStatuses[a.id] === 'running');
    if (active.length === 0) {
       logMessage(currentAdapter.id, '[Aladeen] No running sessions to broadcast to.');
       return;
    }
    logMessage('__system__', `[Broadcast] > ${cmd}`);
    for (const a of active) {
        logMessage(a.id, `[Broadcast] > ${cmd}`);
        a.sendInput(cmd + '\n');
    }
  };

  const renderOutputPane = (adapter: IProviderAdapter, width: string | number) => {
    const isSelected = adapter.id === currentAdapter.id && layout === 'focused';
    return (
        <Box width={width} flexDirection="column" borderStyle="single" borderColor={isSelected ? "green" : "gray"} paddingX={1} marginLeft={1}>
            <Text bold color={isSelected ? "green" : "white"}>{adapter.name}</Text>
            <Box flexDirection="column" marginTop={1} flexGrow={1}>
                {(outputs[adapter.id] || []).length > 0 ? (
                    (outputs[adapter.id] || []).map((line: string, i: number) => (
                        <Box key={i}><Text color="white" wrap="truncate-end">{line}</Text></Box>
                    ))
                ) : (
                    <Text dimColor>Idle</Text>
                )}
            </Box>
        </Box>
    );
  };

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} minHeight={24}>
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={0} justifyContent="space-between">
        <Box flexDirection="column">
            <Text bold color="yellow">Aladeen [Multi-CLI]</Text>
            <Text dimColor>
                {mode === 'navigation' 
                    ? '↑/↓ Select | i: Focus | b: Broadcast | v: Toggle Split | Enter: Start | q: Exit' 
                    : 'ESC: Back | Enter: Send'}
            </Text>
        </Box>
        <Box flexDirection="column" alignItems="flex-end">
            <Box>
                <Text color="cyan">LAYOUT: </Text>
                <Text bold color="white">{layout.toUpperCase()}</Text>
            </Box>
            <Box>
                <Text color="cyan">MODE: </Text>
                <Text bold color={mode === 'navigation' ? 'blue' : 'green'}>{mode.toUpperCase()}</Text>
            </Box>
        </Box>
      </Box>

      {/* Main Area */}
      <Box flexGrow={1} flexDirection="row" marginTop={1}>
        {/* Registry Sidebar (Only in focused layout) */}
        {layout === 'focused' && (
            <Box width="25%" flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1}>
                <Text bold color="white">Adapters</Text>
                <Box flexDirection="column" marginTop={1}>
                {adapters.map((adapter, idx: number) => (
                    <Box key={adapter.id} flexDirection="column" marginBottom={0}>
                    <Text color={idx === selectedIdx ? 'magenta' : 'white'} bold={idx === selectedIdx}>
                        {idx === selectedIdx ? '● ' : '  '}{adapter.name}
                    </Text>
                    <Box marginLeft={3}>
                        <Text dimColor>[{providerStatuses[adapter.id] || 'idle'}]</Text>
                    </Box>
                    </Box>
                ))}
                </Box>
            </Box>
        )}

        {/* Output Panes */}
        {layout === 'focused' ? (
            renderOutputPane(currentAdapter, "75%")
        ) : (
            <Box flexDirection="row" flexGrow={1}>
                {adapters.map(a => renderOutputPane(a, `${100 / adapters.length}%`))}
            </Box>
        )}
      </Box>

      {/* Composer */}
      {(mode === 'input' || mode === 'broadcast') && (
        <Box marginTop={0} borderStyle="single" borderColor="green" paddingX={1}>
            <Text color="green" bold>{mode === 'broadcast' ? 'ALL' : currentAdapter.name} {' > '}</Text>
            <Text color="white">{currentInput}</Text>
            <Text color="green" dimColor>_</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={0} borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
         <Box>
            <Text dimColor>Target: </Text>
            <Text bold color="white">{mode === 'broadcast' ? 'BROADCAST' : currentAdapter.name.toUpperCase()}</Text>
         </Box>
         <Box>
            <Text dimColor>v0.1.0 | Press 'q' to quit</Text>
         </Box>
      </Box>
    </Box>
  );
};

export default AladeenApp;
