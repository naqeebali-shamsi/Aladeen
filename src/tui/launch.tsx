// Lazy TUI launch surface. Kept isolated so cli.tsx stays JSX-free and free of any
// EAGER react / ink / node-pty import: the observability and MCP code paths must load
// and run even when the optional native `node-pty` dependency is absent (it has no
// Linux prebuild). cli dynamically imports this module only for the interactive
// commands (setup / run / run-local-feature / resume / tui), which legitimately need
// the PTY-backed adapters and the Ink renderer.
import { render } from 'ink';
import type { ComponentProps } from 'react';
import AladeenApp from './App.js';
import SetupWizard from './setup/SetupWizard.js';

export function launchSetup(props: ComponentProps<typeof SetupWizard>): void {
  render(<SetupWizard {...props} />);
}

export function launchApp(props: ComponentProps<typeof AladeenApp> = {}): void {
  render(<AladeenApp {...props} />);
}
