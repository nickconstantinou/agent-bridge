import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("restore agent-bridge sudo helper", () => {
  it("restores only the bridge-specific sudoers entries", () => {
    const helper = readFileSync(new URL("../scripts/restore-agent-bridge-sudo.sh", import.meta.url), "utf8");

    expect(helper).toContain("install -D -m 0750 -o root -g root \"${repo_dir}/scripts/restart-agent-bridge.sh\" /usr/local/sbin/restart-agent-bridge");
    expect(helper).toContain("install -D -m 0750 -o root -g root \"${repo_dir}/scripts/rollout-agent-bridge.sh\" /usr/local/sbin/rollout-agent-bridge");
    expect(helper).toContain("install -D -m 0750 -o root -g root \"${repo_dir}/scripts/rollout-restore.py\" /usr/local/libexec/agent-bridge-rollout-restore");
    expect(helper).toContain("content-crawler ALL=(root) NOPASSWD: /usr/local/sbin/restart-agent-bridge");
    expect(helper).toContain("content-crawler ALL=(root) NOPASSWD: /usr/local/sbin/rollout-agent-bridge");
    expect(helper).toContain("visudo -cf /etc/sudoers.d/agent-bridge-restart");
    expect(helper).toContain("visudo -cf /etc/sudoers.d/agent-bridge-rollout");
    expect(helper).not.toContain("NOPASSWD: ALL");
    expect(helper).not.toContain("systemctl restart");
  });
});
