#!/usr/bin/env node
import { ApplianceDb } from "../src/appliance/state.js";
import { runInstall } from "../src/appliance/install.js";
import { appInit } from "../src/appliance/app-init.js";
import { deployApp } from "../src/appliance/deploy.js";
import { rollbackApp } from "../src/appliance/rollback.js";
import { appStatus, appLogs, appRestart } from "../src/appliance/app-ops.js";

const DEFAULT_DB_PATH = process.env.APPLIANCE_STATE_DB ?? "/var/lib/agent-bridge/state.db";

export async function runCli(argv: string[]): Promise<void> {
  const db = new ApplianceDb(DEFAULT_DB_PATH);

  try {
    const [cmd, ...rest] = argv;

    if (cmd === "install") {
      const dryRun = rest.includes("--dry-run");
      const result = await runInstall({ dryRun });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (cmd === "app") {
      const [subCmd, ...subRest] = rest;

      if (subCmd === "init") {
        const [name, ...initRest] = subRest;
        if (!name) {
          console.error("Usage: appliance app init <name> --repo <url> --domain <domain> [--branch <branch>]");
          process.exit(1);
          return;
        }
        const repo = flagValue(initRest, "--repo");
        const domain = flagValue(initRest, "--domain");
        const branch = flagValue(initRest, "--branch");
        if (!repo || !domain) {
          console.error("app init requires --repo and --domain");
          process.exit(1);
          return;
        }
        const manifest = await appInit(db, { name, repo, domain, ...(branch ? { branch } : {}) });
        console.log(JSON.stringify(manifest, null, 2));
        return;
      }

      if (subCmd === "deploy") {
        const [appName] = subRest;
        if (!appName) { console.error("Usage: appliance app deploy <name>"); process.exit(1); return; }
        const result = await deployApp(db, appName);
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (subCmd === "rollback") {
        const [appName] = subRest;
        if (!appName) { console.error("Usage: appliance app rollback <name>"); process.exit(1); return; }
        const result = await rollbackApp(db, appName);
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (subCmd === "status") {
        const [appName] = subRest;
        if (!appName) { console.error("Usage: appliance app status <name>"); process.exit(1); return; }
        const result = await appStatus(db, appName);
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (subCmd === "logs") {
        const [appName, ...logsRest] = subRest;
        if (!appName) { console.error("Usage: appliance app logs <name> [--lines <n>]"); process.exit(1); return; }
        const linesStr = flagValue(logsRest, "--lines");
        const lines = linesStr !== undefined ? parseInt(linesStr, 10) : 100;
        const output = await appLogs(db, appName, lines);
        console.log(output);
        return;
      }

      if (subCmd === "restart") {
        const [appName] = subRest;
        if (!appName) { console.error("Usage: appliance app restart <name>"); process.exit(1); return; }
        await appRestart(db, appName);
        console.log(`App '${appName}' restarted.`);
        return;
      }

      if (subCmd === "list") {
        const apps = db.listApps();
        if (apps.length === 0) {
          console.log("No apps registered.");
        } else {
          console.log(`${"NAME".padEnd(20)} ${"PORT".padEnd(6)} ${"STATUS".padEnd(16)} COMMIT`);
          for (const app of apps) {
            const name = app.name.padEnd(20);
            const port = String(app.port).padEnd(6);
            const status = (app.last_deploy_status ?? "-").padEnd(16);
            const commit = app.current_commit ?? "-";
            console.log(`${name} ${port} ${status} ${commit}`);
          }
        }
        return;
      }

      console.error(`Unknown app subcommand: ${subCmd ?? "(none)"}`);
      printUsage();
      process.exit(1);
      return;
    }

    console.error(`Unknown command: ${cmd ?? "(none)"}`);
    printUsage();
    process.exit(1);
  } finally {
    db.close();
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function printUsage(): void {
  console.error(`
Usage:
  appliance install [--dry-run]
  appliance app init <name> --repo <url> --domain <domain> [--branch <branch>]
  appliance app deploy <name>
  appliance app rollback <name>
  appliance app status <name>
  appliance app logs <name> [--lines <n>]
  appliance app restart <name>
  appliance app list
`.trim());
}

async function main(): Promise<void> {
  await runCli(process.argv.slice(2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
