# Pi Capability Matrix

Version 0.1.0 adapts a bounded subset of Token Optimizer 5.13.4 for Pi. Status means:

- **Supported:** a user-facing Pi package behavior is shipped.
- **Adapted:** an upstream engine behavior is shipped through Pi-specific event, session, or safety translation.
- **Deferred:** related upstream code may be vendored, but no Pi entrypoint exposes the behavior in this version.
- **Unavailable:** the behavior is deliberately inactive for the stated environment or input.

Each row names one exact automated test or manual release checklist item. Passing one row is evidence only for that capability.

| Capability | Status | Evidence |
| --- | --- | --- |
| Bounded `/token-optimizer` command controls | Supported | Automated test: `registers one bounded command family with nested completions and concise usage errors` |
| Bounded `token_optimizer_expand` model tool | Supported | Automated test: `registers only the bounded archive expansion tool with pagination details` |
| Current-notice consent before automatic activity in interactive Pi | Supported | Automated test: `TUI session startup grants current consent only after confirmation` |
| Local enable control | Supported | Automated test: `consent and disable transitions save locally and gate activity immediately` |
| Local disable control | Supported | Automated test: `consent and disable transitions save locally and gate activity immediately` |
| Local consent reset | Supported | Automated test: `consent and disable transitions save locally and gate activity immediately` |
| Immediate session gating after local control transitions | Supported | Automated test: `consent and disable transitions save locally and gate activity immediately` |
| Real static dashboard generation at the Pi-only destination | Supported | Python unittest: `test_real_dashboard_action_writes_only_the_pi_static_destination` |
| Dashboard opener confinement to the validated static destination | Supported | Automated test: `dashboard validates the static destination and uses only the platform opener` |
| Previewed, confirmed optimizer-data purge that preserves Pi sessions | Supported | Automated test: `purge deletes only the exact optimizer child and leaves Pi sessions untouched` |
| Automatic lifecycle registration on Pi 0.84.4 and newer | Adapted | Automated test: `version gate registers the full surface once only for Pi 0.84.4 or newer` |
| Pi v3 active-branch reconstruction | Adapted | Python unittest: `test_reconstructs_last_branch_and_excludes_abandoned_entries` |
| Pi usage metrics exclude abandoned branches | Adapted | Python unittest: `test_uses_only_usage_from_the_active_branch` |
| Pi message quality-signal extraction | Adapted | Python unittest: `test_extracts_quality_signals_from_pi_messages` |
| Idempotent current-session Pi rollup | Adapted | Automated test: `real lifecycle recovers once, returns filterable nudges, and rollup is idempotent` |
| Read-cache substitution | Adapted | Automated test: `real read cache substitutes rereads, observes edit invalidation, and clears only after success` |
| Read-cache invalidation after edits | Adapted | Automated test: `real read cache substitutes rereads, observes edit invalidation, and clears only after success` |
| Read-cache clear after successful compaction | Adapted | Automated test: `real read cache substitutes rereads, observes edit invalidation, and clears only after success` |
| Bash text-result compression | Adapted | Automated test: `real bundled engine compresses representative outputs and every advertised archive reconstructs` |
| External text-result compression | Adapted | Automated test: `real bundled engine compresses representative outputs and every advertised archive reconstructs` |
| Local archive reconstruction | Adapted | Automated test: `real bundled engine compresses representative outputs and every advertised archive reconstructs` |
| Local quality nudges | Adapted | Python unittest: `test_before_prompt_combines_only_normalized_safe_function_output` |
| One-time continuity recovery | Adapted | Automated test: `real lifecycle recovers once, returns filterable nudges, and rollup is idempotent` |
| Normal custom compaction | Adapted | Automated test: `real extension flow retains read state on failed compaction, clears on success, and handles normal and split-turn fake model calls` |
| Split-turn custom compaction | Adapted | Automated test: `real extension flow retains read state on failed compaction, clears on success, and handles normal and split-turn fake model calls` |
| Custom compaction through the selected Pi provider | Adapted | Automated test: `real extension flow retains read state on failed compaction, clears on success, and handles normal and split-turn fake model calls` |
| Best-effort 48-hour session-store cleanup on consented session start | Adapted | Python unittest: `test_consented_session_start_removes_a_real_expired_session_store` |
| Best-effort configured trends cleanup on consented session start | Adapted | Python unittest: `test_consented_session_start_prunes_only_expired_real_trends_rows` |
| Fail-open pass-through on bridge crash | Adapted | Automated test: `crash, malformed output, and missing Python execute and fail open with exact Pi pass-through` |
| Fail-open pass-through on malformed bridge output | Adapted | Automated test: `crash, malformed output, and missing Python execute and fail open with exact Pi pass-through` |
| Fail-open pass-through when Python is missing | Adapted | Automated test: `crash, malformed output, and missing Python execute and fail open with exact Pi pass-through` |
| Isolation from Claude Code, Codex, OpenCode, Hermes, Copilot, and Cursor data | Adapted | Automated test: `every supported real bridge action leaves all foreign-agent sentinel bytes and metadata unchanged` |
| Upstream installer commands | Deferred | Automated test: `registration starts no bridge or process and exposes no extra command or tool` |
| Upstream marketplace commands | Deferred | Automated test: `registration starts no bridge or process and exposes no extra command or tool` |
| Upstream status-line commands | Deferred | Automated test: `registration starts no bridge or process and exposes no extra command or tool` |
| Upstream daemon commands | Deferred | Automated test: `registration starts no bridge or process and exposes no extra command or tool` |
| Upstream skill-management commands | Deferred | Automated test: `registration starts no bridge or process and exposes no extra command or tool` |
| Upstream model-routing advice that changes Pi's selected model | Deferred | Manual checklist item: `CAP-01 — Deferred upstream entrypoints and model-routing controls remain unreachable through Pi.` |
| Network dashboard daemon and listener | Deferred | Manual checklist item: `UI-02 — Dashboard opening uses a static file and starts no listener.` |
| Automatic optimization on Pi older than 0.84.4 | Unavailable | Automated test: `old Pi command mode stays local and reports Python-backed controls unavailable` |
| Tool-result replacement for image-bearing results | Unavailable | Automated test: `post-tool reports joined text and guarded builtin Bash full output without replacing images` |
| Tool-result replacement for failed tools | Unavailable | Automated test: `post-tool bridge failures and replacements for errors fail open` |
| Windows release support in 0.1.0 | Unavailable | Manual checklist item: `PLATFORM-03 — Windows is marked unavailable for version 0.1.0.` |

See [the release checklist](release-checklist.md) for platform and manual verification, and the [README](../README.md) for operation and configuration.
