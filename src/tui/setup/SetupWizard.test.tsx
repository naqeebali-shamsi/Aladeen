import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';
import SetupWizard from './SetupWizard.js';

let tmpHome: string;
let tmpRepo: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(tmpdir(), 'aladeen-wiz-home-'));
  tmpRepo = await mkdtemp(path.join(tmpdir(), 'aladeen-wiz-repo-'));
  prevHome = process.env.ALADEEN_HOME;
  process.env.ALADEEN_HOME = path.join(tmpHome, '.aladeen');
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.ALADEEN_HOME;
  else process.env.ALADEEN_HOME = prevHome;
  await rm(tmpHome, { recursive: true, force: true });
  await rm(tmpRepo, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, timeoutMs = 15_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('SetupWizard render', () => {
  it('shows the detecting screen on mount', () => {
    const { lastFrame, unmount } = render(<SetupWizard repoRoot={tmpRepo} />);
    expect(lastFrame()).toContain('Aladeen Setup');
    expect(lastFrame()).toContain('Detecting');
    unmount();
  });

  it('leaves the detecting state once preflight resolves', async () => {
    const { lastFrame, unmount } = render(<SetupWizard repoRoot={tmpRepo} />);
    await waitFor(() => !/Detecting/.test(lastFrame() ?? ''));
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Choose providers|✗/);
    unmount();
  }, 20_000);
});
