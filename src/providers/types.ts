export const PROVIDER_IDS = ["codex", "claude", "agy"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderErrorClassification =
  | { readonly kind: "capacity_exhausted"; readonly reason: string }
  | { readonly kind: "auth_required"; readonly reason: string }
  | { readonly kind: "model_unavailable"; readonly reason: string }
  | { readonly kind: "transient"; readonly reason: string }
  | { readonly kind: "fatal"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

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
