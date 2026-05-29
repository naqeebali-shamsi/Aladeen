#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';

// Entry point for the aladeen-mcp bin. Wires the MCP server onto
// stdio so any host (Claude Code / opencode / Codex / Cursor / etc.)
// can spawn it via .mcp.json:
//
//   "aladeen": { "command": "aladeen-mcp" }
//
// Reads from <cwd>/.aladeen/ingested/ by default. The host's cwd is
// typically the user's project root, which is exactly where prior
// `aladeen ingest <source>` invocations wrote their digests.

async function main(): Promise<void> {
  const server = buildServer({ repoRoot: process.cwd() });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The transport keeps the process alive while a host is connected.
  // No further work to do here — handlers are wired in buildServer().
}

main().catch((err) => {
  // MCP servers communicate over stdout JSON-RPC; logs MUST go to stderr.
  process.stderr.write(`aladeen-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
