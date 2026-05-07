import { getBotHelpText, buildModelsText, buildModelKeyboard, getCodexModels } from "./bridge.js";

export async function handleCommand(kind, prompt, { settingsStore, sessionStore, config }) {
  const parts = prompt.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const rest = parts.slice(1);

  if (command === "/start" || command === "start") {
    return { text: getBotHelpText(kind) };
  }

  if (command === "models" || command === "/models") {
    return {
      text: await buildModelsText(kind, { settingsStore, config }),
      reply_markup: await buildModelKeyboard(kind),
    };
  }

  if (command === "model" || command === "/model") {
    const value = rest.join(" ").trim();
    if (!value) return { text: `Usage: /model <name> | /model reset` };
    if (value === "reset") {
      await settingsStore.write({ [kind]: null });
      return { text: `${kind} default model reset to env/default` };
    }
    if (kind === "codex") {
      const allowed = new Set((await getCodexModels()).map((model) => model.slug));
      if (!allowed.has(value)) {
        return { text: `Unknown Codex model: ${value}. Use /models to see the current catalog.` };
      }
    }
    await settingsStore.write({ [kind]: value });
    return { text: `${kind} default model set to ${value}` };
  }

  if (command === "reset" || command === "/reset") {
    await sessionStore.set(kind, null);
    return { text: `${kind} session reset` };
  }

  return null;
}
