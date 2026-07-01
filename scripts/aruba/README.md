# Aruba MVP Infrastructure

Aruba is the current low-cost MVP target for proving the Agent Bridge orchestration workflow:

```text
plan -> provision -> deploy -> status -> smoke -> logs -> destroy
```

Only `plan` and `provision --dry-run` are implemented so far. Both are read-only and create no billable resources.

## Required Secrets

Store Aruba credentials outside the repo:

```bash
~/.secrets/ARUBA_API_KEY.TXT
~/.secrets/ARUBA_API_SECRET.TXT
```

Both files must be mode `0600`.

## Read-Only Plan

`ARUBA_ALLOWED_PROJECT_IDS` is required. This prevents accidental provisioning in a non-spike project.

```bash
ARUBA_PROJECT_ID=6a441175cc0105549bddb296 \
ARUBA_ALLOWED_PROJECT_IDS=6a441175cc0105549bddb296 \
npx tsx scripts/infra.ts plan --provider aruba
```

## Provision Dry Run

This repeats the validated plan and stops before creating any resource:

```bash
ARUBA_PROJECT_ID=6a441175cc0105549bddb296 \
ARUBA_ALLOWED_PROJECT_IDS=6a441175cc0105549bddb296 \
npx tsx scripts/infra.ts provision --provider aruba --dry-run
```

Default target:

```text
location=ITBG-Bergamo
dataCenter=ITBG-1
image=LU24-001
flavor=CSO1A2
maxMonthlyBudgetEur=5
tags=project=agent-bridge,environment=spike,managed-by=agent-bridge
```

## Guardrails

The plan refuses to pass unless:

- credentials are valid
- project exists
- project ID is allowlisted
- flavor is `CSO1A2`
- estimated monthly cost is at or below EUR 5
- required tags are present
- no existing VPS is visible in the target project

Use `--override-guardrails` only for an explicit operator-approved exception.

Destructive actions default to dry-run unless `--yes` is supplied.

## Future Enhancements

Deferred until they directly improve the MVP workflow:

- live `provision` with explicit Elastic IP create/associate flow
- Aruba `destroy --dry-run` and `destroy --yes`
- `deploy`
- `status`
- `smoke`
- `logs`
- OpenStack backend
- additional cloud providers
- multi-worker, multi-org, multi-repo, or multi-deployment support
- billing, dashboard, monitoring, backup, snapshot, scaling, or HA features

## Live Spike Notes

Live provisioning created and deleted minimum-cost test resources successfully enough to validate key pair, boot volume, and cloud server API access.

Observed Aruba behavior:

- compact metadata tags are required; values such as `project=agent-bridge` are rejected
- `vpcPreset=true` can create an automatic untagged VPC/subnet/security group
- a server can become `Active` without a public IP if no Elastic IP is attached
- once an automatic VPC exists, Aruba rejects another `vpcPreset=true` server create in the same project
- billable resources from the spike were cleaned up: cloud servers, boot volumes, key pairs, and Elastic IPs returned to zero

Next implementation step before another live create:

- create an Elastic IP explicitly
- create the server against the existing VPC/subnet/security group without `vpcPreset`
- associate the Elastic IP through `associateDisassociateElasticIPs`
- record `elasticIpId` in local state
- delete in state order: server, Elastic IP, boot volume, key pair
