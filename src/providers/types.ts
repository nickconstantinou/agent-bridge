export const PROVIDER_IDS = ["codex", "claude", "agy", "kimchi"] as const;
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
  /** Allowed to write production code in worker jobs. */
  readonly worker: boolean;
  /** Allowed in worker-bot fallback chains (interactive/scribe duty). */
  readonly workerChain: boolean;
  readonly fallbackTarget: boolean;
}


export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly executable: string;
  readonly defaultArgs: readonly string[];
  readonly capabilities: ProviderCapabilities;
}

/** CLI kind vocabulary used in fallback-chain env vars; "antigravity" maps to provider id "agy". */
export type ChainCliKind = "codex" | "claude" | "antigravity" | "kimchi";
