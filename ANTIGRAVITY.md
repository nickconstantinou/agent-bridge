# Persistent memory

Bridge-spawned agents receive `AGENT_BRIDGE_CONTEXT_COMMAND` when shared
project memory is available.

Before making architectural decisions or modifying important behaviour, use:

```bash
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-query "<short relevant query>"
```

When you learn a durable project fact, decision, bug fix, convention, or
recurring issue, write a guarded candidate with:

```bash
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-add-json '{"type":"decision","scope":"project","text":"<concise memory>","confidence":0.8}'
```

Do not save secrets, API keys, passwords, transient logs, or private personal
information.

# Service Restart Safety

Do not run direct `sudo systemctl restart agent-bridge-<bot>` from an active
bot session. Use the root-owned safe helper instead:

```bash
sudo -n /usr/local/sbin/restart-agent-bridge
```

The helper sleeps for 5 seconds before restarting the fixed bridge unit list so
the bot can notify the user first. It must be granted through a narrow sudoers
rule for only `/usr/local/sbin/restart-agent-bridge`; never use `NOPASSWD: ALL`
or passwordless raw `systemctl`.

# CLI Effort Policy

Supported effort levels are `low`, `medium`, `high`, `xhigh`, and `max`;
default is `medium`. `/effort` changes the interactive setting.

- Codex maps effort to `-c model_reasoning_effort="<level>"`
- Claude maps effort to `--effort <level>`
- Agy has no separate effort flag; the bridge stores/displays the setting only
  so the unsupported state is explicit. Use Agy model labels for low/high.

Worker jobs select effort by task: scribe/read-only jobs use `medium`;
`tdd_implementation` and `orchestrated_task` use `high`. Agy remains scribe-only.
