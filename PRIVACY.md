# Pi Token Optimizer Privacy Policy

## Local processing

Pi Token Optimizer is source-available software that processes optimizer data locally. It makes no telemetry or other outbound network requests during normal operation, uses no accounts, and sends no product data to third parties. Installation and updates are handled by Pi's normal package-management flow.

This initial package does not collect or store optimizer activity data. When optimization behavior is enabled in a later release, it will require explicit Pi-specific consent before activity processing begins.

## Pi data boundary

The optimizer will use only Pi's agent directory, including `PI_CODING_AGENT_DIR` when configured. It will not read or modify Claude Code, Codex, OpenCode, or other coding-agent settings, sessions, or data directories. It will not rewrite project source files or Pi settings during normal operation.

## Planned local storage and retention

After consent, the optimizer may store credential-redacted session metrics, per-session read-cache data, continuity checkpoints, and large tool-result archives beneath `<pi-agent-dir>/token-optimizer/`. Directories and files will use restrictive permissions. Retention will be controlled locally through documented `TOKEN_OPTIMIZER_*` settings; planned defaults are 48 hours for per-session caches, 24 hours for tool archives, and 7 days for checkpoints. The package will provide a confirmed purge that is limited to this Pi-specific optimizer root and never deletes Pi session files.

Credential redaction is one-way for persisted cache and archive content. Pi tool output shown in a session is not redacted by this policy.

## Commercial licensing

Pi Token Optimizer is licensed under [PolyForm Noncommercial 1.0.0](LICENSE). Noncommercial personal, research, educational, and similar use is permitted under those terms. Commercial use requires a separate upstream license from Alex Greenshpun. Contact [Alex Greenshpun](https://linkedin.com/in/alexgreensh) for licensing or privacy questions.
