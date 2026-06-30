const REQUIRED_FIELDS = ["name", "runtime", "repo", "branch", "port", "domain", "database", "health", "build", "start"] as const;
const VALID_RUNTIMES = ["node", "python", "static"] as const;
const DOMAIN_RE = /^localhost$|^[a-zA-Z0-9][a-zA-Z0-9.-]{1,252}[a-zA-Z0-9]$/;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}[a-zA-Z0-9]$|^[a-zA-Z0-9]{2}$/;

export interface AppManifest {
  name: string;
  runtime: "node" | "python" | "static";
  repo: string;
  branch: string;
  port: number;
  domain: string;
  database: "sqlite";
  health: string;
  build: string;
  start: string;
}

export function isValidAppName(name: string): boolean {
  return NAME_RE.test(name) && name.length >= 2 && name.length <= 64;
}

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain);
}

export function parseManifest(content: string): AppManifest {
  const raw: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(": ");
    if (colon === -1) continue;
    raw[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 2).trim();
  }
  const missing = REQUIRED_FIELDS.filter(f => !(f in raw));
  if (missing.length > 0) throw new Error(`missing required field: ${missing[0]}`);
  return {
    name: raw.name,
    runtime: raw.runtime as AppManifest["runtime"],
    repo: raw.repo,
    branch: raw.branch,
    port: parseInt(raw.port, 10),
    domain: raw.domain,
    database: "sqlite",
    health: raw.health,
    build: raw.build,
    start: raw.start,
  };
}

export function validateManifest(m: AppManifest): string[] {
  const errors: string[] = [];
  if (!isValidAppName(m.name)) errors.push(`name must be 2-64 alphanumeric/hyphen chars, no leading/trailing hyphens`);
  if (!VALID_RUNTIMES.includes(m.runtime)) errors.push(`runtime must be one of: ${VALID_RUNTIMES.join(", ")}`);
  if (m.port < 1024 || m.port > 65535) errors.push(`port must be 1024-65535`);
  if (!isValidDomain(m.domain)) errors.push(`domain must be a valid hostname`);
  if (!m.health.startsWith("/")) errors.push(`health path must start with /`);
  if (!m.repo) errors.push(`repo must not be empty`);
  if (!m.branch) errors.push(`branch must not be empty`);
  return errors;
}

export function serializeManifest(m: AppManifest): string {
  return [
    `name: ${m.name}`,
    `runtime: ${m.runtime}`,
    `repo: ${m.repo}`,
    `branch: ${m.branch}`,
    `port: ${m.port}`,
    `domain: ${m.domain}`,
    `database: ${m.database}`,
    `health: ${m.health}`,
    `build: ${m.build}`,
    `start: ${m.start}`,
  ].join("\n") + "\n";
}
