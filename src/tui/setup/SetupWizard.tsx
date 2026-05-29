import * as React from 'react';
import { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { registry, IProviderAdapter } from '../../adapters/index.js';
import {
  AladeenConfig,
  CONFIG_VERSION,
  loadConfig,
  writeConfig,
  ConfigScope,
  upsertSecret,
  loadSecretsIntoEnv,
} from '../../config/index.js';
import { TextInput } from './TextInput.js';
import type { AdapterRow, WizardStep, AuthAction } from './types.js';

export interface SetupWizardProps {
  repoRoot: string;
  scope?: ConfigScope;
  /** Optional callback fired when the wizard exits cleanly with the saved config. */
  onComplete?: (config: AladeenConfig) => void;
}

const SetupWizard: React.FC<SetupWizardProps> = ({
  repoRoot,
  scope = 'global',
  onComplete,
}) => {
  const { exit } = useApp();
  const [step, setStep] = useState<WizardStep>({ kind: 'detecting' });
  const [rows, setRows] = useState<AdapterRow[]>([]);

  // ── Phase 1: load secrets, then preflight every adapter in parallel ───────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadSecretsIntoEnv();
        const adapters = registry.listAdapters();
        const preflighted = await Promise.all(
          adapters.map(async (a) => preflightToRow(a)),
        );
        if (cancelled) return;
        setRows(preflighted);
        setStep({ kind: 'select', cursor: 0 });
      } catch (err) {
        if (cancelled) return;
        setStep({ kind: 'error', message: messageOf(err) });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Phase 4 (after select+auth): write config, advance to done ────────────
  const finalize = async (finalRows: AdapterRow[]) => {
    try {
      const { config } = await loadConfig(repoRoot);
      const enabled = finalRows.filter((r) => r.enabled).map((r) => r.id);
      const defaultAdapterId =
        finalRows.find((r) => r.enabled && r.configured)?.id ?? enabled[0];
      const next: AladeenConfig = {
        ...config,
        version: CONFIG_VERSION,
        enabledAdapters: enabled,
        defaultAdapterId,
        setupCompletedAt: new Date().toISOString(),
      };
      const configPath = await writeConfig(scope, next, repoRoot);
      setStep({ kind: 'done', configPath });
      onComplete?.(next);
    } catch (err) {
      setStep({ kind: 'error', message: messageOf(err) });
    }
  };

  // ── Input handling for select + auth steps ───────────────────────────────
  useInput((input, key) => {
    if (step.kind === 'detecting' || step.kind === 'auth-input') return;

    if (step.kind === 'done' || step.kind === 'error') {
      if (input === 'q' || key.return) exit();
      return;
    }

    if (step.kind === 'select') {
      if (key.upArrow) {
        setStep({ ...step, cursor: (step.cursor - 1 + rows.length) % rows.length });
      } else if (key.downArrow) {
        setStep({ ...step, cursor: (step.cursor + 1) % rows.length });
      } else if (input === ' ') {
        toggleEnabled(step.cursor);
      } else if (key.return) {
        const enabledCount = rows.filter((r) => r.enabled).length;
        if (enabledCount === 0) return; // require at least one
        const firstAuthIdx = rows.findIndex(
          (r) => r.enabled && !rowIsAuthed(r),
        );
        if (firstAuthIdx === -1) {
          void finalize(rows.map(markConfiguredIfEnabled));
        } else {
          setStep({ kind: 'auth', adapterIdx: firstAuthIdx });
        }
      } else if (input === 'q') {
        exit();
      }
      return;
    }

    if (step.kind === 'auth') {
      const row = rows[step.adapterIdx];
      const choices: AuthAction[] = ['enter-key', 'interactive-login', 'skip'];
      if (input === '1') chooseAuthAction(step.adapterIdx, 'enter-key');
      else if (input === '2') chooseAuthAction(step.adapterIdx, 'interactive-login');
      else if (input === '3' || input === 's') chooseAuthAction(step.adapterIdx, 'skip');
      else if (input === 'r') {
        // Re-run preflight to pick up a new env / freshly completed login
        void rePreflight(step.adapterIdx);
      } else if (input === 'q') {
        exit();
      }
      // Silence unused-vars lint
      void row; void choices;
      return;
    }
  });

  function toggleEnabled(idx: number) {
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, enabled: !r.enabled } : r)),
    );
  }

  function chooseAuthAction(idx: number, action: AuthAction) {
    const row = rows[idx];
    if (action === 'skip') {
      const updated = updateRow(rows, idx, { configured: false });
      setRows(updated);
      advanceFromAuth(updated, idx);
      return;
    }
    if (action === 'enter-key') {
      const envVar = row.authEnvVars[0] ?? 'API_KEY';
      setStep({ kind: 'auth-input', adapterIdx: idx, envVar, value: '' });
      return;
    }
    // interactive-login: stays on auth screen showing instructions
    setStep({ kind: 'auth', adapterIdx: idx, action: 'interactive-login' });
  }

  async function rePreflight(idx: number) {
    const adapters = registry.listAdapters();
    const adapter = adapters.find((a) => a.id === rows[idx].id);
    if (!adapter) return;
    const fresh = await preflightToRow(adapter);
    const updated = rows.map((r, i) =>
      i === idx ? { ...fresh, enabled: r.enabled } : r,
    );
    setRows(updated);
    if (rowIsAuthed(updated[idx])) {
      const next = updateRow(updated, idx, { configured: true });
      setRows(next);
      advanceFromAuth(next, idx);
    }
  }

  function advanceFromAuth(updated: AdapterRow[], fromIdx: number) {
    const nextIdx = updated.findIndex(
      (r, i) => i > fromIdx && r.enabled && !rowIsAuthed(r) && !r.configured,
    );
    if (nextIdx === -1) {
      void finalize(updated.map(markConfiguredIfEnabled));
    } else {
      setStep({ kind: 'auth', adapterIdx: nextIdx });
    }
  }

  async function submitApiKey() {
    if (step.kind !== 'auth-input') return;
    try {
      await upsertSecret(step.envVar, step.value);
      process.env[step.envVar] = step.value;
      const updated = updateRow(rows, step.adapterIdx, {
        authEnvVarsDetected: [step.envVar],
        configured: true,
      });
      setRows(updated);
      advanceFromAuth(updated, step.adapterIdx);
    } catch (err) {
      setStep({ kind: 'error', message: messageOf(err) });
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="yellow">Aladeen Setup</Text>
        <Text dimColor>  ·  scope: {scope}  ·  {stepHint(step)}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {step.kind === 'detecting' && <Text>Detecting provider CLIs…</Text>}

        {step.kind === 'error' && (
          <Box flexDirection="column">
            <Text color="red">✗ {step.message}</Text>
            <Text dimColor>Press Enter or q to exit.</Text>
          </Box>
        )}

        {step.kind === 'select' && (
          <SelectView rows={rows} cursor={step.cursor} />
        )}

        {step.kind === 'auth' && (
          <AuthView
            row={rows[step.adapterIdx]}
            action={step.action}
          />
        )}

        {step.kind === 'auth-input' && (
          <Box flexDirection="column">
            <Text>
              Enter <Text bold color="cyan">{step.envVar}</Text> for{' '}
              <Text bold>{rows[step.adapterIdx].name}</Text>:
            </Text>
            <Text dimColor>(value is masked; stored at ~/.aladeen/secrets.env, chmod 600)</Text>
            <Box marginTop={1}>
              <TextInput
                value={step.value}
                onChange={(v) => setStep({ ...step, value: v })}
                onSubmit={submitApiKey}
                onCancel={() => setStep({ kind: 'auth', adapterIdx: step.adapterIdx })}
                mask
                prompt=">"
              />
            </Box>
          </Box>
        )}

        {step.kind === 'done' && (
          <Box flexDirection="column">
            <Text color="green">✓ Setup complete.</Text>
            <Text dimColor>Wrote: {step.configPath}</Text>
            <Box marginTop={1} flexDirection="column">
              {rows.filter((r) => r.enabled).map((r) => (
                <Text key={r.id}>
                  {r.configured ? '✓' : '○'} {r.name}{' '}
                  <Text dimColor>({r.configured ? 'ready' : 'pending auth'})</Text>
                </Text>
              ))}
            </Box>
            <Text dimColor>Press Enter or q to exit.</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

// ── Subviews ───────────────────────────────────────────────────────────────

const SelectView: React.FC<{ rows: AdapterRow[]; cursor: number }> = ({
  rows,
  cursor,
}) => (
  <Box flexDirection="column">
    <Text bold>Choose providers to enable (space to toggle, enter to continue):</Text>
    <Box flexDirection="column" marginTop={1}>
      {rows.map((r, i) => {
        const cur = i === cursor;
        const found = r.preflight?.success;
        const authed = r.authEnvVarsDetected.length > 0;
        return (
          <Box key={r.id} flexDirection="row">
            <Text color={cur ? 'magenta' : 'white'}>
              {cur ? '› ' : '  '}
              [{r.enabled ? 'x' : ' '}] {r.name}
            </Text>
            <Text>  </Text>
            <Text color={found ? 'green' : 'red'}>
              {found ? '✓ found' : '✗ missing'}
            </Text>
            <Text>  </Text>
            <Text color={authed ? 'green' : 'yellow'}>
              {authed ? `✓ auth (${r.authEnvVarsDetected.join(',')})` : '⚠ no auth'}
            </Text>
          </Box>
        );
      })}
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text dimColor>↑/↓ move · space toggle · enter continue · q quit</Text>
    </Box>
  </Box>
);

const AuthView: React.FC<{
  row: AdapterRow;
  action?: 'enter-key' | 'interactive-login' | 'skip';
}> = ({ row, action }) => (
  <Box flexDirection="column">
    <Text bold>
      Authenticate <Text color="cyan">{row.name}</Text>
    </Text>
    <Text dimColor>{row.preflight?.suggestedFix ?? row.preflight?.message ?? ''}</Text>

    {action === 'interactive-login' ? (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          Open another terminal and run the provider's login command (e.g.{' '}
          <Text color="cyan">{row.id} login</Text> or{' '}
          <Text color="cyan">{row.id} /login</Text>).
        </Text>
        <Text>When finished, press <Text bold>r</Text> here to re-check.</Text>
      </Box>
    ) : (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          [1] Enter API key{' '}
          {row.authEnvVars[0] ? <Text dimColor>({row.authEnvVars[0]})</Text> : null}
        </Text>
        <Text>[2] Use provider's interactive login (run in another terminal)</Text>
        <Text>[3] Skip for now</Text>
      </Box>
    )}
    <Box marginTop={1}>
      <Text dimColor>1/2/3 to choose · r to re-check · q to quit</Text>
    </Box>
  </Box>
);

// ── Helpers ────────────────────────────────────────────────────────────────

async function preflightToRow(adapter: IProviderAdapter): Promise<AdapterRow> {
  const preflight = await adapter.preflight();
  const details = (preflight.details ?? {}) as {
    checkedAuthEnvVars?: string[];
    authEnvVarsDetected?: string[];
  };
  const authEnvVars = details.checkedAuthEnvVars ?? [];
  const authEnvVarsDetected = details.authEnvVarsDetected ?? [];
  return {
    id: adapter.id,
    name: adapter.name,
    preflight,
    authEnvVars,
    authEnvVarsDetected,
    enabled: preflight.success, // default: enable adapters that exist on PATH
    configured: preflight.success && authEnvVarsDetected.length > 0,
  };
}

function rowIsAuthed(r: AdapterRow): boolean {
  return r.preflight?.success === true && r.authEnvVarsDetected.length > 0;
}

function updateRow(rows: AdapterRow[], idx: number, patch: Partial<AdapterRow>): AdapterRow[] {
  return rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
}

function markConfiguredIfEnabled(r: AdapterRow): AdapterRow {
  if (!r.enabled) return r;
  return { ...r, configured: r.configured || rowIsAuthed(r) };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stepHint(step: WizardStep): string {
  switch (step.kind) {
    case 'detecting': return 'detecting providers';
    case 'select': return 'select providers';
    case 'auth':
    case 'auth-input': return 'authenticate';
    case 'review': return 'review';
    case 'done': return 'done';
    case 'error': return 'error';
  }
}

export default SetupWizard;
