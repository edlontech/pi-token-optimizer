# Pi Token Optimizer

Pi Token Optimizer 0.1.0 is a Pi package that adapts a bounded set of Token Optimizer 5.13.4 behaviors to Pi: local read caching, tool-output compression and archives, quality/continuity context, session metrics, a static dashboard, and guided compaction. See the [capability matrix](docs/capabilities.md) for evidence and explicit exclusions.

## Requirements

- Pi 0.84.4 or newer for automatic optimization, Python-backed controls, and `token_optimizer_expand`
- Python 3.12 or newer available as `python3`
- macOS or Linux

Pi's own current Node requirement applies; this package declares Node 22.19.0 or newer. Pi packages execute with the user's full local permissions, so review third-party package source before installation.

## Install

Pinned npm release:

```sh
pi install npm:pi-token-optimizer@0.1.0
```

Pinned Git tag after that tag exists:

```sh
pi install git:github.com/ygorcastor/pi-token-optimizer@v0.1.0
```

Local checkout, loaded in place rather than copied:

```sh
pi install /absolute/path/to/pi-token-optimizer
```

Pi also accepts `https://github.com/ygorcastor/pi-token-optimizer@v0.1.0`. Versioned npm and Git sources are pinned and skipped by normal package updates; install the desired newer version or ref explicitly to move them. Use `-l` with `pi install` for a project-local setting instead of the default user setting.

## Activation and consent

On Pi 0.84.4 or newer, installation registers the extension automatically. A fresh interactive TUI session displays Pi Token Optimizer's current consent notice before optimizer activity begins. The notice identifies these local categories:

- credential-redacted read-cache source excerpts;
- credential-redacted tool-result archives;
- session metrics, paths, and usage aggregates;
- continuity checkpoints containing brief conversation, decision, error, todo, and file-path snippets;
- custom compaction, where current context and optimizer guidance are sent through the user's selected Pi provider as a normal model call.

Declining leaves activity inactive. RPC can relay the same confirmation UI when an agent prompt first needs activation. JSON and print modes do not prompt or grant consent automatically. `/token-optimizer consent grant` is an explicit local grant in any mode; `consent reset` immediately disables activity. A changed notice version requires a new grant.

On Pi older than 0.84.4, the package keeps only safe local command controls. Status, enable/disable, consent state, and purge remain available, but enabling only records local intent. Automatic events, Python-backed doctor/dashboard/expansion, and the expansion tool remain unavailable until Pi is upgraded and the package is reloaded.

## Behavior

While enabled with current consent, the extension:

- translates source-proven Pi built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` events to the one-shot local Python bridge;
- may block a redundant Read or exact external refetch, rewrite an eligible Bash command, or replace a successful text-only tool result with a shorter result that points to a local archive;
- leaves unknown tools, errors, images, malformed responses, timeouts, and bridge failures on Pi's original path;
- injects bounded local quality and continuity context and records session rollups/checkpoints;
- customizes manual or automatic Pi compaction only when usable optimizer guidance is available, otherwise preserving Pi's default compaction behavior.

### Command

```text
/token-optimizer status
/token-optimizer doctor
/token-optimizer dashboard
/token-optimizer enable
/token-optimizer disable
/token-optimizer consent show
/token-optimizer consent grant
/token-optimizer consent reset
/token-optimizer expand <archive-id>
/token-optimizer purge
```

`status` reports local enabled/consent state, Pi compatibility, and bridge health. `doctor` validates Python and the pinned runtime. `dashboard` regenerates `<pi-agent-dir>/token-optimizer/dashboard.html` and opens that static file with `open` on macOS or `xdg-open` on Linux. The package starts no dashboard listener, server, or daemon. `expand` displays one bounded archive page.

### Tool

`token_optimizer_expand` lets the model retrieve a credential-redacted local archive in pages of at most 50 KiB or 2,000 lines. It is the package's only added model-callable tool.

## Local data and retention

`<pi-agent-dir>` is `PI_CODING_AGENT_DIR` when set, otherwise Pi's default `~/.pi/agent`. The integration does not use `.claude`, `.codex`, `.config/opencode`, `.hermes`, `.copilot`, or `.cursor` paths.

| Data | Pi-only path | Default retention | Setting |
| --- | --- | --- | --- |
| Consent and enabled state | `<pi-agent-dir>/token-optimizer/config.json` | Until purge | None |
| Session metrics | `<pi-agent-dir>/token-optimizer/data/trends.db` | Unlimited | `TOKEN_OPTIMIZER_TRENDS_RETENTION_DAYS` (`0` means unlimited) |
| Per-session read cache | `<pi-agent-dir>/token-optimizer/data/session-store/<session-id>.db` | 48 hours | None |
| Tool archives | `<pi-agent-dir>/token-optimizer/data/tool-archive/<session-id>/` | 24 hours; aggregate 1,000 files and 100 MiB | `TOKEN_OPTIMIZER_ARCHIVE_RETENTION_HOURS`, `TOKEN_OPTIMIZER_ARCHIVE_RETENTION_MAX_FILES`, `TOKEN_OPTIMIZER_ARCHIVE_RETENTION_MAX_BYTES` |
| Continuity checkpoints | `<pi-agent-dir>/token-optimizer/checkpoints/` | 7 days; at most 50 files | `TOKEN_OPTIMIZER_CHECKPOINT_RETENTION_DAYS`, `TOKEN_OPTIMIZER_CHECKPOINT_RETENTION_MAX` |
| Quality cache | `<pi-agent-dir>/token-optimizer/quality-cache-*.json` | 7 days | `TOKEN_OPTIMIZER_QUALITY_CACHE_RETENTION_DAYS` (`0` means unlimited) |
| Checkpoint event log | `<pi-agent-dir>/token-optimizer/checkpoint-events.jsonl` | At most 1,000 entries | `TOKEN_OPTIMIZER_CHECKPOINT_EVENT_MAX` |
| Live-fill cache | `<pi-agent-dir>/token-optimizer/live-fill.json` | Replaced as activity changes | None |
| Static dashboard | `<pi-agent-dir>/token-optimizer/dashboard.html` | Replaced when regenerated | None |

The fixed 48-hour session-store cleanup and configured nonzero trends cleanup run best effort on consented `session_start` when Pi supplies a real current session file; neither has a background service. Lower limits can remove other data sooner. See [PRIVACY.md](PRIVACY.md) for sensitive-content and redaction limits.

## Purge

`/token-optimizer purge` first reports the exact optimizer root, file count, and byte count. TUI and RPC modes require confirmation; cancellation changes nothing. JSON and print modes show the preview and refuse deletion because they cannot confirm. Confirmed purge disables the current extension instance, drains tracked bridge work, and removes only `<pi-agent-dir>/token-optimizer/`.

Purge does not delete Pi's session JSONL files under `<pi-agent-dir>/sessions/` or a configured Pi session directory. Run `/reload` after purge before re-enabling automatic behavior; the purged extension instance intentionally remains retired.

## Privacy and network behavior

Optimizer analysis, bridge calls, and storage are local, and the package sends no telemetry. Normal Pi provider calls remain subject to the selected provider's terms. In particular, optimized compaction sends the current context plus optimizer guidance through that provider as an ordinary Pi model call; local recovery or nudge text included in later Pi context can also reach the provider with the rest of the session.

The dashboard is a static local file with no local listener. Opening it in a browser may request its declared Google Fonts and the upstream repository's public GitHub star count; following its external links also leaves the local file. These requests do not intentionally include optimizer data. Installation and package updates separately use Pi's npm or Git package-management network flow; they are not runtime optimizer telemetry.

## Troubleshooting

1. Run `/token-optimizer status`, then `/token-optimizer doctor` on Pi 0.84.4 or newer.
2. Verify `pi --version` is at least 0.84.4 and `python3 --version` is at least 3.12.
3. Run `/token-optimizer consent show`; grant only after reading the notice, then `/reload` if activation was previously unavailable.
4. If the dashboard is ready but does not open, open the reported HTML path directly or install `xdg-open` on Linux. No local URL should be listening.
5. A bridge warning means the original Pi action was preserved. Check restrictive path/symlink conditions and run `doctor`; do not assume optimization occurred.
6. For pinned installs, install a new explicit npm version or Git ref rather than expecting `pi update --extensions` to move the pin.
7. Use purge preview before deleting local optimizer data. Purge never repairs or removes Pi session files.

## Development

The release toolchain is pinned in `mise.toml` to Node 26.8.1 and Python 3.14.7; CI also covers Python 3.12.

```sh
mise install
npm ci
npm run check
PI_TOKEN_OPTIMIZER_BENCH_ITERATIONS=2 npm run benchmark
```

`npm run check` runs typechecking, TypeScript tests, Python tests, real integration tests, vendor verification, and the package contract. `npm run package:check` is an optional focused shortcut for the package and capability contracts already covered by `npm test`. The benchmark reports observations only; record release smoke results using [docs/release-checklist.md](docs/release-checklist.md).

## License

Pi Token Optimizer is source-available under [PolyForm Noncommercial 1.0.0](LICENSE). Noncommercial use is governed by that license. Commercial use requires a separate upstream license from Alex Greenshpun; this repository cannot grant it. Upstream attribution and notices are in [NOTICE](NOTICE) and the vendored legal files.
