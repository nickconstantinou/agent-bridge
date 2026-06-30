// Redact values of env-var-like keys that indicate secrets.
// Pattern: <WORD_ENDING_IN_SECRET_INDICATOR>=<value>
const SECRET_PATTERN = /\b(\w*(?:SECRET|TOKEN|PASSWORD|KEY|PASS|CREDENTIAL|AUTH)\w*=)[^\s&]*/gi;

export function redact(text: string): string {
  return text.replace(SECRET_PATTERN, (_, key) => `${key}***`);
}
