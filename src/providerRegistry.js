export function createProviderRegistry(providers) {
  return {
    get(kind) {
      const provider = providers[kind];
      if (!provider) throw new Error(`Unsupported provider: ${kind}`);
      return provider;
    },
    hasStreaming(kind) {
      return Boolean(providers[kind]?.supportsStreaming);
    },
  };
}

export function createDefaultProviderRegistry(deps) {
  return createProviderRegistry({
    codex: deps.codex,
    gemini: deps.gemini,
  });
}
