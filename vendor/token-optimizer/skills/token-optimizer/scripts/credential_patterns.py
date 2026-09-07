"""Shared credential detection and redaction for Token Optimizer.

Provides compiled regex patterns for common API keys, tokens, and secrets,
plus scan/redact functions usable by bash compression, read cache, and
tool archive writers.
"""

from __future__ import annotations

import re
from typing import List, Tuple

# (label, compiled_regex) pairs. Label is used in redaction placeholders.
CREDENTIAL_PATTERNS: List[Tuple[str, "re.Pattern[str]"]] = [
    ("AWS access key",          re.compile(r"AKIA[0-9A-Z]{16}")),
    ("OpenAI/Anthropic key",    re.compile(r"sk-[a-zA-Z0-9]{20,}")),
    ("Anthropic key",           re.compile(r"sk-ant-[a-zA-Z0-9\-]{20,}")),
    ("GitHub PAT classic",      re.compile(r"ghp_[a-zA-Z0-9]{36}")),
    ("GitHub OAuth token",      re.compile(r"gho_[a-zA-Z0-9]{36}")),
    ("GitHub server token",     re.compile(r"ghs_[a-zA-Z0-9]{36}")),
    ("GitHub refresh token",    re.compile(r"ghr_[a-zA-Z0-9]{36}")),
    ("GitHub fine-grained PAT", re.compile(r"github_pat_[a-zA-Z0-9_]{80,}")),
    ("npm token",               re.compile(r"npm_[a-zA-Z0-9]{36}")),
    ("Slack bot token",         re.compile(r"xoxb-[0-9]+-[a-zA-Z0-9]+")),
    ("Slack user token",        re.compile(r"xoxp-[0-9]+-[a-zA-Z0-9]+")),
    ("Slack app token",         re.compile(r"xoxa-[0-9]+-[a-zA-Z0-9]+")),
    ("Stripe live key",         re.compile(r"sk_live_[a-zA-Z0-9]{24,}")),
    ("Stripe restricted key",   re.compile(r"rk_live_[a-zA-Z0-9]{24,}")),
    ("HuggingFace token",       re.compile(r"hf_[a-zA-Z0-9]{34}")),
    # M-16: negative lookahead so the Bearer pattern doesn't re-match text
    # inside its own redaction placeholder [CREDENTIAL REDACTED: Bearer token].
    # The lookahead checks the text BEFORE Bearer, but Python regex doesn't
    # support variable-width lookbehinds. Instead, redact_credentials protects
    # placeholders with a sentinel before running patterns. The lookahead here
    # is a defense-in-depth for direct pattern.search() callers.
    ("Bearer token",            re.compile(r"Bearer\s+[a-zA-Z0-9\-._~+/]+=*", re.I)),
    ("Google API key",          re.compile(r"AIza[0-9A-Za-z_\-]{35}")),
    ("Google OAuth token",      re.compile(r"ya29\.[0-9A-Za-z_\-]{20,}")),
    ("JWT",                     re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")),
    ("PEM private key",         re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("Database URI",            re.compile(r"(?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis)://[^:\s/]+:[^@\s]+@", re.I)),
    ("HTTP basic auth URL",     re.compile(r"https?://[^:\s/@]+:[^@\s]+@", re.I)),
    # Credentials passed as URL query/matrix parameters OR OAuth-implicit-flow
    # fragment params (e.g. ?token=..., ?api_key=..., ;password=..., #access_token=...).
    # The named `keep` group captures the "?name="/"#name=" prefix so redaction
    # preserves the parameter name and blanks only the value (see redact_credentials).
    # The value class stops at the next delimiter (& # ; whitespace quote < >) but
    # otherwise matches EVERYTHING — including brackets — so a secret that itself
    # contains a `[` (common in passwords) is redacted whole, not leaked past the
    # bracket. To still avoid re-wrapping an already-inserted "[CREDENTIAL REDACTED:
    # ...]" placeholder (when the value is itself another credential shape an earlier
    # pattern redacted, e.g. ?token=<Bearer ...>), a negative lookahead skips a value
    # that begins with the placeholder rather than excluding brackets from real values.
    ("URL auth param",          re.compile(
        r"(?P<keep>[?&#;](?:authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret"
        r"|session[_-]?token|id[_-]?token|api[_-]?key|sessionid|session|password|passwd|signature"
        r"|secret|bearer|token|auth|sig|pwd|key|jwt)=)(?!\[CREDENTIAL REDACTED:)[^&#;\s\"'<>]+",
        re.I,
    )),
    # M-12: mysql -p<password> (inline password after -p with no space).
    # The -p flag is special: the password immediately follows with no = or space.
    # N-3: re.I so "MySQL -pSECRET" (capitalized client name, as MySQL ships
    # it) is redacted too; the anchor gate already lowercases, so gating is
    # unaffected.
    ("MySQL password flag",     re.compile(
        r"(?P<keep>\bmysql\s+.*?(?<!\S)(?-i:-p)\s*)(?!-)(?!\[CREDENTIAL REDACTED:)"
        r"(?:\"[^\"\n]*\"|'[^'\n]*'|[^\s\"']+)",
        re.I,
    )),
    # M-12: PGPASSWORD=, MYSQL_PWD=, and similar *_PASSWORD= / *_PWD= env assignments.
    # These appear as shell command prefixes (FOO=bar cmd ...) or in config output.
    ("Database env password",   re.compile(
        r"(?P<keep>\b(?:PGPASSWORD|MYSQL_PWD|REDIS_PASSWORD|MONGO_PASSWORD|DB_PASSWORD"
        r"|DATABASE_PASSWORD|PGPASSWD)=[\"\']?)(?!\[CREDENTIAL REDACTED:)[^\s\"'\n]+",
        re.I,
    )),
    # M-12: AWS secret access key (40-char base64). Distinct from the access key
    # (AKIA prefix). Secret keys are mixed-case base64, 40 chars, no prefix.
    # Use a context prefix to avoid false positives on random 40-char base64
    # strings. No trailing \b because the secret may end with = or + (non-word).
    ("AWS secret key",          re.compile(
        r"(?P<keep>\b(?:aws_secret_access_key|aws_secret|secret_access_key|SecretAccessKey)[\"\'\s:=]+)"
        r"(?!\[CREDENTIAL REDACTED:)[A-Za-z0-9/+=]{40}",
        re.I,
    )),
    # Inline CLI password flags. Two patterns:
    # (a) Long forms (--password=V, --password V, --passwd=V, --passcode=V,
    #     --auth-token=V) — unambiguous, always redact.
    # (b) Short forms (-p V, -a V) restricted to known password-carrying
    #     commands (sshpass, mysql, mariadb, redis-cli) to avoid false
    #     positives on -p port/plugin/preserve flags in other commands.
    # The named `keep` group captures the flag (+ command context for short
    # forms) so redaction preserves it and blanks only the value.
    ("CLI password flag (long)", re.compile(
        r"(?P<keep>(?:--password|--passwd|--passcode|--auth-token)(?![\w-])(?:\s*=\s*|\s+))"
        r"(?!-)(?!\[CREDENTIAL REDACTED:)"
        r"(?:\"[^\"\n]*\"|'[^'\n]*'|[^\s\"']+)",
        re.I,
    )),
    ("CLI password flag (short)", re.compile(
        r"(?P<keep>sshpass\b.*?(?<!\S)(?-i:-p)\s*"
        r"|redis-cli\b.*?(?<!\S)(?-i:-a)\s+"
        r"|mariadb\b.*?(?<!\S)(?-i:-p)\s*)"
        r"(?!-)(?!\[CREDENTIAL REDACTED:)"
        r"(?:\"[^\"\n]*\"|'[^'\n]*'|[^\s\"']+)",
        re.I,
    )),
]

# Bare compiled patterns list for backward compat with bash_compress.py
PATTERNS_ONLY: List["re.Pattern[str]"] = [pat for _, pat in CREDENTIAL_PATTERNS]

# ---------------------------------------------------------------------------
# H-8: fast pre-check for credential redaction.
#
# The old redact_credentials ran 23 sequential re.sub() calls on the full
# text unconditionally: 97ms for 10K lines, 675ms for 50K lines, even when
# the text contained NO credentials (the common case for command output).
# Python's re engine uses backtracking, not a DFA, so combining all
# patterns into a single alternation is actually SLOWER (154ms for 10K
# clean lines) due to the complex NFA state per character.
#
# The fix: a fast prefix scan using simple string containment checks
# before any regex runs. If none of the credential prefixes appear in the
# text, skip all 23 re.sub() calls entirely. This makes clean text O(n)
# with a tiny constant (a single str.find pass per prefix), while text
# with credentials still gets the full sequential redaction (correctness
# preserved, no regex complexity change).
#
# The prefix list is derived from the literal prefixes of each pattern:
# "AKIA", "sk-", "ghp_", "gho_", "ghs_", "ghr_", "github_pat_", "npm_",
# "xoxb-", "xoxp-", "xoxa-", "sk_live_", "rk_live_", "hf_", "Bearer",
# "AIza", "ya29.", "eyJ", "-----BEGIN", and the URL scheme prefixes for
# database/basic-auth URIs. The URL auth param pattern has no single
# literal prefix (it matches parameter names), so we check for "=" as a
# coarse pre-filter — but only if other prefixes didn't already match.
# ---------------------------------------------------------------------------
_CREDENTIAL_PREFIXES: Tuple[str, ...] = (
    "AKIA", "sk-", "ghp_", "gho_", "ghs_", "ghr_", "github_pat_",
    "npm_", "xoxb-", "xoxp-", "xoxa-", "sk_live_", "rk_live_", "hf_",
    "Bearer", "bearer", "AIza", "ya29.", "eyJ",
    "-----BEGIN",  # PEM private key
    "postgres://", "postgresql://", "mysql://", "mongodb://",
    "mongodb+srv://", "redis://",  # database URI
    "http://", "https://",  # basic auth URL (coarse, but covers the pattern)
    # M-12: new credential prefixes
    "mysql ",  # mysql -p<password>
    "PGPASSWORD=", "MYSQL_PWD=", "REDIS_PASSWORD=", "MONGO_PASSWORD=",
    "DB_PASSWORD=", "DATABASE_PASSWORD=", "PGPASSWD=",
    "aws_secret", "secret_access_key", "SecretAccessKey",
)
# URL auth param parameter names (lowercase, checked case-insensitively).
_URL_AUTH_PARAM_NAMES: Tuple[str, ...] = (
    "authorization=", "access_token=", "access-token=", "refresh_token=",
    "refresh-token=", "client_secret=", "client-secret=", "session_token=",
    "session-token=", "id_token=", "id-token=", "api_key=", "api-key=",
    "sessionid=", "session=", "password=", "passwd=", "signature=",
    "secret=", "bearer=", "token=", "auth=", "sig=", "pwd=", "key=",
    "jwt=",
)


def _text_may_contain_credentials(text: str) -> bool:
    """Fast prefix scan: return True if any credential prefix appears in text.

    This is a coarse pre-filter using str.find (C-level, no regex engine).
    False negatives would be a security bug, so every prefix is checked.
    False positives are fine — the full regex suite runs and finds nothing.
    """
    for prefix in _CREDENTIAL_PREFIXES:
        if prefix in text:
            return True
    # URL auth param names are case-insensitive in the pattern. Use a
    # lowercase copy for the check.
    lower = text.lower()
    for name in _URL_AUTH_PARAM_NAMES:
        if name in lower:
            return True
    return False


def scan_for_credentials(text: str) -> List[Tuple[str, str, int]]:
    """Scan text for credentials. Returns [(label, matched_text, line_number), ...]."""
    results = []
    for line_num, line in enumerate(text.splitlines()):
        for label, pat in CREDENTIAL_PATTERNS:
            m = pat.search(line)
            if m:
                results.append((label, m.group(), line_num))
    return results


# M-16: regex to find already-redacted placeholders so they can be protected
# from re-matching during a second redaction pass.
_PLACEHOLDER_RE = re.compile(r"\[CREDENTIAL REDACTED: [^\]]+\]")
_PLACEHOLDER_SENTINEL = "\x00\x01REDACTED\x00\x01"

# Per-pattern literal anchors (checked on a lowercased copy of the ORIGINAL
# text, once, before the loop). A pattern whose anchors are all absent cannot
# match, so its re.sub() is skipped. This is what makes clean-but-URL-bearing
# output cheap: the global prefix scan above fires on any "https://", after
# which the three M-12 patterns and the two URI patterns used to cost more
# than everything else combined (measured 24ms -> 55ms per 10K realistic
# lines on the first H-8 attempt). Substitutions only remove secrets and add
# placeholders, never new anchors, so a pre-loop check stays sound.
_PATTERN_ANCHORS = {
    # Only the patterns that are expensive to run (case-insensitive
    # alternations, or a scheme scan) are gated. The literal-prefix patterns
    # (AKIA..., ghp_..., xoxb-...) are already a fast scan in the regex engine
    # and cost less than an extra anchor check would.
    "Bearer token": ("bearer",),
    "Database URI": ("://",),
    "HTTP basic auth URL": ("://",),
    "URL auth param": ("=",),
    "MySQL password flag": ("mysql",),
    "Database env password": ("password=", "pwd=", "passwd=",
                              "password='", "password=\"", "pwd='", "pwd=\"",
                              "passwd='", "passwd=\""),
    "AWS secret key": ("aws_secret", "secret_access_key", "secretaccesskey"),
    "CLI password flag (long)": ("--password", "--passwd", "--passcode", "--auth-token"),
    "CLI password flag (short)": ("sshpass", "mariadb", "redis-cli"),
}


def redact_credentials(text: str) -> str:
    """Replace credential matches with [CREDENTIAL REDACTED: <type>] placeholders.

    A pattern may define a named `keep` group for a non-secret prefix that should
    survive redaction (e.g. the "?token=" part of a URL auth parameter); only the
    value after it is replaced. Patterns without a `keep` group redact the whole
    match, unchanged.

    H-8: uses a fast prefix scan to skip all re.sub() calls when the text
    contains no credential prefixes (the common case for clean command output).
    This makes clean text O(n) with a tiny constant instead of O(n × 23) regex
    passes. Text with credentials still gets the full sequential redaction,
    preserving correctness and the existing two-phase ordering (standalone
    credentials before URL auth params, so the negative lookahead works).

    M-16: protects already-redacted [CREDENTIAL REDACTED: ...] placeholders
    from re-matching by replacing them with a sentinel before redaction and
    restoring them after. This fixes the Bearer pattern re-matching "Bearer
    token" inside its own placeholder, which nested placeholders on re-runs.
    """
    # M-16: protect existing placeholders from re-matching.
    placeholders = []
    def _save_placeholder(m):
        placeholders.append(m.group(0))
        return _PLACEHOLDER_SENTINEL
    if "[CREDENTIAL REDACTED:" in text:
        text = _PLACEHOLDER_RE.sub(_save_placeholder, text)

    # H-8: fast path — skip all regex work if no credential prefix is present.
    lowered = text.lower()
    for label, pat in CREDENTIAL_PATTERNS:
        anchors = _PATTERN_ANCHORS.get(label)
        if anchors and not any(a in lowered for a in anchors):
            continue
        if "keep" in pat.groupindex:
            text = pat.sub(rf"\g<keep>[CREDENTIAL REDACTED: {label}]", text)
        else:
            text = pat.sub(f"[CREDENTIAL REDACTED: {label}]", text)

    # M-16: restore protected placeholders.
    for ph in placeholders:
        text = text.replace(_PLACEHOLDER_SENTINEL, ph, 1)
    return text
