#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Guarded production rollout helper. Install root-owned at:
#   /usr/local/sbin/rollout-agent-bridge
# with its root-owned inventory at:
#   /etc/agent-bridge/rollout.conf

readonly EXPECTED_DATABASE_COUNT=5
readonly -a UNITS=(
  agent-bridge-antigravity.service
  agent-bridge-claude.service
  agent-bridge-codex.service
  agent-bridge-discord-interactive.service
  agent-bridge-health.service
  agent-bridge-interactive.service
  agent-bridge-worker-bot.service
)

die() {
  echo "rollout-agent-bridge: $*" >&2
  exit 1
}

expected_commit=""
if [[ "${1:-}" == "--expected-commit" && -n "${2:-}" && $# -eq 2 ]]; then
  expected_commit="$2"
else
  die "usage: rollout-agent-bridge --expected-commit <40-character SHA>"
fi
[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]] || die "expected commit must be a full 40-character lowercase SHA"

test_root="${AGENT_BRIDGE_ROLLOUT_TEST_ROOT:-}"
if [[ -n "$test_root" ]]; then
  (( EUID != 0 )) || die "test root is forbidden during root execution"
  [[ "$test_root" == /* && -d "$test_root" ]] || die "invalid test root"
  config_file="$test_root/etc/agent-bridge/rollout.conf"
  lock_file="$test_root/run/lock/agent-bridge-rollout.lock"
  systemctl_cmd="$test_root/bin/systemctl"
  runuser_cmd="$test_root/bin/runuser"
  journalctl_cmd="$test_root/bin/journalctl"
  smoke_delay=0
  test_mode=1
else
  (( EUID == 0 )) || die "must run as root"
  config_file="/etc/agent-bridge/rollout.conf"
  lock_file="/run/lock/agent-bridge-rollout.lock"
  systemctl_cmd="/usr/bin/systemctl"
  runuser_cmd="/usr/sbin/runuser"
  journalctl_cmd="/usr/bin/journalctl"
  smoke_delay=5
  test_mode=0
fi

for command_path in "$systemctl_cmd" "$runuser_cmd" "$journalctl_cmd" /usr/bin/flock /usr/bin/git /usr/bin/sha256sum /usr/bin/tee /usr/bin/realpath /usr/bin/stat /usr/bin/id /usr/bin/cp /usr/bin/mv /usr/bin/rm /usr/bin/cut /usr/bin/sleep /usr/bin/mkdir /usr/bin/chmod /usr/bin/dirname /usr/bin/date /usr/bin/chown; do
  [[ -x "$command_path" ]] || die "required command is unavailable: $command_path"
done
[[ -f "$config_file" && ! -L "$config_file" ]] || die "missing fixed rollout config: $config_file"
if (( test_mode == 0 )); then
  [[ "$(/usr/bin/stat -c %U "$config_file")" == "root" ]] || die "rollout config must be owned by root"
  config_mode="$(/usr/bin/stat -c %a "$config_file")"
  (( (8#$config_mode & 022) == 0 )) || die "rollout config must not be group/world writable"
fi

project_dir=""
runtime_user=""
node_bin=""
backup_dir=""
log_dir=""
declare -a databases=()
while IFS='=' read -r key value || [[ -n "$key$value" ]]; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  [[ -n "$value" ]] || die "empty rollout config value for $key"
  case "$key" in
    project_dir) [[ -z "$project_dir" ]] || die "duplicate project_dir"; project_dir="$value" ;;
    runtime_user) [[ -z "$runtime_user" ]] || die "duplicate runtime_user"; runtime_user="$value" ;;
    node_bin) [[ -z "$node_bin" ]] || die "duplicate node_bin"; node_bin="$value" ;;
    backup_dir) [[ -z "$backup_dir" ]] || die "duplicate backup_dir"; backup_dir="$value" ;;
    log_dir) [[ -z "$log_dir" ]] || die "duplicate log_dir"; log_dir="$value" ;;
    database) databases+=("$value") ;;
    *) die "unknown rollout config key: $key" ;;
  esac
done < "$config_file"

for value_name in project_dir runtime_user node_bin backup_dir log_dir; do
  [[ -n "${!value_name}" ]] || die "missing rollout config key: $value_name"
done
(( ${#databases[@]} == EXPECTED_DATABASE_COUNT )) || die "fixed database allowlist must contain exactly $EXPECTED_DATABASE_COUNT entries"
[[ "$project_dir" == /* && "$node_bin" == /* && "$backup_dir" == /* && "$log_dir" == /* ]] || die "configured paths must be absolute"
[[ -d "$project_dir" && ! -L "$project_dir" ]] || die "project directory is missing or symlinked"
[[ -x "$node_bin" && ! -L "$node_bin" ]] || die "configured Node binary is missing or symlinked"
[[ "$runtime_user" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || die "invalid runtime user"
if (( test_mode == 0 )); then /usr/bin/id -u "$runtime_user" >/dev/null || die "runtime user does not exist"; fi

/usr/bin/mkdir -p "$(/usr/bin/dirname "$lock_file")"
exec 9>"$lock_file"
/usr/bin/flock --exclusive --nonblock 9 || die "another rollout is already active"

timestamp="$(/usr/bin/date -u +%Y%m%dT%H%M%SZ)"
artifact_dir="$log_dir/$timestamp-$expected_commit"
[[ ! -e "$artifact_dir" ]] || die "rollout artifact directory already exists: $artifact_dir"
/usr/bin/mkdir -p "$artifact_dir" "$backup_dir"
/usr/bin/chmod 0700 "$artifact_dir"
/usr/bin/chmod 0711 "$backup_dir"
log_file="$artifact_dir/rollout.log"
printf '%s\n' "$artifact_dir" > "$log_dir/latest"
exec > >(/usr/bin/tee -a "$log_file") 2>&1

echo "rollout start timestamp=$timestamp expected_commit=$expected_commit"
echo "units=${UNITS[*]}"
echo "database_count=${#databases[@]}"

manifest="$artifact_dir/backup-manifest.tsv"
backup_set="$backup_dir/$timestamp-$expected_commit"
migration_committed=0
stop_attempted=0
completed=0

restore_backups() {
  [[ -s "$manifest" ]] || return 0
  echo "restoring pre-rollout databases from $manifest"
  local restore_failed=0
  while IFS=$'\t' read -r source backup source_hash backup_hash; do
    [[ "$source" == "source" ]] && continue
    [[ -f "$backup" ]] || { echo "missing rollback backup: $backup" >&2; restore_failed=1; continue; }
    [[ "$source_hash" == "$backup_hash" ]] || { echo "backup manifest is not byte-exact: $backup" >&2; restore_failed=1; continue; }
    actual_backup_hash="$(/usr/bin/sha256sum "$backup" | /usr/bin/cut -d' ' -f1)"
    [[ "$actual_backup_hash" == "$backup_hash" ]] || { echo "rollback backup hash mismatch: $backup" >&2; restore_failed=1; continue; }
    restore_tmp="${source}.rollout-restore"
    /usr/bin/cp --preserve=mode,ownership,timestamps "$backup" "$restore_tmp"
    /usr/bin/mv "$restore_tmp" "$source"
    /usr/bin/rm -f "${source}-wal" "${source}-shm"
    restored_hash="$(/usr/bin/sha256sum "$source" | /usr/bin/cut -d' ' -f1)"
    [[ "$restored_hash" == "$backup_hash" ]] || { echo "restored database hash mismatch: $source" >&2; restore_failed=1; }
  done < "$manifest"
  (( restore_failed == 0 )) || { echo "ROLLBACK INCOMPLETE; services remain stopped" >&2; return 1; }
  echo "database rollback completed and hash-verified"
}

contain_services() {
  "$systemctl_cmd" stop "${UNITS[@]}" || true
}

on_exit() {
  status=$?
  if (( status == 0 && completed == 1 )); then return 0; fi
  set +e
  echo "rollout failed status=$status migration_committed=$migration_committed; containing services"
  if (( stop_attempted == 1 )); then contain_services; fi
  if (( test_mode == 0 )) && [[ -d "$backup_set" ]]; then /usr/bin/chown -R root:root "$backup_set"; fi
  if (( migration_committed == 0 )); then restore_backups || status=1; fi
  echo "services remain stopped; operator review required"
  exit "${status:-1}"
}
trap on_exit EXIT

[[ "$(/usr/bin/git -C "$project_dir" rev-parse --is-inside-work-tree)" == "true" ]] || die "project is not a Git worktree"
[[ " $(/usr/bin/git -C "$project_dir" branch --show-current) " == " main " ]] || die "project must be on main"
actual_commit="$(/usr/bin/git -C "$project_dir" rev-parse HEAD)"
[[ "$actual_commit" == "$expected_commit" ]] || die "expected commit $expected_commit but found $actual_commit"
[[ -z "$(/usr/bin/git -C "$project_dir" status --porcelain --untracked-files=normal)" ]] || die "project must have a clean working tree"
[[ -f "$project_dir/scripts/rollout-db.ts" ]] || die "migration helper is missing from expected commit"
[[ -f "$project_dir/node_modules/tsx/dist/cli.mjs" ]] || die "tsx runtime is missing"

declare -A canonical_databases=()
for database in "${databases[@]}"; do
  [[ "$database" == /* ]] || die "database allowlist entries must be absolute"
  [[ -f "$database" && ! -L "$database" ]] || die "missing database or symlinked database: $database"
  canonical="$(/usr/bin/realpath -e "$database")"
  [[ "$canonical" == "$database" ]] || die "database path is not canonical: $database"
  [[ -z "${canonical_databases[$canonical]:-}" ]] || die "duplicate database allowlist entry: $database"
  canonical_databases[$canonical]=1
done

db_args=()
for database in "${databases[@]}"; do db_args+=(--db "$database"); done
run_db_tool() {
  "$runuser_cmd" --user "$runtime_user" -- "$node_bin" "$project_dir/node_modules/tsx/dist/cli.mjs" "$project_dir/scripts/rollout-db.ts" "$@"
}

for unit in "${UNITS[@]}"; do
  "$systemctl_cmd" is-active --quiet "$unit" || die "required service is not active before rollout: $unit"
done
run_db_tool inspect --evidence - "${db_args[@]}" > "$artifact_dir/preflight-evidence.json"
/usr/bin/sha256sum "$artifact_dir/preflight-evidence.json" > "$artifact_dir/preflight-evidence.sha256"

echo "stopping all services"
stop_attempted=1
"$systemctl_cmd" stop "${UNITS[@]}"
for unit in "${UNITS[@]}"; do
  if "$systemctl_cmd" is-active --quiet "$unit"; then die "service remains active after stop: $unit"; fi
done

[[ "$(/usr/bin/git -C "$project_dir" rev-parse HEAD)" == "$expected_commit" ]] || die "expected commit changed after stop"
[[ -z "$(/usr/bin/git -C "$project_dir" status --porcelain --untracked-files=normal)" ]] || die "project lost clean working tree after stop"
run_db_tool inspect --evidence - "${db_args[@]}" > "$artifact_dir/stopped-evidence.json"

echo "backing up all databases"
/usr/bin/mkdir -p "$backup_set"
if (( test_mode == 0 )); then /usr/bin/chown "$runtime_user" "$backup_set"; fi
run_db_tool backup --backup-dir "$backup_set" --manifest - "${db_args[@]}" > "$manifest"
if (( test_mode == 0 )); then /usr/bin/chown -R root:root "$backup_set"; fi
/usr/bin/sha256sum "$manifest" > "$artifact_dir/backup-manifest.sha256"

echo "migrating databases using pre-staged commit $expected_commit"
run_db_tool migrate --evidence - "${db_args[@]}" > "$artifact_dir/migration-evidence.json"
echo "validating migrated databases"
run_db_tool validate --evidence - "${db_args[@]}" > "$artifact_dir/validation-evidence.json"
/usr/bin/sha256sum "$artifact_dir/migration-evidence.json" "$artifact_dir/validation-evidence.json" > "$artifact_dir/migration-evidence.sha256"
migration_committed=1

echo "starting all services"
journal_since="$(/usr/bin/date -u '+%Y-%m-%d %H:%M:%S UTC')"
"$systemctl_cmd" start "${UNITS[@]}"
for unit in "${UNITS[@]}"; do
  "$systemctl_cmd" is-active --quiet "$unit" || die "service failed active smoke check: $unit"
done
if (( smoke_delay > 0 )); then /usr/bin/sleep "$smoke_delay"; fi
journal_args=()
for unit in "${UNITS[@]}"; do journal_args+=(-u "$unit"); done
startup_errors="$("$journalctl_cmd" --since "$journal_since" --priority err --no-pager "${journal_args[@]}" 2>&1)" || die "journal smoke command failed"
[[ -z "$startup_errors" ]] || die "startup journal smoke found errors: $startup_errors"
run_db_tool validate --evidence - "${db_args[@]}" > "$artifact_dir/post-start-evidence.json"

completed=1
echo "rollout completed commit=$expected_commit artifacts=$artifact_dir"
