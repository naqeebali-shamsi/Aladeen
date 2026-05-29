# Secret Incident Remediation Runbook

**Incident:** GitGuardian alerts on `github.com/naqeebali-shamsi/Aladeen` (public)
**Flagged:** "GitHub Personal Access Token" + "JSON Web Token", both in commit `4f989bf` (2026-05-19)
**Status:** RESOLVED — FALSE POSITIVE (scanner noise on test fixtures)
**Author:** Lead security engineer (defensive remediation)
**Date:** 2026-05-29

> NOTE: This document never prints a full secret value. Candidate secrets are masked
> (short prefix + length). All "secrets" discussed here are fabricated test fixtures
> or vendor documentation examples — there is nothing live to mask in the first place.

---

## 1. Risk Verdict + Required Rotations

### VERDICT: NO REAL SECRET EXISTS. NO ROTATION REQUIRED. NO HISTORY REWRITE.

Both GitGuardian incidents are **confirmed false positives**. The flagged strings are
fabricated/vendor-example fixtures that live in the Scrubber's **own redaction unit test**
(`src/observability/scrubber.test.ts:8-11`). They are *inputs the test asserts get redacted* —
their entire purpose is to be secret-SHAPED so the scrubber's regexes match them. GitGuardian
fires on shape, not validity.

**This was verified, not assumed:**

| Check | Result |
| --- | --- |
| Commit `4f989bf` identity | `feat(observability): session-trace pipeline + Claude Code ingester (pivot step 1)` |
| `4f989bf` ancestor of `main`? | YES (`git merge-base --is-ancestor`) |
| `4f989bf` ancestor of `feat/flight-recorder-dashboard`? | YES |
| Full-history blob sweep (all 291 distinct blobs, all refs) | Secret-shaped strings in exactly ONE blob: `846be2c` = `scrubber.test.ts:8-11` |
| `.aladeen/` (199 real local traces) tracked files | **0** (gitignored, `.gitignore:8`) |
| `.env` / `.env.local` tracked files | **0** (gitignored, `.gitignore:13-14`) |
| `src/config/secrets.ts` embedded literals | **none** — secret-handling code only, clean |
| `.mcp.json` token | `${GITHUB_PERSONAL_ACCESS_TOKEN}` env reference, no hardcoded value |

### The four flagged fixtures (all MASKED, all fake)

| Line | Kind | Masked value | Why it is not real |
| --- | --- | --- | --- |
| `:8` | anthropic-key | `sk-ant-api03-…(46 chars)` | Body is sequential `a-z` + `ABCDEF12345` — zero entropy, hand-typed |
| `:9` | github-pat **(GG-flagged)** | `ghp_…(40 chars)` | Body is literal `abcdefghijklmnopqrstuvwxyz0123456789` — lowest-entropy possible |
| `:10` | aws | `AKIAIOSF…(AKIAIOSFODNN7EXAMPLE)` | AWS's **own published documentation** example access-key ID |
| `:11` | jwt **(GG-flagged)** | `eyJhbGci…(JWT, 3 segs)` | Textbook jwt.io token: header `{"alg":"HS256"}`, payload `{"sub":"123456"}`, non-validating sig |

### Rotation table

| Credential | Action |
| --- | --- |
| GitHub PAT | **NONE.** No live PAT was ever committed. The `ghp_…` string is a sequential-alphabet dummy. |
| JWT signing key | **NONE.** The JWT is the jwt.io textbook sample; it signs nothing and authenticates against nothing. |
| Anthropic / OpenAI / AWS keys | **NONE.** All fabricated or AWS's own doc placeholder. |

**Do not revoke, rotate, or audit any credential for unauthorized use. There is nothing live to rotate.**
Record this determination so a future reviewer does not re-open the incident.

---

## 2. De-Fang Patch (forward fix — do this FIRST)

Highest-leverage fix: make the source contain **no literal secret-shaped token**. Scanners
(gitleaks, GitGuardian) match literal file *bytes*. `'ghp_' + 'a'.repeat(36)` is two string
literals plus a method call — there is no contiguous `ghp_…` byte sequence on disk, so nothing
matches. At runtime the concatenation yields the same value the regex catches, so test coverage
is identical.

### `src/observability/scrubber.test.ts` — replace lines 5-18

Current (lines 5-18):

```ts
  it('redacts known secret patterns', () => {
    const s = new Scrubber({ homeDir: '/home/test' });
    const cases = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEF12345',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAIOSFODNN7EXAMPLE',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk',
    ];
    for (const value of cases) {
      const { text } = s.scrubMessage(`token=${value} end`);
      expect(text).not.toContain(value);
      expect(text).toContain('[REDACTED:secret]');
    }
  });
```

New (defanged — assembles each fixture at runtime; adds the previously-untested
private-key-block case for `scrubber.ts:28`):

```ts
  it('redacts known secret patterns', () => {
    const s = new Scrubber({ homeDir: '/home/test' });
    // FIXTURE: fabricated secret-SHAPED values assembled at runtime so no literal
    // token ever exists in source. This defeats gitleaks/GitGuardian shape matchers
    // while still exercising every SECRET_PATTERNS regex in scrubber.ts:22-28.
    // These are NOT live credentials. gitleaks:allow
    const cases = [
      'sk-ant-' + 'api03-' + 'a'.repeat(40),                  // anthropic-key  (scrubber.ts:22)
      'sk-' + 'b'.repeat(40),                                 // openai-key     (scrubber.ts:23)
      'ghp_' + 'c'.repeat(36),                                // github-pat     (scrubber.ts:24)
      'github_pat_' + 'd'.repeat(30),                         // github-pat-classic (scrubber.ts:25)
      'AKIA' + 'E'.repeat(16),                                // aws-key        (scrubber.ts:26)
      ['eyJ' + 'a'.repeat(8), 'eyJ' + 'b'.repeat(8), 'c'.repeat(20)].join('.'), // jwt (scrubber.ts:27)
      '-----BEGIN RSA PRIVATE KEY-----\n' + 'f'.repeat(40) +
        '\n-----END RSA PRIVATE KEY-----',                    // private-key-block (scrubber.ts:28)
    ];
    for (const value of cases) {
      const { text } = s.scrubMessage(`token=${value} end`);
      expect(text).not.toContain(value);
      expect(text).toContain('[REDACTED:secret]');
    }
  });
```

Each case is constructed to match the exact regex in `scrubber.ts` (line cited inline). After
applying, run `npm test` to confirm green.

### `src/config/secrets.test.ts:112` — optional de-fang

This fixture (`sk-abcdef1234567890`, 19 chars) does NOT match any high-confidence scanner rule
(`sk-` + 14 chars is below the `sk-[…]{32,}` openai-key threshold), so it is unlikely to trip
gitleaks/GitGuardian. It is a `redact()` assertion, not a scrubber-regex fixture. Leave as-is, OR
for consistency assemble at runtime:

```ts
  it('reveals the first 4 chars plus a length hint for longer values', () => {
    const value = 'sk-' + 'abcdef1234567890'; // fabricated, 19 chars. gitleaks:allow
    expect(redact(value)).toBe('sk-a***(19 chars)');
  });
```

`src/config/secrets.ts` itself contains **no secret literals** (verified) — it is secret-handling
code (dotenv parse, `chmod 600`, `redact()` masking). No change needed.

---

## 3. Pre-Commit Hook (gitleaks) + Config with Fixture Allowlist

gitleaks is the right tool here: a single static Go binary, no Python/runtime dependency, good fit
for this TS repo. Two pieces — a config with a test-fixture allowlist, and a husky-wired hook.

### `.gitleaks.toml` (repo root)

```toml
# Extend gitleaks' built-in ruleset; only ADD an allowlist.
[extend]
useDefault = true

[allowlist]
description = "Secret-SHAPED fixtures that exercise the Scrubber's redaction. Fabricated / vendor-example values, never real credentials."
# Belt-and-suspenders: even after de-fanging, allowlist *.test.ts so future
# fixtures don't require a config change. Production source has NO exemption.
paths = [
  '''src/observability/scrubber\.test\.ts''',
  '''.*\.test\.ts$''',
]
regexes = [
  '''AKIAIOSFODNN7EXAMPLE''',       # AWS public doc example key
  '''eyJhbGciOiJIUzI1NiJ9\..*''',   # jwt.io textbook token
]
# Stopwords keep obviously-fake bodies from tripping entropy rules.
stopwords = ['''example''', '''abcdefghijklmnopqrstuvwxyz''']
```

The allowlist is deliberately scoped to `*.test.ts`. **Production `src/` has no exemption** — a
real leak in non-test code still hard-fails the commit.

### Wire the hook via husky (run once)

```bash
npm i -D husky
npx husky init
# write .husky/pre-commit:
#   gitleaks protect --staged --redact --config .gitleaks.toml --no-banner
```

- `protect --staged` scans only staged content (fast, pre-commit-appropriate).
- `--redact` ensures the hook itself never prints a real secret to the terminal.

Install the binary: `winget install gitleaks` (Windows) / `brew install gitleaks` (macOS) /
`apt`/release tarball (Linux). Document this in the README so contributors have it.

> The hook can be bypassed with `--no-verify` or simply not installed. That's why CI (section 4)
> is mandatory defense-in-depth, not optional.

---

## 4. CI Secret-Scan Step (bypass-proof)

`.github/workflows/secret-scan.yml` (the repo currently has **no** `.github/` dir — create it):

```yaml
name: secret-scan
on: [push, pull_request]
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # full history so PRs scan all new commits, not just the tip
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITLEAKS_CONFIG: .gitleaks.toml
          # GITLEAKS_LICENSE only needed for ORG repos; personal repo = omit
```

`fetch-depth: 0` makes the scan cover the full commit range of a PR, so a secret hidden in an
intermediate commit is still caught. The same `.gitleaks.toml` drives both the hook and CI — single
source of truth, no drift. Once green, add it as a **required status check** on `main` in branch
protection.

---

## 5. GitGuardian Incident Resolution

These are fabricated hits → resolve as false-positive, **do not rotate anything**.

For BOTH incidents (GitHub PAT line 9 + JWT line 11, commit `4f989bf`):

1. Open each incident in the GitGuardian dashboard.
2. **Resolve → reason: "This is a test credential" / "False positive".**
3. Add a resolution note:
   > Fabricated fixture in `src/observability/scrubber.test.ts:8-11` — exercises the local Scrubber
   > redaction. The `ghp_…` body is the sequential alphabet; the JWT is the jwt.io textbook example.
   > De-fanged to runtime-constructed strings in commit `<hash>`. No live credential — nothing to rotate.
4. To prevent re-alerting, either (a) rely on the de-fang (once the literals are gone the detector
   has nothing to match on future commits — preferred), or (b) commit a `.gitguardian.yaml` with a
   `secret: { ignored-matches: [...] }` entry keyed on the match.
5. Mark severity resolved/ignored. Explicitly record that **no rotation, revocation, or
   unauthorized-use audit is needed** so a future reviewer doesn't re-open it.

**Gap:** GitGuardian-side state (open/closed, dashboard access, existing `.gitguardian.yaml`) lives
in the web app, outside this repo. The account owner must execute these steps there.

---

## 6. Optional History Rewrite — RECOMMENDATION: NOT WORTH IT

**Decision: skip the rewrite.** The leaked strings are fabricated — there is no real credential in
`4f989bf` to expunge, so a rewrite buys zero security benefit at high cost:

- **CAVEAT 1 — blast radius:** `4f989bf` is an ancestor of BOTH `main` AND
  `feat/flight-recorder-dashboard` (verified). Rewriting it changes every descendant SHA on both
  branches → force-push to a PUBLIC repo → anyone who cloned/forked must re-clone or hard-reset; open
  PRs break.
- **CAVEAT 2 — can't unring the bell:** Public repo → the old commit is likely already mirrored by
  GitHub's network, forks, and archival caches (Software Heritage, GHArchive). Rewriting your branch
  does NOT scrub those. For a REAL secret the only safe remediation is **rotation**, not rewriting —
  and here there's nothing to rotate.
- **CAVEAT 3 — collateral:** Rewriting destroys the `Co-Authored-By` trailers and the legible pivot
  narrative for zero benefit.

De-fang (forward fix) + resolve-as-false-positive is the correct, proportionate response.

### Break-glass runbook — IF a REAL secret is ever committed (do NOT execute for this incident)

1. **ROTATE/REVOKE the credential at the provider IMMEDIATELY.** This is step 0 and the only step
   that actually matters. History rewriting is secondary.
2. `pip install git-filter-repo` (preferred over BFG for path+content).
3. `git filter-repo --replace-text replacements.txt`
   where `replacements.txt` contains `THE_SECRET==>***REMOVED***`.
   **Use a file — never paste the secret on the command line where it hits shell history.**
4. `git push --force-with-lease --all && git push --force-with-lease --tags`
5. Tell every collaborator to re-clone (rebasing onto rewritten history corrupts their tree).
6. Ask GitHub Support to purge cached views of the old SHAs.
7. Verify with a fresh `git clone` + `gitleaks detect` over full history.

---

## 7. Bonus — Close a Latent `.gitignore` Gap (separate risk, same class)

`git check-ignore` confirms `.env.production`, `.env.staging`, `.env.development` are **NOT** ignored
(only `.env`, `.env.local`, `.env.*.local` are). Tighten `.gitignore` lines 13-15:

```gitignore
# Environment (secrets)
.env
.env.*
!.env.example
```

This ignores every `.env` variant while still allowing a committed `.env.example` template. Cheap,
prevents a future REAL leak of a non-local env file.

---

## 8. Order of Operations

1. De-fang `scrubber.test.ts` (section 2) + run `npm test` — kills the root cause.
2. Add `.gitleaks.toml` + husky pre-commit + tighten `.gitignore` (sections 3, 7) — local prevention.
3. Add CI workflow + make it a required check (section 4) — bypass-proof prevention.
4. Resolve both GitGuardian incidents as false-positive (section 5) — close the alert.
5. Commit it all atomically.
6. **DO NOT rewrite history** (section 6).
7. Housekeeping: delete the stray untracked `a.txt` (7-byte literal "payload", not committed).

Total: ~5 small files, no rotation, no force-push.

---

## Appendix — Verification Gaps (for completeness)

- **Origin freshness:** `origin/main` is behind local `main` (unpushed commits). Scans used `--all`
  including origin mirrors as of last fetch. If origin has refs not present locally (stale PR
  branches, tags), re-run after `git fetch --all --tags --prune`.
- **gitleaks not installed here:** the config/hook were designed but not empirically executed against
  these four fixtures. Validate locally with `gitleaks detect --config .gitleaks.toml --no-banner`
  after adding the files.
- **Binary blobs:** the line-oriented content sweep skipped any embedded-null-byte blobs. The repo's
  tracked blobs are source/text; no tracked binary credential stores (`.p12`/`.pfx`/`.jks`/keystore)
  exist. A pure-binary secret blob would not be caught by the text scan.
- **Unreachable objects:** stashes and reflog-only/dangling objects were not scanned (`rev-list
  --all` covers reachable refs only). If concerned, run `git fsck --unreachable` + scan dangling
  blobs. Not indicated here given clean results.
