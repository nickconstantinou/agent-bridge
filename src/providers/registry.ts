import {
  type ProviderAdapter,
  type ProviderId,
  PROVIDER_IDS,
} from "./types.js";

const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  codex: {
    id: "codex",
    displayName: "Codex",
    executable: "codex",
    defaultArgs: ["--approval-mode", "full-auto"],
    capabilities: {
      interactive: true,
      worker: true,
      workerChain: true,
      fallbackTarget: true,
    },
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    executable: "claude",
    defaultArgs: ["--dangerously-skip-permissions"],
    capabilities: {
      interactive: true,
      worker: true,
      workerChain: true,
      fallbackTarget: true,
    },
  },
  agy: {
    id: "agy",
    displayName: "Antigravity",
    executable: "agy",
    defaultArgs: ["--print"],
    capabilities: {
      interactive: true,
      worker: false,
      workerChain: true,
      fallbackTarget: true,
    },
  },
  kimchi: {
    id: "kimchi",
    displayName: "Kimchi",
    executable: "kimchi",
    defaultArgs: ["--print"],
    capabilities: {
      interactive: true,
      worker: false,
      workerChain: false,
      fallbackTarget: true,
    },
  },
};

export function getProviderAdapter(id: ProviderId): ProviderAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(`Unknown provider id: ${id}`);
  }
  return adapter;
}

export function getProviderAdapters(): readonly ProviderAdapter[] {
  return PROVIDER_IDS.map((id) => ADAPTERS[id]);
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export function assertProviderId(value: string): ProviderId {
  if (!isProviderId(value)) {
    throw new Error(`Unknown provider id: ${value}`);
  }
  return value;
}

export { PROVIDER_IDS } from "./types.js";
export type { ProviderAdapter, ProviderCapabilities, ProviderErrorClassification, ProviderId } from "./types.js";
