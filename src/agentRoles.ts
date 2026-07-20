import { createHash } from "node:crypto";

export const AGENT_ROLE_IDS = [
  "technical_lead",
  "code_worker",
  "documentation_steward",
] as const;

export type AgentRoleId = (typeof AGENT_ROLE_IDS)[number];

export const AGENT_ROLE_MODES = {
  technical_lead: [
    "requirements",
    "issue_validation",
    "issue_authoring",
    "decomposition_review",
    "planning",
    "planning_repair",
    "executor_guidance",
    "implementation_review",
    "operations_review",
    "pr_readiness",
  ],
  code_worker: ["scan", "investigate", "red", "green", "repair", "verify"],
  documentation_steward: ["impact", "author", "validate", "maintenance"],
} as const satisfies Record<AgentRoleId, readonly string[]>;

export type RoleAssignmentSelection = "automatic" | "recommended" | "manual";
export type RoleAssignmentSource = "environment" | "operator" | "platform";
export type RoleAssignmentStatus = "configured_dormant";

interface RoleAssignmentTarget {
  cli: string;
  model: string;
}

export interface RoleAssignment {
  role: AgentRoleId;
  selection: RoleAssignmentSelection;
  primary: RoleAssignmentTarget;
  fallbacks: RoleAssignmentTarget[];
}

export interface RoleAssignmentConfig {
  scopeKey: string;
  source: RoleAssignmentSource;
  status: RoleAssignmentStatus;
  idempotencyKey: string;
  assignments: RoleAssignment[];
}

export type RoleAssignmentConfigErrorCode =
  | "invalid_json"
  | "invalid_shape"
  | "invalid_scope"
  | "invalid_role"
  | "missing_role"
  | "duplicate_role"
  | "invalid_selection"
  | "invalid_target"
  | "duplicate_target"
  | "too_many_fallbacks"
  | "unknown_field"
  | "forbidden_field"
  | "forbidden_value";

export class RoleAssignmentConfigError extends Error {
  constructor(
    public readonly code: RoleAssignmentConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoleAssignmentConfigError";
  }
}

const ROLE_SET = new Set<string>(AGENT_ROLE_IDS);
const CLI_SET = new Set<string>(["codex", "claude", "antigravity"]);
const SELECTION_SET = new Set<string>(["automatic", "recommended", "manual"]);
const ASSIGNMENT_FIELDS = new Set(["role", "selection", "primary", "fallbacks"]);
const TARGET_FIELDS = new Set(["cli", "model"]);
const FORBIDDEN_FIELD = /(?:^|[_-])(token|api[_-]?key|secret|password|credential|prompt|repository[_-]?content)(?:$|[_-])/i;
const FORBIDDEN_VALUE = /(?:^(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)|(?:^|[-_.])(token|secret|password|credential|prompt|repository[-_]content)(?:$|[-_.])|^(?:src|test|docs|scripts)\/|(?:^|\/)package\.json$|\.(?:ts|tsx|js|jsx|json|md|ya?ml)$)/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_SCOPE_LENGTH = 160;
const MAX_FALLBACKS = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const field of Object.keys(record)) {
    if (allowed.has(field)) continue;
    if (FORBIDDEN_FIELD.test(field)) {
      throw new RoleAssignmentConfigError(
        "forbidden_field",
        `Forbidden role-assignment field at ${path}`,
      );
    }
    throw new RoleAssignmentConfigError(
      "unknown_field",
      `Unknown role-assignment field at ${path}`,
    );
  }
}

function parseBoundedIdentifier(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
    || !IDENTIFIER.test(value)
  ) {
    throw new RoleAssignmentConfigError(
      "invalid_target",
      `Invalid bounded role-assignment identifier at ${path}`,
    );
  }
  if (FORBIDDEN_VALUE.test(value)) {
    throw new RoleAssignmentConfigError(
      "forbidden_value",
      `Credential-shaped role-assignment value rejected at ${path}`,
    );
  }
  return value;
}

function parseTarget(value: unknown, path: string): RoleAssignmentTarget {
  if (!isRecord(value)) {
    throw new RoleAssignmentConfigError("invalid_target", `Expected target object at ${path}`);
  }
  validateFields(value, TARGET_FIELDS, path);
  const cli = parseBoundedIdentifier(value.cli, `${path}.cli`);
  if (!CLI_SET.has(cli)) {
    throw new RoleAssignmentConfigError("invalid_target", `Unknown role-assignment CLI at ${path}.cli`);
  }
  return {
    cli,
    model: parseBoundedIdentifier(value.model, `${path}.model`),
  };
}

function targetIdentity(target: RoleAssignmentTarget): string {
  return `${target.cli}\u0000${target.model}`;
}

function parseAssignment(value: unknown, index: number): RoleAssignment {
  const path = `assignments[${index}]`;
  if (!isRecord(value)) {
    throw new RoleAssignmentConfigError("invalid_shape", `Expected assignment object at ${path}`);
  }
  validateFields(value, ASSIGNMENT_FIELDS, path);

  if (typeof value.role !== "string" || !ROLE_SET.has(value.role)) {
    throw new RoleAssignmentConfigError(
      "invalid_role",
      `Invalid configurable role at ${path}.role`,
    );
  }
  if (typeof value.selection !== "string" || !SELECTION_SET.has(value.selection)) {
    throw new RoleAssignmentConfigError(
      "invalid_selection",
      `Invalid assignment selection for role ${value.role}`,
    );
  }

  const primary = parseTarget(value.primary, `${path}.primary`);
  if (!Array.isArray(value.fallbacks)) {
    throw new RoleAssignmentConfigError(
      "invalid_shape",
      `Expected fallback array for role ${value.role}`,
    );
  }
  if (value.fallbacks.length > MAX_FALLBACKS) {
    throw new RoleAssignmentConfigError(
      "too_many_fallbacks",
      `Too many fallbacks for role ${value.role}; maximum is ${MAX_FALLBACKS}`,
    );
  }
  const fallbacks = value.fallbacks.map((fallback, fallbackIndex) =>
    parseTarget(fallback, `${path}.fallbacks[${fallbackIndex}]`));

  const seenTargets = new Set([targetIdentity(primary)]);
  for (const fallback of fallbacks) {
    const identity = targetIdentity(fallback);
    if (seenTargets.has(identity)) {
      throw new RoleAssignmentConfigError(
        "duplicate_target",
        `Duplicate primary or fallback target for role ${value.role}`,
      );
    }
    seenTargets.add(identity);
  }

  return {
    role: value.role as AgentRoleId,
    selection: value.selection as RoleAssignmentSelection,
    primary,
    fallbacks,
  };
}

function parseScopeKey(value: string | undefined): string {
  const scopeKey = value?.trim() || "worker:default";
  if (
    scopeKey.length > MAX_SCOPE_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(scopeKey)
  ) {
    throw new RoleAssignmentConfigError("invalid_scope", "Invalid role-assignment scope");
  }
  return scopeKey;
}

function canonicalAssignments(assignments: readonly RoleAssignment[]): string {
  return JSON.stringify(assignments.map((assignment) => ({
    role: assignment.role,
    selection: assignment.selection,
    primary: {
      cli: assignment.primary.cli,
      model: assignment.primary.model,
    },
    fallbacks: assignment.fallbacks.map((fallback) => ({
      cli: fallback.cli,
      model: fallback.model,
    })),
  })));
}

export function parseRoleAssignmentConfig(
  raw: string,
  options: {
    scopeKey?: string;
    source?: RoleAssignmentSource;
  } = {},
): RoleAssignmentConfig {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new RoleAssignmentConfigError("invalid_json", "Invalid role-assignment JSON");
  }
  if (!Array.isArray(decoded)) {
    throw new RoleAssignmentConfigError("invalid_shape", "Role assignments must be a JSON array");
  }

  const seenRoles = new Set<AgentRoleId>();
  for (const [index, value] of decoded.entries()) {
    const path = `assignments[${index}]`;
    if (!isRecord(value)) {
      throw new RoleAssignmentConfigError("invalid_shape", `Expected assignment object at ${path}`);
    }
    validateFields(value, ASSIGNMENT_FIELDS, path);
    if (typeof value.role !== "string" || !ROLE_SET.has(value.role)) {
      throw new RoleAssignmentConfigError("invalid_role", `Invalid configurable role at ${path}.role`);
    }
    const role = value.role as AgentRoleId;
    if (seenRoles.has(role)) {
      throw new RoleAssignmentConfigError(
        "duplicate_role",
        `Duplicate role assignment: ${role}`,
      );
    }
    seenRoles.add(role);
  }
  const assignments = decoded.map(parseAssignment);
  for (const role of AGENT_ROLE_IDS) {
    if (!seenRoles.has(role)) {
      throw new RoleAssignmentConfigError("missing_role", `Missing role assignment: ${role}`);
    }
  }
  if (assignments.length !== AGENT_ROLE_IDS.length) {
    throw new RoleAssignmentConfigError(
      "invalid_shape",
      `Expected exactly ${AGENT_ROLE_IDS.length} role assignments`,
    );
  }

  const byRole = new Map(assignments.map((assignment) => [assignment.role, assignment]));
  const normalized = AGENT_ROLE_IDS.map((role) => byRole.get(role)!);
  const source = options.source ?? "environment";
  const scopeKey = parseScopeKey(options.scopeKey);
  const digest = createHash("sha256")
    .update(JSON.stringify({ scopeKey, source, assignments: JSON.parse(canonicalAssignments(normalized)) }))
    .digest("hex");

  return {
    scopeKey,
    source,
    status: "configured_dormant",
    idempotencyKey: `${source}:${digest}`,
    assignments: normalized,
  };
}

export function serializeRoleAssignments(assignments: readonly RoleAssignment[]): string {
  return canonicalAssignments(assignments);
}
