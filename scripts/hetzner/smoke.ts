import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["tsx", "scripts/infra.ts", "smoke", "--provider", "hetzner"], {
  stdio: "inherit",
  cwd: process.cwd(),
});

process.exit(result.status ?? 1);
