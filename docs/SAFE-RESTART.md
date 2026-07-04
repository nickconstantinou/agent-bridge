---
status: authoritative
type: operations
authority: canonical
implementation_status: implemented
last_validated_against: 23d06cfc3e098561ec21ce29880e60d1d146b7cc
---

# Safe Remote Restart

Use this path when a bridge bot needs to restart services from inside an active
Telegram session. It gives the bot 5 seconds to send the user-facing restart
notice before systemd tears down the service control groups.

## Install

```bash
sudo install -D -m 0750 -o root -g root scripts/restart-agent-bridge.sh /usr/local/sbin/restart-agent-bridge
sudo visudo -f /etc/sudoers.d/agent-bridge-restart
```

Sudoers content:

```sudoers
content-crawler ALL=(root) NOPASSWD: /usr/local/sbin/restart-agent-bridge
```

## Use

```bash
sudo -n /usr/local/sbin/restart-agent-bridge
```

Do not grant `NOPASSWD: ALL` or passwordless raw `systemctl`. The helper has a
fixed `agent-bridge-*` unit list and a default `RESTART_DELAY_SECONDS=5`.
