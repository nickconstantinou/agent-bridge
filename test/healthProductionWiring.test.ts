import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("health event production wiring", () => {
  it("routes raw scheduler reports through authenticated receipt, Run execution, and reconciliation", () => {
    const source = readFileSync(new URL("../src/index-health.ts", import.meta.url), "utf8");
    expect(source).toContain('from "./health/eventIngress.js"');
    expect(source).toContain("acceptHealthOpsEvent");
    expect(source).toContain("executeHealthOpsRun");
    expect(source).toContain("reconcileEventReceiptResult");
    expect(source).toContain("onRawReport: async (report)");
  });

  it("recovers durable event state before generic orphan reconciliation", () => {
    const source = readFileSync(new URL("../src/index-health.ts", import.meta.url), "utf8");
    const continuationRecovery = source.lastIndexOf("await engine.recoverContinuations();");
    const pendingReplay = source.lastIndexOf("resumeDurablePendingHealthEvents();");
    const orphanReconciliation = source.lastIndexOf("await bridgeDb.reconcileOrphanedRuns({");
    const startedReconciliation = source.lastIndexOf("reconcileDurableStartedHealthEvents();");

    expect(continuationRecovery).toBeGreaterThan(-1);
    expect(pendingReplay).toBeGreaterThan(continuationRecovery);
    expect(orphanReconciliation).toBeGreaterThan(pendingReplay);
    expect(startedReconciliation).toBeGreaterThan(orphanReconciliation);
  });

  it("uses persisted health status rather than process-local red-transition memory", () => {
    const source = readFileSync(new URL("../src/index-health.ts", import.meta.url), "utf8");
    expect(source).toContain("healthReportStore.getReport(report.pluginName)");
    expect(source).not.toContain("lastReportStatus");
    expect(source).toContain('listByStatuses(["received", "run_created"])');
  });
});
