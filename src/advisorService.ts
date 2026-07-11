/**
 * PURPOSE: Single trusted entry point for every advisor request origin.
 * INPUTS: Bridge-owned config, bots, db, and per-request trusted scope details.
 * OUTPUTS: AdvisorResult produced by the shared tool-free execution path.
 * NEIGHBORS: src/advisor.ts, src/advisorBroker.ts, src/engine.ts, src/index-worker.ts
 */

import { randomUUID } from "node:crypto";
import { executeAdvisorRequest } from "./advisor.js";
import type { AdvisorExecutionProfile } from "./advisorPolicy.js";
import type { AdvisorConfig, AdvisorOrigin, AdvisorRequest, AdvisorRequestMode, AdvisorResult } from "./advisorTypes.js";
import type { BridgeDb } from "./db.js";
import type { BotConfig, BotKind } from "./types.js";

type RunCli = (command: string, args: string[], cwd: string, options: Record<string, unknown>) => Promise<string>;

export interface TrustedAdvisorRequest {
  origin: AdvisorOrigin;
  scopeKey: string;
  turnKey?: string;
  taskKey?: string;
  mode: AdvisorRequestMode;
  task: string;
  activeProvider: string;
  activeModel: string | null;
  cwd: string;
  approved?: boolean;
  evidence?: AdvisorRequest["evidence"];
}

export class AdvisorService {
  // Every entry point uses tool_free: the advisor model can never execute tools.
  readonly executionProfile: AdvisorExecutionProfile = "tool_free";

  constructor(private readonly deps: {
    db: BridgeDb;
    config: AdvisorConfig;
    bots: Partial<Record<BotKind, Pick<BotConfig, "command" | "modelPreference">>>;
    runCli: RunCli;
  }) {}

  get config(): AdvisorConfig { return this.deps.config; }

  requestTrusted(request: TrustedAdvisorRequest): Promise<AdvisorResult> {
    return this.executeAdvisorRequest(request);
  }

  private executeAdvisorRequest(request: TrustedAdvisorRequest): Promise<AdvisorResult> {
    return executeAdvisorRequest({
      db: this.deps.db,
      config: this.deps.config,
      bots: this.deps.bots,
      runCli: this.deps.runCli,
      cwd: request.cwd,
      executionProfile: this.executionProfile,
      request: {
        requestId: randomUUID(),
        scopeKey: request.scopeKey,
        turnKey: request.turnKey,
        taskKey: request.taskKey,
        origin: request.origin,
        approved: request.approved,
        mode: request.mode,
        task: request.task,
        activeProvider: request.activeProvider,
        activeModel: request.activeModel,
        evidence: request.evidence,
      },
    });
  }
}
