import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const hasProvider = args.includes("--provider");
const forwarded = args.length === 0 || hasProvider ? args : [...args, "--provider", "hetzner"];

const result = spawnSync("npx", ["tsx", "scripts/infra.ts", ...forwarded], {
  stdio: "inherit",
  cwd: process.cwd(),
});

process.exit(result.status ?? 1);
