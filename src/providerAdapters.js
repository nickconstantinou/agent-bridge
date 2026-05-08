import { buildCliInvocation, buildGeminiFallbackInvocation, parseCliResult, createCliStreamingParser } from "./cli.js";

export const providerAdapters = {
  codex: {
    supportsStreaming: true,
    buildInvocation: buildCliInvocation,
    parseResult: (stdout) => parseCliResult({ bot: "codex", stdout }),
    createStreamingParser: (onUpdate) => createCliStreamingParser({ bot: "codex", onUpdate }),
  },
  gemini: {
    supportsStreaming: true,
    buildInvocation: buildCliInvocation,
    buildFallbackInvocation: buildGeminiFallbackInvocation,
    parseResult: (stdout) => parseCliResult({ bot: "gemini", stdout }),
    createStreamingParser: (onUpdate) => createCliStreamingParser({ bot: "gemini", onUpdate }),
  },
};
