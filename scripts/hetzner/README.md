# Hetzner Agent Bridge MVP

Provider-agnostic VPS orchestration lives in `scripts/infra.ts`. Hetzner is the production-MVP provider; Aruba remains a documented future provider target under `src/infra/providers/aruba/`.

## Required Env

Copy `scripts/hetzner/.env.example` into your local root `.env` or shell environment.

```bash
HETZNER_API_TOKEN=...
HETZNER_SSH_KEY_PATH=~/.ssh/id_rsa.pub
HETZNER_SSH_PRIVATE_KEY_PATH=~/.ssh/id_rsa
HETZNER_SERVER_TYPE=cx22
HETZNER_REGION=nbg1
DEPLOY_ENV_FILE=.env.worker
TAILSCALE_AUTH_KEY=
```

`DEPLOY_ENV_FILE` must contain at least:

```bash
TELEGRAM_BOT_TOKEN_WORKER=...
TELEGRAM_ALLOWED_USER_IDS=...
```

Only allowlisted runtime keys are uploaded: `TELEGRAM_*`, `WORKER_*`, `BRIDGE_*`, `CODEX_*`, `ANTIGRAVITY_*`, `GEMINI_*`, `CLAUDE_*`, `GITHUB_*`, `GH_*`, `HEALTH_*`, `PR_*`, `CLI_*`, `DEFECT_SCAN_*`, `AGENT_BRIDGE_*`, `DB_PATH`, `POLL_INTERVAL_MS`.

## Commands

```bash
npx tsx scripts/infra.ts provision --provider hetzner
npx tsx scripts/infra.ts deploy --provider hetzner
npx tsx scripts/infra.ts status --provider hetzner
npx tsx scripts/infra.ts logs --provider hetzner
npx tsx scripts/infra.ts smoke --provider hetzner
npx tsx scripts/infra.ts teardown --provider hetzner --dry-run
npx tsx scripts/infra.ts teardown --provider hetzner --yes
```

Legacy wrappers still work:

```bash
npx tsx scripts/hetzner/infra.ts provision
npx tsx scripts/hetzner/smoke.ts
```

## State And Idempotency

Provision writes `.agent-bridge/infra-state.json` with provider, server ID, firewall ID, SSH key ID, IP, region, server type, createdAt, and tags.

Commands reuse recorded resources. `provision --replace --yes` destroys only recorded, correctly tagged resources before creating replacements.

If local state is lost, commands attempt recovery only when exactly one tagged server, firewall, and SSH key exist. Names are fallback context only; teardown never relies only on names.

## Security Model

- Hetzner resources tagged with `project=agent-bridge`, `environment=spike`, `managed-by=agent-bridge`.
- Cloud-init creates non-root `agentbridge`.
- SSH password auth disabled.
- Root SSH disabled after bootstrap.
- UFW denies inbound by default and allows SSH only.
- Docker + Compose installed from Docker's Ubuntu repo.
- Runtime env stored at `/etc/agent-bridge/agent-bridge.env`, `root:root`, `0600`.
- Agent Bridge runs via `docker-compose.agent-bridge.yml` with non-root UID `1000`, dropped capabilities, `no-new-privileges`, restart policy, and healthcheck.
- Data persists under `/var/lib/agent-bridge`.
- Logs persist under `/var/log/agent-bridge`.

## Tailscale

Set `TAILSCALE_AUTH_KEY` before `provision` to install Tailscale and join the node during cloud-init.

Create keys in the Tailscale admin console under **Settings -> Keys**. Prefer ephemeral keys for throwaway nodes; use reusable keys only for stable rebuild workflows. With Tailscale enabled, Agent Bridge still does not require public application ports.

## Logs And Smoke

```bash
npx tsx scripts/infra.ts logs --provider hetzner
npx tsx scripts/infra.ts smoke --provider hetzner
```

Smoke checks verify SSH reachability, Compose status, UFW status, and scan recent logs for obvious secret marker leakage.

## Teardown Safety

`teardown` requires explicit confirmation unless `--yes` is passed.

```bash
npx tsx scripts/infra.ts teardown --provider hetzner --dry-run
npx tsx scripts/infra.ts teardown --provider hetzner --yes
```

Deletion is refused if provider or tags mismatch. Without local state, teardown only proceeds after unique tagged-resource recovery.

## Cost

Default `cx22` is the cheapest practical x86 Hetzner Cloud instance for this workload class, approximately **EUR 3.79/month plus VAT** before traffic or backup add-ons.

## Known Limitations

- Hetzner firewall still allows public SSH on port `22`; Tailscale narrows management path but edge SSH restriction by Tailscale CIDR is not automated yet.
- Tailscale IP discovery is attempted after `deploy`; if unavailable, commands continue using the public IPv4.
- Compose healthcheck verifies worker process presence, not an HTTP endpoint.
- Aruba Cloud is intentionally not expanded until the Hetzner path is repeatedly provisioned, deployed, verified, and destroyed without drift.
