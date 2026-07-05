import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliKind } from "./interactiveBot.js";

export interface InteractiveCliAuthPaths {
  codex: string;
  claude: string;
  antigravity: string;
}

export interface AuthenticatedCliOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
}

export function resolveInteractiveCliAuthPaths(homeDir: string = homedir()): InteractiveCliAuthPaths {
  return {
    codex: join(homeDir, ".codex", "auth.json"),
    claude: join(homeDir, ".claude", ".credentials.json"),
    antigravity: join(homeDir, ".gemini", "oauth_creds.json"),
  };
}

export function getAuthenticatedCliKinds(options: AuthenticatedCliOptions = {}): Set<CliKind> {
  const home = options.homeDir ?? homedir();
  const exists = options.exists ?? existsSync;
  const paths = resolveInteractiveCliAuthPaths(home);
  const authenticated = new Set<CliKind>(["kimchi"]);

  if (exists(paths.codex)) authenticated.add("codex");
  if (exists(paths.claude)) authenticated.add("claude");
  if (exists(paths.antigravity)) authenticated.add("antigravity");

  return authenticated;
}
