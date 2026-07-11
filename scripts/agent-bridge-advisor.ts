#!/usr/bin/env node
import { runAgentAdvisorCommand } from "../src/advisorCommand.js";

try {
  process.stdout.write(await runAgentAdvisorCommand(process.argv.slice(2)) + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-bridge-advisor: ${message}\n`);
  process.exit(1);
}
