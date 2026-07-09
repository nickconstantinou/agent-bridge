/**
 * PURPOSE: Pure helpers for storing worker execution-contract metadata inside work_item_plans.quality_json.
 * NEIGHBORS: src/workerPromptContracts.ts, src/handlers/implementationPlan.ts, src/db.ts
 */

import type { WorkerExecutionContract } from "./workerPromptContracts.js";

export interface WorkerPlanQualityMetadata {
  valid?: boolean;
  missing?: string[];
  execution_contract?: WorkerExecutionContract;
  [key: string]: unknown;
}

export function parseWorkerPlanQualityMetadata(raw: string | object | null | undefined): WorkerPlanQualityMetadata {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as WorkerPlanQualityMetadata;
  if (typeof raw !== "string" || raw.trim() === "") return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed != null && !Array.isArray(parsed)
      ? parsed as WorkerPlanQualityMetadata
      : {};
  } catch {
    return {};
  }
}

export function withExecutionContractMetadata(
  quality: string | object | null | undefined,
  executionContract: WorkerExecutionContract,
): WorkerPlanQualityMetadata {
  return {
    ...parseWorkerPlanQualityMetadata(quality),
    execution_contract: executionContract,
  };
}

export function getExecutionContractFromMetadata(
  quality: string | object | null | undefined,
): WorkerExecutionContract | null {
  const metadata = parseWorkerPlanQualityMetadata(quality);
  const value = metadata.execution_contract;
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  return value;
}
