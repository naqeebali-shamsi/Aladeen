# Self-hosted fonts (SIL Open Font License 1.1)

Vendored locally so the dashboard makes **zero CDN / network calls** (session logs
carry code + scrubbed secrets — local-first is non-negotiable). All three families
are licensed under the SIL Open Font License, Version 1.1 (https://scripts.sil.org/OFL).

| File | Family | Copyright | Upstream |
|------|--------|-----------|----------|
| `orbitron-latin-400-normal.woff2`, `orbitron-latin-700-normal.woff2` | Orbitron | © The Orbitron Project Authors | github.com/theleagueof/orbitron |
| `ibm-plex-mono-latin-400-normal.woff2`, `ibm-plex-mono-latin-500-normal.woff2` | IBM Plex Mono | © IBM Corp. | github.com/IBM/plex |
| `vt323-latin-400-normal.woff2` | VT323 | © The VT323 Project Authors | github.com/phoikoi/VT323 |

woff2 files obtained from the corresponding `@fontsource/*` npm packages (Latin subset).
The OFL permits bundling and redistribution; these reserved-name fonts are unmodified.
