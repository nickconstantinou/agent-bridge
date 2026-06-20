#!/usr/bin/env node
import { renderAgentBridgeContext } from "../src/contextCommand.js";

try {
  process.stdout.write(renderAgentBridgeContext(process.argv.slice(2)) + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-bridge-context: ${message}\n`);
  process.exit(1);
}
