/**
 * Spike: Async bridge pattern using ACP runtime (corrected flags)
 * Validates "ack immediately, run in background, stream progress, cancel safely"
 * Run: node spike.js
 */

const { spawn } = require("child_process");

const GEMINI = process.env.GEMINI_COMMAND || "/home/openclaw/.nvm/versions/node/v24.14.1/bin/gemini";
const PROJECT_DIR = process.env.BRIDGE_PROJECT_DIR || "/home/openclaw/.openclaw/workspace/projects/agent-bridge";

class SimTelegram {
  constructor() { this.msgs = []; }
  async sendTyping(v) { console.log("[Telegram] typing:", v); }
  async sendMessage(text) { 
    const id = "msg_" + Date.now();
    this.msgs.push({ id, text });
    console.log("[Telegram] sent:", id, text.slice(0,50));
    return id;
  }
  async editMessageText(id, text) {
    const m = this.msgs.find(x => x.id === id);
    if (m) { m.text = text; console.log("[Telegram] edited:", id, text.slice(0,50)); }
  }
  async deleteMessage(id) {
    this.msgs = this.msgs.filter(x => x.id !== id);
    console.log("[Telegram] deleted:", id);
  }
}

async function runWithACP({ prompt, onProgress, onCancel }) {
  const tg = new SimTelegram();
  
  // 1. Immediate ack
  await tg.sendTyping(true);
  const placeholder = await tg.sendMessage("🤔 Thinking...");
  
  // 2. Spawn via ACP (corrected flags)
  const child = spawn(GEMINI, [
    "-p", prompt,              // Non-interactive mode with prompt
    "--acp",                  // ACP mode
    "--approval-mode", "yolo", // Auto-approve all actions
    "--output-format", "text",  // Plain text output
    "--silent"
  ], { 
    cwd: PROJECT_DIR, 
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GEMINI, BRIDGE_PROJECT_DIR }
  });
  
  let buf = "", killed = false;
  
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    if (buf.length >= 300) {
      tg.editMessageText(placeholder, "🤔 " + buf.slice(-300));
      onProgress(buf.slice(-300));
    }
  });
  
  child.stderr.on("data", (c) => console.log("[ACP]", c.toString().slice(0,100)));
  
  // 3. Cancellation
  onCancel(() => {
    killed = true;
    console.log("[Cancel] Sending SIGTERM to ACP session");
    child.kill("SIGTERM");
  });
  
  // 4. Wait for completion
  return new Promise((resolve, reject) => {
    child.on("close", (code) => {
      if (killed) { tg.deleteMessage(placeholder); resolve("__CANCELLED__"); return; }
      const text = buf.trim() || "(no response)";
      if (code === 0) { tg.editMessageText(placeholder, text); resolve(text); }
      else { tg.editMessageText(placeholder, "❌ Exit " + code); reject(new Error(code)); }
    });
    child.on("error", (e) => { tg.editMessageText(placeholder, "❌ " + e.message); reject(e); });
  });
}

async function main() {
  console.log("=== SPIKE: ACP Async Bridge Pattern ===\n");
  try {
    const r = await runWithACP({
      prompt: "Say hello in exactly 3 words",
      onProgress: (t) => console.log("[Progress]", t.slice(0,50)),
      onCancel: (fn) => {},
    });
    console.log("\n✓ Result:", r.slice(0,100));
  } catch(e) { console.error("✗", e); process.exit(1); }
}

main();