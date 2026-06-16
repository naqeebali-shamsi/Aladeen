import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IngestStorage } from '../observability/storage.js';
import { replayFingerprint } from '../observability/replay.js';
import { suggestRemedy } from '../observability/remedy.js';
import { suggestLoops } from '../observability/loops.js';
import { buildOverview } from './api.js';

// The FLIGHT RECORDER server. A thin, read-only `node:http` shell over the
// existing IngestStorage — no web framework, no new runtime dependency.
//
// Local-first is enforced structurally, not by convention:
//   - binds 127.0.0.1 ONLY (asserts a loopback host; refuses 0.0.0.0)
//   - Content-Security-Policy: default-src 'self' (the page cannot phone home)
//   - Cache-Control: no-store (the user re-ingests; never serve stale)
//   - path-traversal guard on every static read
//
// Routes:
//   GET /api/digests.json   -> the single hero payload (buildOverview)
//   GET /api/trace/:id      -> one full SessionTrace (lazy, for the TRACE screen)
//   GET /api/replay/:fp     -> replayFingerprint markdown (read-only drill-down)
//   GET /api/remedy/:fp     -> suggestRemedy result (read-only remedy)
//   GET /api/loops          -> suggestLoops report (read-only loop candidates)
//   GET /*                  -> static SPA from ./web (SPA fallback to index.html)

export interface DashboardServerOptions {
  storage: IngestStorage;
  host?: string;
  port?: number;
  repoRoot?: string;
  /** Static web root. Defaults to ./web next to this file (src or dist). */
  staticDir?: string;
}

export interface DashboardServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1']);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export function defaultStaticDir(): string {
  return fileURLToPath(new URL('./web', import.meta.url));
}

export async function startDashboardServer(
  opts: DashboardServerOptions,
): Promise<DashboardServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK.has(host)) {
    throw new Error(
      `FLIGHT RECORDER refuses to bind non-loopback host "${host}". Local-first is non-negotiable; logs carry code + scrubbed secrets.`,
    );
  }
  const storage = opts.storage;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const staticRoot = path.resolve(opts.staticDir ?? defaultStaticDir());

  const server = http.createServer((req, res) => {
    handle(req, res, { storage, repoRoot, staticRoot }).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  return {
    url: `http://${host}:${port}/`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface Ctx {
  storage: IngestStorage;
  repoRoot: string;
  staticRoot: string;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx): Promise<void> {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);

  // ── API ────────────────────────────────────────────────────────────────
  if (pathname === '/api/digests.json') {
    const digests = await ctx.storage.listDigests();
    sendJson(res, 200, buildOverview(digests, new Date().toISOString(), ctx.repoRoot));
    return;
  }

  if (pathname.startsWith('/api/trace/')) {
    const id = pathname.slice('/api/trace/'.length);
    const trace = id ? await ctx.storage.loadTrace(id) : null;
    if (!trace) {
      sendJson(res, 404, { error: `no trace for sessionId "${id}"` });
      return;
    }
    sendJson(res, 200, trace);
    return;
  }

  if (pathname.startsWith('/api/replay/')) {
    const fp = pathname.slice('/api/replay/'.length);
    const result = await replayFingerprint(fp, ctx.storage, { maxDeepLoad: 10 });
    sendJson(res, result.matchedDigests.length > 0 ? 200 : 404, {
      fingerprint: result.fingerprint,
      matchCount: result.matchedDigests.length,
      markdown: result.markdown,
    });
    return;
  }

  if (pathname.startsWith('/api/remedy/')) {
    const fp = pathname.slice('/api/remedy/'.length);
    const r = await suggestRemedy(fp, ctx.storage, { maxResolvedSamples: 3 });
    sendJson(res, r.failingDigests.length > 0 ? 200 : 404, {
      fingerprint: r.fingerprint,
      subSignature: r.subSignature,
      tier: r.tier,
      guardrail: r.guardrail,
      coverageNote: r.coverageNote,
      ruleMatches: r.ruleMatches,
      resolvedSiblings: r.resolvedSiblings,
      nFailed: r.nFailed,
      nResolved: r.nResolved,
      markdown: r.markdown,
    });
    return;
  }

  if (pathname === '/api/loops') {
    const r = await suggestLoops(ctx.storage, { minSessions: 3 });
    sendJson(res, 200, {
      candidates: r.candidates,
      sessionsScanned: r.sessionsScanned,
      humanAsksFound: r.humanAsksFound,
      noiseFiltered: r.noiseFiltered,
      fanoutFiltered: r.fanoutFiltered,
      guardrail: r.guardrail,
      coverageNote: r.coverageNote,
      markdown: r.markdown,
    });
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'unknown api route' });
    return;
  }

  // ── Static SPA ───────────────────────────────────────────────────────────
  await serveStatic(res, ctx.staticRoot, pathname);
}

async function serveStatic(res: http.ServerResponse, staticRoot: string, pathname: string): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(staticRoot, rel);

  // Traversal guard: resolved path must stay inside the static root.
  if (resolved !== staticRoot && !resolved.startsWith(staticRoot + path.sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  const served = await tryServeFile(res, resolved);
  if (served) return;

  // SPA fallback: extensionless paths fall back to index.html; a missing
  // asset (has an extension) is an honest 404.
  if (!path.extname(resolved)) {
    const indexServed = await tryServeFile(res, path.join(staticRoot, 'index.html'));
    if (indexServed) return;
  }
  sendJson(res, 404, { error: 'not found' });
}

async function tryServeFile(res: http.ServerResponse, filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    const body = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream');
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(text);
}
