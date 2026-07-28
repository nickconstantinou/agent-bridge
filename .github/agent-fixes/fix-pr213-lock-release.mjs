import { readFileSync, writeFileSync } from "node:fs";

const path = "scripts/relocate-health-db.ts";
let source = readFileSync(path, "utf8");

const start = "  if (existsSync(completionFile)) {";
const end = "  // Check if sentinel exists, handle recovery after authorization validation";

const startIndex = source.indexOf(start);
if (startIndex < 0) throw new Error("Missing completion-record startup block");
if (source.indexOf(start, startIndex + start.length) >= 0) throw new Error("Ambiguous completion-record startup block");
const endIndex = source.indexOf(end, startIndex);
if (endIndex < 0) throw new Error("Missing terminal-evidence block end");

source =
  source.slice(0, startIndex) +
  "  try {\n" +
  source.slice(startIndex, endIndex) +
  "  } catch (err) {\n    await killLockProcess(lockProcess);\n    throw err;\n  }\n\n" +
  source.slice(endIndex);

writeFileSync(path, source);
