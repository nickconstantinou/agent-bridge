export const PROVIDER_IDS = ["codex", "claude", "agy"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderCapabilities {
  readonly interactive: boolean;
  readonly worker: boolean;
  readonly fallbackTarget: boolean;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly executable: string;
  readonly defaultArgs: readonly string[];
  readonly capabilities: ProviderCapabilities;
}
