# Release Checklist for 0.1.0

This checklist prepares and verifies a release candidate. It stops before publication. Do not run `npm publish`, create a registry release, or add a publishing action to CI.

Record the release commit, operator, date, operating system, Python version, and command output outside this repository for each run.

## Source and vendor provenance

- [ ] **SOURCE-01 — The release worktree is clean and points at the intended 0.1.0 commit.** Run `git status --short`, `git rev-parse HEAD`, and confirm `package.json` reports `0.1.0`.
- [ ] **VENDOR-01 — The upstream tag resolves to the pinned commit.** In a clean checkout of `https://github.com/alexgreensh/token-optimizer`, run `git rev-parse 'refs/tags/v5.13.4^{commit}'` and require exactly `eda65d61b4750b530a6f9956193d4e4632aca0cb`.
- [ ] **VENDOR-02 — A fresh vendor sync reproduces the committed snapshot.** Run `npm run vendor:sync -- /absolute/path/to/clean/token-optimizer-checkout`, then require `git diff --exit-code -- patches vendor` and run `npm run vendor:check`.
- [ ] **LEGAL-01 — Package and upstream legal notices are present and reviewed.** Compare `LICENSE`, `NOTICE`, `PRIVACY.md`, `vendor/token-optimizer/LICENSE`, and `vendor/token-optimizer/PRIVACY.md`; verify the root documentation describes the Pi adaptation and preserves upstream attribution.

## Supported environments

The automated matrix must pass all four combinations before release: `macos-latest` and `ubuntu-latest`, each with Python `3.9` and `3.14.7`, using Node `26.8.1` and `npm ci`.

- [ ] **PLATFORM-01 — The macOS matrix is green on Python 3.9 and 3.14.7.** Save links to both GitHub Actions jobs and record the resolved patch versions.
- [ ] **PLATFORM-02 — The Linux matrix is green on Python 3.9 and 3.14.7.** Save links to both GitHub Actions jobs and record the resolved patch versions.
- [ ] **PLATFORM-03 — Windows is marked unavailable for version 0.1.0.** Confirm `README.md` and `docs/capabilities.md` make no Windows support claim; no Windows release artifact is prepared.

## Automated checks

Run from a fresh clone or after removing `node_modules` so `npm ci` proves the lockfile.

```sh
npm ci
npm run check
```

- [ ] **CHECK-01 — TypeScript typechecking passes.** Record the complete `npm run typecheck` result.
- [ ] **CHECK-02 — TypeScript unit, vendor, and package contract tests pass.** Record the complete `npm test` result; this executes `tests/vendor.test.ts` once.
- [ ] **CHECK-03 — Python tests pass.** Record the complete `npm run test:python` result.
- [ ] **CHECK-04 — Real bridge and Pi RPC integration tests pass.** Record the complete `npm run test:integration` result.
- [ ] **CHECK-05 — Vendor integrity passes.** Record `npm run vendor:check`. `npm run package:check` remains an optional focused shortcut and must not be added to `npm run check` or CI after `npm test`.
- [ ] **CHECK-06 — Repository hygiene checks pass.** Run `git diff --check`; verify `find . -type d -name __pycache__ -o -type f -name '*.pyc'` has no tracked or newly created result, and confirm no test process remains.

## Manual Pi behavior

Use a disposable `PI_CODING_AGENT_DIR` and a non-sensitive fixture project. Review the third-party package source before loading it because Pi extensions run with the user's full local permissions.

- [ ] **CONSENT-01 — Fresh interactive startup requires the current notice before optimizer activity.** Start Pi in TUI mode with no optimizer config, read the complete notice, decline it, and confirm no activity data is created and status remains off.
- [ ] **CONSENT-02 — Consent controls persist only an explicit current grant.** Run `/token-optimizer consent show`, grant through the TUI and through `/token-optimizer consent grant` in separate disposable homes, reload, then reset; confirm grant timestamps, notice version, and immediate inactivity after reset.
- [ ] **UI-01 — Status and warnings remain bounded and mode-appropriate.** Confirm the footer shows `optimizer on`, `optimizer off`, or `optimizer unavailable`; each failure category warns at most once per session; JSON and print modes do not prompt.
- [ ] **CONTROL-01 — Every documented control has an honest result.** Exercise `/token-optimizer status`, `doctor`, `dashboard`, `enable`, `disable`, `consent show`, `consent grant`, `consent reset`, `expand <id>`, and `purge`; confirm unavailable states do not claim success.
- [ ] **UI-02 — Dashboard opening uses a static file and starts no listener.** Generate and open the dashboard on macOS with `open` and Linux with `xdg-open`; inspect `<pi-agent-dir>/token-optimizer/dashboard.html`, confirm no Token Optimizer process or listening socket was created, and verify any browser network requests are limited to the disclosed Google Fonts, public GitHub star count, or user-opened external links without optimizer data.
- [ ] **SESSION-NEW-01 — `/new` creates and activates one clean optimizer session.** In a consented TUI, run `/session`, record the ID and file, exercise one Read, run `/new`, then run `/session` and `/token-optimizer status`; require a different ID and file, `optimizer on`, no stale read substitution, and no lingering Python process.
- [ ] **SESSION-RESUME-01 — `/resume` switches optimizer state to the selected saved session.** After `SESSION-NEW-01`, run `/resume`, select the recorded original session, then run `/session` and `/token-optimizer status`; require the original ID and file, `optimizer on`, at most one fenced recovery context, and successful activity under only that resumed ID.
- [ ] **SESSION-FORK-01 — `/fork` creates an independently tracked session from the selected user turn.** Add two distinguishable user turns, record `/session`, run `/fork`, select the first turn, submit the populated editor text, then run `/session` and `/token-optimizer status`; require a new ID and file, only the selected active prefix in context, `optimizer on`, and byte-identical source-session JSONL.
- [ ] **COMPACTION-01 — Optimized manual compaction uses the selected Pi provider and preserves fallback behavior.** With consent active, run `/compact preserve the fixture decision` against normal and split-turn fixtures; confirm one normal selected-provider model call receives the current compacted context plus optimizer guidance, and confirm abort, invalid guidance, or provider failure falls back to Pi without clearing read state.
- [ ] **COMPACTION-02 — Threshold compaction follows Pi's configured boundary.** In the disposable `<pi-agent-dir>/settings.json`, set `compaction.enabled` to `true`, choose `reserveTokens` so `contextWindow - reserveTokens` is a practical fixture threshold, and set `keepRecentTokens` below it; reload, add text/tool output until `/session` reports `contextTokens > contextWindow - reserveTokens`, then submit another prompt and require automatic compaction (not `/compact`), one selected-provider summary call with optimizer guidance, retained recent context, and cleared read state only after success.
- [ ] **BASH-01 — Bash compression preserves failure and security evidence and fails open for failed commands.** Ask Pi to run a built-in Bash command that emits over 50 KiB of repetitive text plus literal `FAILURE-SENTINEL` and `SECURITY-SENTINEL`; require a shorter replacement containing both sentinels and an archive ID, expand every page and compare to the original output, then run an equally large command ending with nonzero exit and require the original error/output unchanged with no replacement.
- [ ] **READ-01 — Read substitution retains a specific-range escape hatch.** Generate a text source over 10 KiB, ask Pi's built-in Read to read it twice unchanged, and require the second full-file read to return a shorter signatures/structure substitution; then request the same path with explicit nonzero `offset` and `limit` covering a known sentinel line and require the full requested range with that sentinel.
- [ ] **ARCHIVE-01 — External text archives expand across multiple bounded pages.** Invoke one configured external text tool whose successful result exceeds 100 KiB and is not exempt, record the advertised archive ID, then repeatedly call `token_optimizer_expand` with each returned `nextOffset` until absent; require at least two pages, each at most 50 KiB and 2,000 lines, strictly increasing offsets, and concatenated pages equal to the expected credential-redacted archive. Separately run `/token-optimizer expand <id>` and require its single offset-0 page to equal the tool's offset-0 page; do not treat the slash command as a pagination interface.
- [ ] **RELOAD-01 — Pi reload replaces the extension instance without stale activity.** Run `/reload` while idle, verify one fresh status and lifecycle instance, exercise a read, then quit and confirm cleanup completes without a lingering Python process.
- [ ] **PURGE-01 — Purge previews exactly, requires confirmation, and preserves Pi sessions.** Seed optimizer files and a Pi session, run purge and cancel once, then confirm once; compare preview count/bytes, require only `<pi-agent-dir>/token-optimizer/` to be removed, and verify the Pi session JSONL is byte-identical.
- [ ] **ISOLATION-01 — Real actions do not read or mutate foreign-agent data.** Place sentinels under `.claude`, `.codex`, `.config/opencode`, `.hermes`, `.copilot`, and `.cursor`, exercise every exposed action, and compare bytes, metadata, and symlink targets before and after.
- [ ] **CAP-01 — Deferred upstream entrypoints and model-routing controls remain unreachable through Pi.** Inspect RPC `get_commands` and active tools; require only `/token-optimizer` and `token_optimizer_expand` from this package, with no upstream installer, daemon, status-line, marketplace, skill-management, or model-routing entrypoint.

## Benchmark record

Run the smoke benchmark on both release operating systems with the configured Python versions where practical:

```sh
PI_TOKEN_OPTIMIZER_BENCH_ITERATIONS=2 npm run benchmark
```

- [ ] **BENCH-01 — The two-iteration benchmark smoke completes against real fixtures.** Record OS, architecture, Node, Python, fixture names, iteration count, and `pre_tool`/`post_tool` p50 and p95 output. Treat results as observations, not release thresholds.

| OS | Architecture | Node | Python | pre_tool p50/p95 | post_tool p50/p95 | Record link |
| --- | --- | --- | --- | --- | --- | --- |
| macOS |  | 26.8.1 | 3.9 |  |  |  |
| macOS |  | 26.8.1 | 3.14.7 |  |  |  |
| Linux |  | 26.8.1 | 3.9 |  |  |  |
| Linux |  | 26.8.1 | 3.14.7 |  |  |  |

## Exact package inspection

The allowlist in `tests/vendor.test.ts` is the release manifest: exactly 93 files. It includes package/runtime sources, both documentation files, root and upstream legal/privacy files, the compatibility patch, vendor manifest, static dashboard asset, and the executable launcher. It excludes tests, fixtures, caches, local optimizer data, repository scripts, upstream demos, unrelated skills, and CI files.

```sh
npm run package:check
npm pack --dry-run --json > /tmp/pi-token-optimizer-pack-dry-run.json
node -e 'const p=require("/tmp/pi-token-optimizer-pack-dry-run.json")[0]; if(p.files.length!==93) process.exit(1); console.log(p.files.map(f=>f.path).sort().join("\n"))'
pack_dir=$(mktemp -d)
npm pack --json --pack-destination "$pack_dir" > "$pack_dir/pack.json"
tarball=$(node -e 'const p=require(process.argv[1])[0]; process.stdout.write(require("node:path").join(require("node:path").dirname(process.argv[1]),p.filename))' "$pack_dir/pack.json")
tar -tzf "$tarball" | LC_ALL=C sort
```

- [ ] **PACKAGE-01 — Dry-run paths equal the 93-file automated allowlist.** Compare the sorted output line-for-line with `releaseFiles` in `tests/vendor.test.ts`; require no extra or missing path.
- [ ] **PACKAGE-02 — The real tarball contains only package-prefixed allowlisted paths.** Inspect `tar -tzf`, verify `package/vendor/token-optimizer/hooks/python-launcher.sh` is executable, and record filename, byte size, unpacked size, SHA-512 integrity, and SHA-1 shasum from `pack.json`.
- [ ] **PACKAGE-03 — The locally packed package passes isolated Pi 0.84.4 RPC smoke.** Run `npx tsx --test --test-name-pattern='Pi 0.84.4 loads the npm-packed extension' tests/integration/extension-rpc.test.ts`; require strict JSONL, status, consent, and doctor responses with no model call.

## Read-only registry check and stop point

- [ ] **REGISTRY-01 — Package-name availability is checked read-only immediately before release.** Run exactly `npm view pi-token-optimizer name version --json`, record the timestamp, registry URL, exit status, stdout, and stderr in the external release record, and have the release owner interpret that point-in-time result. This check does not reserve the name and this repository must not claim permanent availability.
- [ ] **STOP-01 — Verification stops without publication.** Confirm no `npm publish` command ran, no npm release was created, no registry token was provided to CI, and no workflow has publication permissions or actions.
