#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Guarded bootstrap helper for genuinely missing production databases
# (Phase 4C.3, issue #135). Install root-owned at:
#   /usr/local/sbin/rollout-bootstrap-agent-bridge
# with its own root-owned inventory at:
#   /etc/agent-bridge/rollout-bootstrap.conf
#
# Separate, explicitly-invoked route from rollout-agent-bridge.sh's ordinary
# --expected-commit migrate flow — never invoked implicitly by inspect/
# migrate/validate, and never bundled into the same invocation as a
# migration of existing databases (no pre-migration backup exists for a
# database that didn't exist, so it cannot participate in the whole-cohort
# restore guarantee the same way). Reuses openDb()'s existing, already-
# tested missing-file -> full-migration-plan path at the database layer
# (scripts/rollout-db.ts bootstrap); this script owns only the operator-
# facing guardrails: a fixed allowlist of expected new-role paths, parent-
# directory ownership/permission validation matching the existing backup-
# directory discipline, and coordination with the main rollout lock so a
# bootstrap can never race an active migrate rollout.

die() {
  echo "rollout-bootstrap: $*" >&2
  exit 1
}

new_role_path=""
if [[ "${1:-}" == "--new-role" && -n "${2:-}" && "${3:-}" == "--confirm-new-role" && -n "${4:-}" && $# -eq 4 ]]; then
  new_role_path="$2"
  [[ "$4" == "$new_role_path" ]] || die "--confirm-new-role must exactly match --new-role (expected \"$new_role_path\", got \"$4\")"
else
  die "usage: rollout-bootstrap --new-role <absolute path> --confirm-new-role <same absolute path>"
fi
[[ "$new_role_path" == /* ]] || die "new-role path must be absolute"

test_root="${AGENT_BRIDGE_ROLLOUT_TEST_ROOT:-}"
if [[ -n "$test_root" ]]; then
  (( EUID != 0 )) || die "test root is forbidden during root execution"
  [[ "$test_root" == /* && -d "$test_root" ]] || die "invalid test root"
  config_file="$test_root/etc/agent-bridge/rollout-bootstrap.conf"
  lock_file="$test_root/run/lock/agent-bridge-rollout.lock"
  runuser_cmd="$test_root/bin/runuser"
  test_mode=1
else
  (( EUID == 0 )) || die "must run as root"
  config_file="/etc/agent-bridge/rollout-bootstrap.conf"
  lock_file="/run/lock/agent-bridge-rollout.lock"
  runuser_cmd="/usr/sbin/runuser"
  test_mode=0
fi

for command_path in "$runuser_cmd" /usr/bin/flock /usr/bin/realpath /usr/bin/stat /usr/bin/mkdir /usr/bin/dirname; do
  [[ -x "$command_path" ]] || die "required command is unavailable: $command_path"
done

[[ -f "$config_file" && ! -L "$config_file" ]] || die "missing fixed bootstrap config: $config_file"
if (( test_mode == 0 )); then
  [[ "$(/usr/bin/stat -c %U "$config_file")" == "root" ]] || die "bootstrap config must be owned by root"
  config_mode="$(/usr/bin/stat -c %a "$config_file")"
  (( (8#$config_mode & 022) == 0 )) || die "bootstrap config must not be group/world writable"
fi

project_dir=""
runtime_user=""
node_bin=""
declare -a bootstrap_databases=()
while IFS='=' read -r key value || [[ -n "$key$value" ]]; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  [[ -n "$value" ]] || die "empty bootstrap config value for $key"
  case "$key" in
    project_dir) [[ -z "$project_dir" ]] || die "duplicate project_dir"; project_dir="$value" ;;
    runtime_user) [[ -z "$runtime_user" ]] || die "duplicate runtime_user"; runtime_user="$value" ;;
    node_bin) [[ -z "$node_bin" ]] || die "duplicate node_bin"; node_bin="$value" ;;
    bootstrap_database) bootstrap_databases+=("$value") ;;
    *) die "unknown bootstrap config key: $key" ;;
  esac
done < "$config_file"

for value_name in project_dir runtime_user node_bin; do
  [[ -n "${!value_name}" ]] || die "missing bootstrap config key: $value_name"
done
(( ${#bootstrap_databases[@]} > 0 )) || die "no bootstrap_database entries configured — new roles must be explicitly allowlisted"
[[ "$project_dir" == /* && "$node_bin" == /* ]] || die "configured paths must be absolute"
[[ -d "$project_dir" && ! -L "$project_dir" ]] || die "project directory is missing or symlinked"
[[ "$(/usr/bin/realpath -e "$project_dir")" == "$project_dir" ]] || die "project directory is not canonical"
[[ -x "$node_bin" && ! -L "$node_bin" ]] || die "configured Node binary is missing or symlinked"
[[ "$runtime_user" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || die "invalid runtime user"
if (( test_mode == 0 )); then /usr/bin/id -u "$runtime_user" >/dev/null || die "runtime user does not exist"; fi

allowed=0
for candidate in "${bootstrap_databases[@]}"; do
  [[ "$candidate" == "$new_role_path" ]] && { allowed=1; break; }
done
(( allowed == 1 )) || die "requested new-role path is not in the fixed bootstrap allowlist: $new_role_path"

[[ ! -e "$new_role_path" ]] || die "target already exists, not a genuinely missing database: $new_role_path"
parent_dir="$(/usr/bin/dirname "$new_role_path")"
[[ -d "$parent_dir" && ! -L "$parent_dir" ]] || die "new-role parent directory is missing or symlinked: $parent_dir"
[[ "$(/usr/bin/realpath -e "$parent_dir")" == "$parent_dir" ]] || die "new-role parent directory is not canonical: $parent_dir"
secure_owner_uid="$EUID"
if (( test_mode == 0 )); then secure_owner_uid=0; fi
[[ "$(/usr/bin/stat -c %u "$parent_dir")" == "$secure_owner_uid" ]] || die "new-role parent directory has unsafe ownership: $parent_dir"
parent_mode="$(/usr/bin/stat -c %a "$parent_dir")"
(( (8#$parent_mode & 022) == 0 )) || die "new-role parent directory must not be group/world writable: $parent_dir"

# Same lock file as rollout-agent-bridge.sh: a bootstrap and an ordinary
# migrate rollout must never run concurrently, even though bootstrap is a
# structurally separate invocation.
/usr/bin/mkdir -p "$(/usr/bin/dirname "$lock_file")"
exec 9>"$lock_file"
/usr/bin/flock --exclusive --nonblock 9 || die "a rollout or bootstrap is already active"

[[ -f "$project_dir/scripts/rollout-db.ts" ]] || die "bootstrap helper is missing from expected project checkout"
[[ -f "$project_dir/node_modules/tsx/dist/cli.mjs" ]] || die "tsx runtime is missing"

run_as_runtime() {
  "$runuser_cmd" --user "$runtime_user" -- "$@"
}

echo "bootstrapping new-role database: $new_role_path"
run_as_runtime "$node_bin" "$project_dir/node_modules/tsx/dist/cli.mjs" "$project_dir/scripts/rollout-db.ts" bootstrap \
  --db "$new_role_path" --confirm-new-role "$new_role_path"
echo "bootstrap completed: $new_role_path"
