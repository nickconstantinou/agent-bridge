const ASSIGNMENT_SECRET_KEYS = [
  "access[_-]?key",
  "api[_-]?key",
  "auth[_-]?token",
  "bearer[_-]?token",
  "client[_-]?secret",
  "connection[_-]?string",
  "credential",
  "database[_-]?url",
  "db[_-]?url",
  "github[_-]?token",
  "gh[_-]?token",
  "oauth[_-]?token",
  "password",
  "private[_-]?key",
  "refresh[_-]?token",
  "secret",
  "secret[_-]?access[_-]?key",
  "secret[_-]?key",
  "session[_-]?token",
  "token",
].join("|");

const ASSIGNMENT_SECRET_RE = new RegExp(
  `(["']?(?:${ASSIGNMENT_SECRET_KEYS})["']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;]+)`,
  "gi",
);

/**
 * Repository evidence may contain credentials in otherwise ordinary source,
 * fixture, config, diff, or log text. This scrubber is intentionally broader
 * than the conversational prompt redactor and runs before any evidence leaves
 * the Bridge-owned broker.
 */
export function redactAdvisorEvidenceText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(ASSIGNMENT_SECRET_RE, "$1[REDACTED]")
    .replace(/\b((?:proxy-)?authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\/\s:@]+):([^@\s\/]+)@/gi, "$1[REDACTED]@")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED JWT]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS ACCESS KEY]")
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[REDACTED TOKEN]")
    .replace(/\b(token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}
