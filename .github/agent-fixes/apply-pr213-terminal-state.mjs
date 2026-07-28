import { readFileSync, writeFileSync } from "node:fs";

const sourcePath = "scripts/relocate-health-db.ts";
const testPath = "test/healthDbRelocation.test.ts";

function replaceOnce(text, needle, replacement, label) {
  const first = text.indexOf(needle);
  if (first < 0) throw new Error(`Missing ${label}`);
  if (text.indexOf(needle, first + needle.length) >= 0) throw new Error(`Ambiguous ${label}`);
  return text.slice(0, first) + replacement + text.slice(first + needle.length);
}

function replaceBetween(text, startMarker, endMarker, replacement, label) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing start marker for ${label}`);
  const end = text.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Missing end marker for ${label}`);
  return text.slice(0, start) + replacement + text.slice(end);
}

let source = readFileSync(sourcePath, "utf8");

source = replaceOnce(
  source,
  `  tempBackupPath: string;\n  steps: {`,
  `  tempBackupPath: string;\n  terminalOutcome?: "relocation-success" | "original-state-restored";\n  steps: {`,
  "LedgerData terminalOutcome field",
);

source = replaceOnce(
  source,
  `  const sentinelFile = join(configDir, ".health-relocation-in-progress");\n  const ledgerFile = join(configDir, ".health-relocation-ledger.json");`,
  `  const sentinelFile = join(configDir, ".health-relocation-in-progress");\n  const ledgerFile = join(configDir, ".health-relocation-ledger.json");\n  const completionFile = join(configDir, ".health-relocation-complete.json");`,
  "completion file declaration",
);

source = replaceOnce(
  source,
  `  if (rollbackSuccess) {\n    checkLock();\n\n    // Durable evidence deletion via rename-then-fsync-then-unlink:`,
  `  if (rollbackSuccess) {\n    checkLock();\n\n    ledger.terminalOutcome = "original-state-restored";\n    safeWriteFile(ledgerFile, JSON.stringify(ledger, null, 2), 0o600);\n\n    // Durable evidence deletion via rename-then-fsync-then-unlink:`,
  "recovery terminal outcome",
);

const startupBlock = `  // Reconcile durable terminal evidence before accepting sentinel absence.\n  // A permanent completion record makes successful relocation idempotent; rollback/recovery\n  // tombstones are retained until a new normal ledger exists to protect any cleanup retry.\n  type RemovingPair = { sentinel: string; ledger: string };\n  let pendingRestoredEvidence: RemovingPair | null = null;\n\n  const validateEvidenceFile = (filePath: string, label: string) => {\n    const lstat = lstatSync(filePath);\n    if (lstat.isSymbolicLink()) {\n      throw new Error(\`Relocation failed closed: \${label} \${filePath} is a symbolic link. Manual recovery required.\`);\n    }\n    const stat = statSync(filePath);\n    const mode = stat.mode & 0o777;\n    if (mode !== 0o600) {\n      throw new Error(\`Relocation failed closed: \${label} \${filePath} has mode \${mode.toString(8)} (expected 0600). Manual recovery required.\`);\n    }\n    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {\n      throw new Error(\`Relocation failed closed: \${label} \${filePath} is not owned by the current process user. Manual recovery required.\`);\n    }\n  };\n\n  const readTerminalLedger = (filePath: string, label: string): LedgerData => {\n    validateEvidenceFile(filePath, label);\n    let ledger: LedgerData;\n    try {\n      ledger = JSON.parse(readFileSync(filePath, "utf8"));\n    } catch {\n      throw new Error(\`Relocation failed closed: unable to parse \${label} ledger \${filePath}. Manual recovery required.\`);\n    }\n    if (\n      !ledger ||\n      typeof ledger !== "object" ||\n      typeof ledger.expectedCommit !== "string" ||\n      typeof ledger.expectedInstallationId !== "string" ||\n      typeof ledger.originalEnvFileContent !== "string" ||\n      typeof ledger.originalRolloutConfigContent !== "string" ||\n      typeof ledger.resolvedOldPath !== "string" ||\n      typeof ledger.resolvedNewPath !== "string" ||\n      typeof ledger.resolvedEnvFilePath !== "string" ||\n      typeof ledger.resolvedRolloutConfigPath !== "string" ||\n      typeof ledger.serviceName !== "string" ||\n      !Array.isArray(ledger.steps)\n    ) {\n      throw new Error(\`Relocation failed closed: \${label} ledger schema validation failed. Manual recovery required.\`);\n    }\n    if (finalExpectedCommit && ledger.expectedCommit !== finalExpectedCommit) {\n      throw new Error(\`Relocation failed closed: \${label} expected commit mismatch (expected \${finalExpectedCommit}, got \${ledger.expectedCommit}). Manual recovery required.\`);\n    }\n    if (expectedInstallationId && ledger.expectedInstallationId !== expectedInstallationId) {\n      throw new Error(\`Relocation failed closed: \${label} installation ID mismatch (expected \${expectedInstallationId}, got \${ledger.expectedInstallationId}). Manual recovery required.\`);\n    }\n    if (\n      ledger.resolvedOldPath !== resolvedOldPath ||\n      ledger.resolvedNewPath !== resolvedNewPath ||\n      ledger.resolvedEnvFilePath !== resolvedEnvFilePath ||\n      ledger.resolvedRolloutConfigPath !== resolvedRolloutConfigPath\n    ) {\n      throw new Error(\`Relocation failed closed: \${label} path identity mismatch. Manual recovery required.\`);\n    }\n    if (ledger.serviceName !== serviceName) {\n      throw new Error(\`Relocation failed closed: \${label} service name mismatch. Manual recovery required.\`);\n    }\n    return ledger;\n  };\n\n  const validateTerminalState = (ledger: LedgerData, label: string) => {\n    const envContent = existsSync(resolvedEnvFilePath) ? readFileSync(resolvedEnvFilePath, "utf8") : null;\n    const rolloutContent = existsSync(resolvedRolloutConfigPath) ? readFileSync(resolvedRolloutConfigPath, "utf8") : null;\n    const staleBackup = resolvedOldPath + ".stale-backup";\n\n    if (ledger.terminalOutcome === "relocation-success") {\n      const successState =\n        existsSync(resolvedNewPath) &&\n        !existsSync(resolvedOldPath) &&\n        existsSync(staleBackup) &&\n        envContent !== null && envContent.includes(\`HEALTH_DB_PATH=\${newPath}\`) &&\n        rolloutContent !== null && rolloutContent.includes(\`database=\${newPath}\`);\n      if (!successState) {\n        throw new Error(\`Relocation failed closed: \${label} declares relocation-success but live database/configuration state does not match. Manual recovery required.\`);\n      }\n      return;\n    }\n\n    if (ledger.terminalOutcome === "original-state-restored") {\n      const restoredState =\n        existsSync(resolvedOldPath) &&\n        !existsSync(resolvedNewPath) &&\n        !existsSync(staleBackup) &&\n        envContent === ledger.originalEnvFileContent &&\n        rolloutContent === ledger.originalRolloutConfigContent;\n      if (!restoredState) {\n        throw new Error(\`Relocation failed closed: \${label} declares original-state-restored but live database/configuration state does not match. Manual recovery required.\`);\n      }\n      return;\n    }\n\n    throw new Error(\`Relocation failed closed: \${label} has no recognised terminalOutcome. Manual recovery required.\`);\n  };\n\n  const cleanupEvidence = (paths: string[], label: string) => {\n    try {\n      for (const path of paths) rmSync(path, { force: true });\n      const dirFd = openSync(configDir, "r");\n      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }\n    } catch (err: any) {\n      console.error(\`[relocate-health-db] Deferred \${label} cleanup: \${err.message}\`);\n    }\n  };\n\n  if (existsSync(completionFile)) {\n    const completedLedger = readTerminalLedger(completionFile, "completion record");\n    if (completedLedger.terminalOutcome !== "relocation-success") {\n      throw new Error("Relocation failed closed: completion record is not marked relocation-success. Manual recovery required.");\n    }\n    validateTerminalState(completedLedger, "completion record");\n    const residualFiles = existsSync(configDir)\n      ? readdirSync(configDir)\n          .filter((file) =>\n            file === basename(sentinelFile) ||\n            file === basename(ledgerFile) ||\n            file.startsWith(basename(sentinelFile) + ".removing-") ||\n            file.startsWith(basename(ledgerFile) + ".removing-")\n          )\n          .map((file) => join(configDir, file))\n      : [];\n    cleanupEvidence(residualFiles, "completed relocation evidence");\n    await killLockProcess(lockProcess);\n    console.log("[relocate-health-db] Relocation was already completed successfully; no new migration was started.");\n    return;\n  }\n\n  const files = existsSync(configDir) ? readdirSync(configDir) : [];\n  const sentinelPrefix = basename(sentinelFile) + ".removing-";\n  const ledgerPrefix = basename(ledgerFile) + ".removing-";\n  const sentinelRemovingFiles = files.filter((file) => file.startsWith(sentinelPrefix));\n  const ledgerRemovingFiles = files.filter((file) => file.startsWith(ledgerPrefix));\n  const suffixes = new Set<string>([\n    ...sentinelRemovingFiles.map((file) => file.slice(sentinelPrefix.length)),\n    ...ledgerRemovingFiles.map((file) => file.slice(ledgerPrefix.length)),\n  ]);\n\n  if (suffixes.size > 1) {\n    throw new Error("Relocation failed closed: multiple .removing-* evidence pairs were found. Manual recovery required.");\n  }\n\n  if (suffixes.size === 1) {\n    const suffix = [...suffixes][0];\n    const pair: RemovingPair = {\n      sentinel: join(configDir, sentinelPrefix + suffix),\n      ledger: join(configDir, ledgerPrefix + suffix),\n    };\n    if (!existsSync(pair.sentinel) || !existsSync(pair.ledger)) {\n      throw new Error("Relocation failed closed: found incomplete or orphaned .removing-* evidence files. Manual recovery required.");\n    }\n    validateEvidenceFile(pair.sentinel, ".removing-* sentinel");\n    const terminalLedger = readTerminalLedger(pair.ledger, ".removing-* evidence");\n    validateTerminalState(terminalLedger, ".removing-* evidence");\n\n    if (terminalLedger.terminalOutcome === "relocation-success") {\n      safeWriteFile(completionFile, JSON.stringify(terminalLedger, null, 2), 0o600);\n      cleanupEvidence([pair.sentinel, pair.ledger], "successful relocation tombstone");\n      await killLockProcess(lockProcess);\n      console.log("[relocate-health-db] Recovered a completed relocation from durable tombstone evidence; no new migration was started.");\n      return;\n    }\n\n    pendingRestoredEvidence = pair;\n    console.log("[relocate-health-db] Validated restored-state tombstone evidence; a fresh migration may proceed.");\n  }\n\n`;

source = replaceBetween(
  source,
  "  // Check for leftover/incomplete .removing-* evidence from a previous run before accepting sentinel absence",
  "  // Check if sentinel exists, handle recovery after authorization validation",
  startupBlock,
  "startup terminal evidence reconciliation",
);

source = replaceOnce(
  source,
  `  const hasSentinel = existsSync(sentinelFile);\n  if (hasSentinel) {`,
  `  const hasSentinel = existsSync(sentinelFile);\n  if (hasSentinel && pendingRestoredEvidence) {\n    cleanupEvidence([pendingRestoredEvidence.sentinel, pendingRestoredEvidence.ledger], "restored-state tombstone protected by normal evidence");\n    pendingRestoredEvidence = null;\n  }\n  if (hasSentinel) {`,
  "normal sentinel with pending restored evidence",
);

source = replaceOnce(
  source,
  `  writeLedger();\n\n  const rollback = async () => {`,
  `  writeLedger();\n  if (pendingRestoredEvidence) {\n    cleanupEvidence([pendingRestoredEvidence.sentinel, pendingRestoredEvidence.ledger], "restored-state tombstone protected by new ledger");\n    pendingRestoredEvidence = null;\n  }\n\n  const rollback = async () => {`,
  "deferred restored evidence cleanup",
);

source = replaceOnce(
  source,
  `    if (rollbackSuccess) {\n      checkLock();\n\n      // Durable evidence deletion via rename-then-fsync-then-unlink:`,
  `    if (rollbackSuccess) {\n      checkLock();\n\n      const rollbackTerminalLedger: LedgerData = existsSync(ledgerFile)\n        ? JSON.parse(readFileSync(ledgerFile, "utf8"))\n        : ledgerData;\n      rollbackTerminalLedger.terminalOutcome = "original-state-restored";\n      safeWriteFile(ledgerFile, JSON.stringify(rollbackTerminalLedger, null, 2), 0o600);\n\n      // Durable evidence deletion via rename-then-fsync-then-unlink:`,
  "inline rollback terminal outcome",
);

const oldSuccessCleanup = `    // Relocation succeeded completely: durable evidence removal via rename-then-fsync-then-unlink.\n    checkLock();\n    const suffix = randomBytes(4).toString("hex");\n    const successLedgerRemoving = ledgerFile + \`.removing-\${suffix}\`;\n    const successSentinelRemoving = sentinelFile + \`.removing-\${suffix}\`;\n    renameSync(ledgerFile, successLedgerRemoving);\n    renameSync(sentinelFile, successSentinelRemoving);\n    const successEvidenceDir = dirname(ledgerFile);\n    const successDirFd = openSync(successEvidenceDir, "r");\n    try { fsyncSync(successDirFd); } finally { closeSync(successDirFd); }\n    try { rmSync(successLedgerRemoving, { force: true }); } catch { /* best-effort */ }\n    try { rmSync(successSentinelRemoving, { force: true }); } catch { /* best-effort */ }\n    const successDirFd2 = openSync(successEvidenceDir, "r");\n    try { fsyncSync(successDirFd2); } catch { /* best-effort */ } finally { try { closeSync(successDirFd2); } catch { /* ignore */ } }\n    await killLockProcess(lockProcess);\n    console.log("[relocate-health-db] Health database relocation completed successfully!");`;

const newSuccessCleanup = `    // Relocation succeeded completely. Persist a permanent, identity-bound completion\n    // record before attempting best-effort removal of transient ledger/sentinel evidence.\n    checkLock();\n    ledgerData.terminalOutcome = "relocation-success";\n    writeLedger();\n    safeWriteFile(completionFile, JSON.stringify(ledgerData, null, 2), 0o600);\n\n    try {\n      const suffix = randomBytes(4).toString("hex");\n      const successLedgerRemoving = ledgerFile + \`.removing-\${suffix}\`;\n      const successSentinelRemoving = sentinelFile + \`.removing-\${suffix}\`;\n      renameSync(ledgerFile, successLedgerRemoving);\n      renameSync(sentinelFile, successSentinelRemoving);\n      const successDirFd = openSync(configDir, "r");\n      try { fsyncSync(successDirFd); } finally { closeSync(successDirFd); }\n      cleanupEvidence([successLedgerRemoving, successSentinelRemoving], "successful relocation transient evidence");\n    } catch (err: any) {\n      console.error(\`[relocate-health-db] Completion is durable; transient evidence cleanup will be retried: \${err.message}\`);\n    }\n\n    await killLockProcess(lockProcess);\n    console.log("[relocate-health-db] Health database relocation completed successfully!");`;

source = replaceOnce(source, oldSuccessCleanup, newSuccessCleanup, "successful relocation completion record");

writeFileSync(sourcePath, source);

let tests = readFileSync(testPath, "utf8");
tests = replaceOnce(
  tests,
  `  beforeEach(() => {\n    mockFsyncFail = false;`,
  `  beforeEach(() => {\n    mockFsyncFail = false;\n    triggerFsyncFailOnRename = false;`,
  "test fsync trigger reset",
);
const testInsertion = `\n\n  it("does not start a second migration after successful-cleanup fsync failure", async () => {\n    seedDb(resolvedOldPath);\n    triggerFsyncFailOnRename = true;\n\n    await expect(relocateHealthDb({\n      oldPath,\n      newPath,\n      envFilePath,\n      rolloutConfigPath,\n      serviceName,\n      expectedInstallationId: "test-install-id-123",\n    })).resolves.toBeUndefined();\n\n    triggerFsyncFailOnRename = false;\n    mockFsyncFail = false;\n\n    const completionFile = join(testRoot, "etc/agent-bridge/.health-relocation-complete.json");\n    expect(existsSync(completionFile)).toBe(true);\n    expect(existsSync(resolvedNewPath)).toBe(true);\n    expect(existsSync(resolvedOldPath)).toBe(false);\n    expect(existsSync(resolvedOldPath + ".stale-backup")).toBe(true);\n\n    await expect(relocateHealthDb({\n      oldPath,\n      newPath,\n      envFilePath,\n      rolloutConfigPath,\n      serviceName,\n      expectedInstallationId: "test-install-id-123",\n    })).resolves.toBeUndefined();\n\n    expect(existsSync(resolvedNewPath)).toBe(true);\n    expect(existsSync(resolvedOldPath)).toBe(false);\n    expect(existsSync(resolvedOldPath + ".stale-backup")).toBe(true);\n  });\n\n  it("fails closed when a success completion record contradicts live state", async () => {\n    seedDb(resolvedOldPath);\n    const completionFile = join(testRoot, "etc/agent-bridge/.health-relocation-complete.json");\n    writeFileSync(completionFile, JSON.stringify({\n      timestamp: new Date().toISOString(),\n      expectedCommit: "",\n      expectedInstallationId: "test-install-id-123",\n      originalEnvFileContent: readFileSync(resolvedEnvFilePath, "utf8"),\n      originalRolloutConfigContent: readFileSync(resolvedRolloutConfigPath, "utf8"),\n      serviceWasRunning: false,\n      serviceName,\n      resolvedOldPath,\n      resolvedNewPath,\n      resolvedEnvFilePath,\n      resolvedRolloutConfigPath,\n      tempBackupPath: join(testRoot, "runtime/health/.relocate-backup-test"),\n      terminalOutcome: "relocation-success",\n      steps: [],\n    }, null, 2), { mode: 0o600 });\n\n    await expect(relocateHealthDb({\n      oldPath,\n      newPath,\n      envFilePath,\n      rolloutConfigPath,\n      serviceName,\n      expectedInstallationId: "test-install-id-123",\n    })).rejects.toThrow(/declares relocation-success but live database\\/configuration state does not match/);\n\n    expect(existsSync(resolvedOldPath)).toBe(true);\n    expect(existsSync(resolvedNewPath)).toBe(false);\n    expect(existsSync(join(testRoot, "etc/agent-bridge/.health-relocation-in-progress"))).toBe(false);\n  });`;

const finalClose = "\n});\n";
const closeIndex = tests.lastIndexOf(finalClose);
if (closeIndex < 0) throw new Error("Unable to locate outer test describe close");
tests = tests.slice(0, closeIndex) + testInsertion + tests.slice(closeIndex);
writeFileSync(testPath, tests);
