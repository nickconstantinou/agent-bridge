import { execSync } from "node:child_process";
import https from "node:https";

const CHANGELOG_URL = "https://raw.githubusercontent.com/google-antigravity/antigravity-cli/refs/heads/main/CHANGELOG.md";

function getLocalVersion(): string | null {
  try {
    return execSync("agy --version", { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim();
  } catch (err) {
    console.error("Failed to check local agy version:", err);
    return null;
  }
}

function getRemoteLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(CHANGELOG_URL, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        // Parse version header from Markdown (e.g. "## 1.0.6")
        const match = data.match(/^##\s+([0-9]+\.[0-9]+\.[0-9]+)/m);
        resolve(match ? match[1] : null);
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function runSpike() {
  console.log("=== Running Antigravity Version Spike ===");
  
  const local = getLocalVersion();
  console.log(`Local version:  ${local || "Not found"}`);
  
  const remote = await getRemoteLatestVersion();
  console.log(`Remote version: ${remote || "Failed to fetch"}`);

  if (!local || !remote) {
    console.log("❌ Could not perform update check due to missing local or remote version.");
    return;
  }

  if (local === remote) {
    console.log(`✅ agy is up to date (current: ${local})`);
  } else {
    console.log(`⚠️ agy update available: ${local} -> ${remote}`);
  }
}

runSpike();
