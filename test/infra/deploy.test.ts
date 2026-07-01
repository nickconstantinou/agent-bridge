import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import {
  parseYaml,
  validateManifest,
  redactSecrets,
  deployApp,
  rollbackApp,
  getAppLogs,
} from "../../src/infra/deploy.js";
import type { WorkspaceState } from "../../src/infra/state.js";

describe("Application Deploy Engine", () => {
  let tmpDir: string;
  let appsDir: string;
  let etcDir: string;
  let appSourceDir: string;
  let mockState: WorkspaceState;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "ab-deploy-test-"));
    appsDir = path.join(tmpDir, "apps");
    etcDir = path.join(tmpDir, "etc");
    appSourceDir = path.join(tmpDir, "src-code");

    fs.mkdirSync(appSourceDir, { recursive: true });
    fs.writeFileSync(path.join(appSourceDir, "index.js"), "console.log('hello world');");

    mockState = {
      workspaceId: "ws-123",
      customerId: "cust-456",
      repo: "owner/repo",
      branch: "main",
      domain: "app.example.com",
      status: "ready",
      provider: "aruba",
      serverId: "server-1",
      serverName: "ab-ws-123",
      firewallId: "sg-1",
      sshKeyId: "key-1",
      ip: "198.51.100.10",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: {},
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("YAML Parser and Validator", () => {
    it("parses valid yaml and validates it", () => {
      const yaml = `
app: my-app
port: 3000
health: /health
env:
  DATABASE_URL: "sqlite:///apps/my-app/shared/app.sqlite"
  API_KEY: secret-123
`;
      const parsed = parseYaml(yaml);
      expect(parsed.app).toBe("my-app");
      expect(parsed.port).toBe(3000);
      expect(parsed.health).toBe("/health");
      expect(parsed.env).toEqual({
        DATABASE_URL: "sqlite:///apps/my-app/shared/app.sqlite",
        API_KEY: "secret-123",
      });

      const validated = validateManifest(parsed);
      expect(validated.app).toBe("my-app");
      expect(validated.startCommand).toBe("node index.js");
    });

    it("rejects invalid app names", () => {
      const manifest = {
        app: "my/app..name",
        port: 3000,
        health: "/health",
      };
      expect(() => validateManifest(manifest)).toThrow("Invalid 'app' name");
    });

    it("rejects invalid ports", () => {
      const manifest = {
        app: "my-app",
        port: 99999,
        health: "/health",
      };
      expect(() => validateManifest(manifest)).toThrow("Invalid 'port'");
    });

    it("rejects unsafe health paths", () => {
      const manifest = {
        app: "my-app",
        port: 3000,
        health: "/health/../../etc",
      };
      expect(() => validateManifest(manifest)).toThrow("Invalid 'health' path");
    });

    it("rejects command injection patterns in environment variables", () => {
      const manifest = {
        app: "my-app",
        port: 3000,
        health: "/health",
        env: {
          SAFE: "value",
          UNSAFE: "val; rm -rf /",
        },
      };
      expect(() => validateManifest(manifest)).toThrow("Unsafe character detected");
    });
  });

  describe("Secret Redaction", () => {
    it("redacts env secrets from logs", () => {
      const manifest = {
        app: "my-app",
        port: 3000,
        health: "/health",
        env: {
          DB_PASSWORD: "super-secret-password-123",
          API_KEY: "secret-api-key",
          SAFE: "safe-value",
        },
      };
      const text = "Connecting with DB_PASSWORD=super-secret-password-123 and API_KEY=secret-api-key on SAFE=safe-value";
      const redacted = redactSecrets(text, manifest);
      expect(redacted).not.toContain("super-secret-password-123");
      expect(redacted).not.toContain("secret-api-key");
      expect(redacted).toContain("[REDACTED]");
      expect(redacted).toContain("SAFE=safe-value");
    });
  });

  describe("Deployment Execution", () => {
    it("successfully deploys app, configures systemd and caddy, and passes health checks", async () => {
      const yaml = `
app: my-app
port: 8080
health: /health
env:
  API_KEY: secret-key
`;

      const executedCommands: string[] = [];
      const execMock = async (cmd: string) => {
        executedCommands.push(cmd);
        return { stdout: "success", stderr: "" };
      };

      let healthProbeUrl = "";
      const probeMock = async (url: string) => {
        healthProbeUrl = url;
        return true;
      };

      const result = await deployApp(mockState, yaml, appSourceDir, {
        appsDir,
        etcDir,
        execCommand: execMock,
        fetchProbe: probeMock,
      });

      expect(result.success).toBe(true);
      expect(result.releaseTag).toBeDefined();
      expect(result.logs).toContain("Deployment completed successfully");
      expect(result.logs).not.toContain("secret-key");

      // Check folders are created
      const appDir = path.join(appsDir, "my-app");
      const currentLink = path.join(appDir, "current");
      expect(fs.existsSync(currentLink)).toBe(true);
      expect(fs.readlinkSync(currentLink)).toContain(result.releaseTag);

      // Check SQLite database
      const dbPath = path.join(appDir, "shared", "app.sqlite");
      expect(fs.existsSync(dbPath)).toBe(true);
      expect(fs.existsSync(path.join(currentLink, "app.sqlite"))).toBe(true);

      // Check systemd unit file
      const serviceFile = path.join(etcDir, "systemd", "system", "my-app.service");
      expect(fs.existsSync(serviceFile)).toBe(true);
      const serviceContent = fs.readFileSync(serviceFile, "utf8");
      expect(serviceContent).toContain("WorkingDirectory=" + currentLink);
      expect(serviceContent).toContain("Environment=\"PORT=8080\"");
      expect(serviceContent).toContain("Environment=\"API_KEY=secret-key\"");

      // Check Caddy fragment
      const caddyFile = path.join(etcDir, "caddy", "conf.d", "my-app.caddy");
      expect(fs.existsSync(caddyFile)).toBe(true);
      const caddyContent = fs.readFileSync(caddyFile, "utf8");
      expect(caddyContent).toContain("app.example.com {");
      expect(caddyContent).toContain("reverse_proxy localhost:8080");

      // Verify commands and health URL
      expect(executedCommands).toContain("systemctl daemon-reload");
      expect(executedCommands).toContain("systemctl restart my-app");
      expect(executedCommands).toContain("systemctl reload caddy");
      expect(healthProbeUrl).toBe("http://localhost:8080/health");
    });

    it("automatically rolls back if health probe fails", async () => {
      const yaml = `
app: my-app
port: 8080
health: /health
`;

      const executedCommands: string[] = [];
      const execMock = async (cmd: string) => {
        executedCommands.push(cmd);
        return { stdout: "success", stderr: "" };
      };

      // Force probe failure
      const probeMock = async () => false;

      // 1st deploy should fail and since there is no previous release, it cleans up
      const result = await deployApp(mockState, yaml, appSourceDir, {
        appsDir,
        etcDir,
        execCommand: execMock,
        fetchProbe: probeMock,
      });

      expect(result.success).toBe(false);
      expect(result.logs).toContain("Health probe failed! Initiating rollback");
      expect(result.logs).toContain("Rollback failed or no previous release available");

      // Check cleanup occurred
      const serviceFile = path.join(etcDir, "systemd", "system", "my-app.service");
      expect(fs.existsSync(serviceFile)).toBe(false);
      const caddyFile = path.join(etcDir, "caddy", "conf.d", "my-app.caddy");
      expect(fs.existsSync(caddyFile)).toBe(false);
      expect(fs.existsSync(path.join(appsDir, "my-app", "current"))).toBe(false);
    });

    it("rolls back to previous release successfully on health failure", async () => {
      const yaml = `
app: my-app
port: 8080
health: /health
`;

      const executedCommands: string[] = [];
      const execMock = async (cmd: string) => {
        executedCommands.push(cmd);
        return { stdout: "success", stderr: "" };
      };

      // 1. First successful deployment
      const res1 = await deployApp(mockState, yaml, appSourceDir, {
        appsDir,
        etcDir,
        execCommand: execMock,
        fetchProbe: async () => true,
      });
      expect(res1.success).toBe(true);
      const firstReleaseTag = res1.releaseTag;

      // Make sure we have a little gap in timestamps
      await new Promise(r => setTimeout(r, 10));

      // 2. Second deployment that fails health probe
      const res2 = await deployApp(mockState, yaml, appSourceDir, {
        appsDir,
        etcDir,
        execCommand: execMock,
        fetchProbe: async () => false, // fails health check
      });
      expect(res2.success).toBe(false);

      // Verify that current symlink reverted to the first release
      const currentLink = path.join(appsDir, "my-app", "current");
      expect(fs.existsSync(currentLink)).toBe(true);
      expect(fs.readlinkSync(currentLink)).toContain(firstReleaseTag);
      expect(executedCommands).toContain("systemctl restart my-app");
    });
  });

  describe("Logs Utility", () => {
    it("executes journalctl and returns app logs", async () => {
      const execMock = async (cmd: string) => {
        expect(cmd).toBe("journalctl -u my-app -n 50 --no-pager");
        return { stdout: "log-line-1\nlog-line-2", stderr: "" };
      };

      const logs = await getAppLogs("my-app", 50, { execCommand: execMock });
      expect(logs).toBe("log-line-1\nlog-line-2");
    });
  });
});
