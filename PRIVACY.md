# Pi Token Optimizer Privacy Policy

Pi Token Optimizer 0.1.0 adapts Token Optimizer 5.13.4 to Pi. This document describes the shipped Pi package, not every capability present in the vendored upstream source.

## Consent

Optimizer activity requires a current local grant. On a fresh eligible interactive session, Pi displays a notice before activation. RPC clients can relay the same confirmation request when activation is first needed. JSON and print modes do not prompt or auto-grant. Users can inspect, grant, or reset consent with `/token-optimizer consent show|grant|reset`; resetting consent disables activity immediately. A newer notice version invalidates an older grant.

The notice covers credential-redacted read-cache excerpts, credential-redacted tool archives, session metrics, continuity checkpoints with brief session snippets, local retention, purge, absence of optimizer telemetry, and the selected-provider compaction exception described below.

## Local reads and isolation

The extension receives the current Pi session ID, working directory, optional Pi session file, selected provider/model, and tool events from Pi. The session adapter accepts Pi v3 JSONL files only when they are the current session or are under Pi's configured session roots.

The runtime is pinned to Pi and its data roots are pinned beneath the Pi agent directory. It does not scan or use Claude Code, Codex, OpenCode, Hermes, Copilot, Cursor, or other agent settings, sessions, credentials, or data directories. It does not rewrite project source or Pi settings during normal operation. The vendored upstream installer, marketplace, daemon, and foreign-runtime entrypoints are not exposed by the Pi extension.

## Local data

`<pi-agent-dir>` means `PI_CODING_AGENT_DIR` when set, otherwise Pi's default `~/.pi/agent`.

| Category | Pi-only path | Contents and sensitive-data considerations | Default retention |
| --- | --- | --- | --- |
| Configuration | `<pi-agent-dir>/token-optimizer/config.json` | Enabled state, consent grant, notice version, and grant timestamp | Until purge |
| Session metrics | `<pi-agent-dir>/token-optimizer/data/trends.db` | Pi-prefixed session identifiers, project names, model/provider names, token/cache counts, costs, timestamps, tool counts, and derived scores. Project names can be sensitive. | Unlimited; `TOKEN_OPTIMIZER_TRENDS_RETENTION_DAYS=0` means unlimited |
| Per-session read cache | `<pi-agent-dir>/token-optimizer/data/session-store/<session-id>.db` | File paths, hashes, activity metadata, and credential-redacted source excerpts | 48 hours |
| Tool archives | `<pi-agent-dir>/token-optimizer/data/tool-archive/<session-id>/` | Credential-redacted successful text tool output, which may include source, command output, or API responses | 24 hours, with aggregate defaults of 1,000 files and 100 MiB |
| Continuity checkpoints | `<pi-agent-dir>/token-optimizer/checkpoints/` | Brief user/assistant text, decisions, errors, todos, and file paths. These snippets may contain personal, confidential, or credential-like text and are not promised to be fully redacted. | 7 days and at most 50 files |
| Quality cache and markers | `<pi-agent-dir>/token-optimizer/quality-cache-*.json` and other quality/run-once marker files in `<pi-agent-dir>/token-optimizer/` | Per-session quality scores, state, and identifiers derived from Pi activity | 7 days for quality-cache JSON; `0` means unlimited |
| Checkpoint event log | `<pi-agent-dir>/token-optimizer/checkpoint-events.jsonl` | Checkpoint event metadata | At most 1,000 entries |
| Live-fill cache | `<pi-agent-dir>/token-optimizer/live-fill.json` | Current context-fill state | Replaced as activity changes |
| Static dashboard | `<pi-agent-dir>/token-optimizer/dashboard.html` and its metadata sidecar | A generated local view of metrics and derived results | Replaced when regenerated |
| Auxiliary data | `<pi-agent-dir>/token-optimizer/data/` | Retention markers, diagnostics, SQLite sidecars, and temporary state used by the categories above | Follows the related category or remains until purge |

Retention controls are local environment variables:

- `TOKEN_OPTIMIZER_ARCHIVE_RETENTION_HOURS` (default 24), `TOKEN_OPTIMIZER_ARCHIVE_RETENTION_MAX_FILES` (1,000), and `TOKEN_OPTIMIZER_ARCHIVE_RETENTION_MAX_BYTES` (104,857,600);
- `TOKEN_OPTIMIZER_CHECKPOINT_RETENTION_DAYS` (7) and `TOKEN_OPTIMIZER_CHECKPOINT_RETENTION_MAX` (50);
- `TOKEN_OPTIMIZER_QUALITY_CACHE_RETENTION_DAYS` (7; 0 disables expiry);
- `TOKEN_OPTIMIZER_TRENDS_RETENTION_DAYS` (0, unlimited);
- `TOKEN_OPTIMIZER_CHECKPOINT_EVENT_MAX` (1,000).

The 48-hour session-store limit is fixed in the shipped engine. Its cleanup and configured nonzero trends cleanup run best effort on consented `session_start` when Pi supplies a real current session file; neither has a background retention service. Files created by the integration use restrictive local permissions where the platform supports them, but host filesystem policy and backups remain the user's responsibility.

## Redaction limits

Read-cache excerpts and tool archives pass through the upstream pattern-based credential redactor before storage. It recognizes 23 categories such as common API keys, tokens, private keys, database credentials, and URL authentication parameters. Redaction is one-way in the stored copy.

Pattern matching cannot guarantee removal of every secret, personal datum, proprietary value, encoded value, or novel credential format. File paths, metrics, checkpoints, diagnostics, dashboard content, and Pi's own session files have different content and are not covered by a blanket redaction guarantee. Successful Bash compression may preserve credential-containing visible lines so the output returned to Pi is not corrupted; that Pi-visible content is governed by Pi session/provider handling. Failed and image-bearing tool results are not replaced by the optimizer.

## Provider and network behavior

The optimizer's analysis, one-shot Python bridge, storage, retention, and purge are local. The package has no optimizer telemetry, account, tracking pixel, runtime update check, or optimizer-operated remote service. Opening the optional static dashboard has the browser-only network behavior described below.

Pi provider calls are not local unless the user selected a local provider. Ordinary Pi context may include bounded recovery or quality guidance produced locally by the extension. During optimized compaction, the package sends the current context, split-turn prefix when present, previous summary when present, user compaction instructions, and local optimizer guidance through the user's selected Pi provider as a normal Pi model call. Provider credentials, transport, retention, and billing are controlled by Pi and that provider. If guidance or the provider fails, Pi's default compaction path is preserved and read state is not cleared.

The dashboard command generates and opens a static `file://` HTML document. The Pi package starts no HTTP listener, local server, or dashboard daemon. The document allows Google Fonts resources and requests the upstream repository's public star count, so opening it can cause the browser to contact Google Fonts and the GitHub API; clicking its upstream social or repository links contacts those sites. No optimizer dataset is intentionally included in those requests.

Installing or updating the package is separate from runtime behavior. Pi's package manager contacts npm or the configured Git remote to resolve and download a requested package; Pi's own update checks and install telemetry are independently controlled by Pi settings and environment variables. Those operations are not initiated as optimizer telemetry.

## Purge and Pi sessions

`/token-optimizer purge` previews the exact optimizer root, file count, and byte count. TUI and RPC require confirmation. JSON and print modes refuse deletion after preview because they cannot confirm. A confirmed purge first disables the active instance and drains tracked bridge work, then removes only `<pi-agent-dir>/token-optimizer/`.

Purge excludes Pi session JSONL files under `<pi-agent-dir>/sessions/` or any separately configured Pi session directory. It also does not delete foreign-agent data. Copies in filesystem backups, snapshots, browser caches, provider systems, or exported Pi sessions must be managed separately.

## Dashboard access

Dashboard generation reads local optimizer metrics and writes the static dashboard path above. The command validates the real directory and file, rejects symlinked or unexpected destinations, and uses only `open` on macOS or `xdg-open` on Linux. If no opener succeeds, it reports the local path.

## License and contact

Pi Token Optimizer is source-available under [PolyForm Noncommercial 1.0.0](LICENSE). Noncommercial use is subject to that license. Commercial use requires a separate upstream license from Alex Greenshpun; this adaptation cannot grant commercial rights. Upstream attribution and contact links are recorded in [NOTICE](NOTICE) and the vendored legal files. Project-specific issues can be reported at <https://github.com/edlontech/pi-token-optimizer/issues>.
