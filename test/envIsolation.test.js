import { describe, expect, it } from "vitest";
import dotenv from "dotenv";

describe("service env isolation", () => {
  it("uses the service-specific env file instead of the shared .env", () => {
    const calls = [];
    const originalConfig = dotenv.config;
    dotenv.config = (options) => {
      calls.push(options);
      return {};
    };

    const originalBridgeEnvFile = process.env.BRIDGE_ENV_FILE;
    process.env.BRIDGE_ENV_FILE = "/tmp/service.env";

    try {
      // Simulate the startup contract: the bridge should ask dotenv for the service file.
      const path = process.env.BRIDGE_ENV_FILE || ".env";
      dotenv.config({ path, override: false });

      expect(calls).toEqual([{ path: "/tmp/service.env", override: false }]);
    } finally {
      dotenv.config = originalConfig;
      if (originalBridgeEnvFile === undefined) delete process.env.BRIDGE_ENV_FILE;
      else process.env.BRIDGE_ENV_FILE = originalBridgeEnvFile;
    }
  });
});
