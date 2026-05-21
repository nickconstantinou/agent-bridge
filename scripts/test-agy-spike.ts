import { runCli, parseCliResult, buildCliInvocation } from "../src/cli.js";

async function main() {
  const bot = "antigravity";
  const prompt = "say hello in exactly one word";
  const command = "agy";

  console.log("1. Building CLI invocation...");
  const invocation = buildCliInvocation({
    bot,
    prompt,
    sessionId: null,
    command,
    executionMode: "trusted",
  });
  console.log("Command:", invocation.command);
  console.log("Args:", invocation.args);

  console.log("\n2. Executing CLI runCli...");
  try {
    const rawStdout = await runCli(
      invocation.command,
      invocation.args,
      process.cwd(),
      { timeoutMs: 120000 }
    );

    console.log("\n=== RAW STDOUT ===");
    console.log(rawStdout);
    console.log("===================\n");

    console.log("3. Parsing CLI result...");
    const parsed = parseCliResult({
      bot,
      stdout: rawStdout,
    });

    console.log("\n=== PARSED TEXT ===");
    console.log(parsed.text);
    console.log("===================\n");
  } catch (error) {
    console.error("Execution failed:", error);
  }
}

main();
