/**
 * PURPOSE: CLI entry for runtime readiness diagnostics (npm run doctor).
 * NEIGHBORS: src/providers/doctor.ts
 */

import { runDoctor, formatDoctorReport } from "./providers/doctor.js";

const report = runDoctor();
console.log(formatDoctorReport(report));
process.exit(report.ok ? 0 : 1);
