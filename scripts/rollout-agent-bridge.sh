#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Guarded production rollout helper. Install root-owned at:
#   /usr/local/sbin/rollout-agent-bridge
# with its root-owned inventory at:
#   /etc/agent-bridge/rollout.conf

readonly -a ALLOWED_UNITS=(
  agent-bridge-antigravity.service
  agent-bridge-claude.service
  agent-bridge-codex.service
  agent-bridge-discord-interactive.service
  agent-bridge-health.service
  agent-bridge-interactive.service
  agent-bridge-worker-bot.service
)

is_allowed_unit() {
  local candidate="$1" allowed
  for allowed in "${ALLOWED_UNITS[@]}"; do [[ "$candidate" == "$allowed" ]] && return 0; done
  return 1
}

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
  cp_cmd="$test_root/bin/cp"
  restore_cmd="$test_root/bin/rollout-restore"
  defaults_dir="$test_root/etc/default"
  cgroup_root="$test_root/sys/fs/cgroup"
  smoke_delay=0
  test_mode=1
else
  (( EUID == 0 )) || die "must run as root"
  config_file="/etc/agent-bridge/rollout.conf"
  lock_file="/run/lock/agent-bridge-rollout.lock"
  systemctl_cmd="/usr/bin/systemctl"
  runuser_cmd="/usr/sbin/runuser"
  journalctl_cmd="/usr/bin/journalctl"
  cp_cmd="/usr/bin/cp"
  restore_cmd="/usr/local/libexec/agent-bridge-rollout-restore"
  defaults_dir="/etc/default"
  cgroup_root="/sys/fs/cgroup"
  smoke_delay=5
  test_mode=0
fi

for command_path in "$systemctl_cmd" "$runuser_cmd" "$journalctl_cmd" "$cp_cmd" "$restore_cmd" /usr/bin/find /usr/bin/flock /usr/bin/git /usr/bin/sha256sum /usr/bin/tee /usr/bin/realpath /usr/bin/stat /usr/bin/id /usr/bin/mv /usr/bin/rm /usr/bin/cut /usr/bin/sleep /usr/bin/mkdir /usr/bin/chmod /usr/bin/dirname /usr/bin/date /usr/bin/mktemp; do
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
declare -a units=()
while IFS='=' read -r key value || [[ -n "$key$value" ]]; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  [[ -n "$value" ]] || die "empty rollout config value for $key"
  case "$key" in
    project_dir) [[ -z "$project_dir" ]] || die "duplicate project_dir"; project_dir="$value" ;;
    runtime_user) [[ -z "$runtime_user" ]] || die "duplicate runtime_user"; runtime_user="$value" ;;
    node_bin) [[ -z "$node_bin" ]] || die "duplicate node_bin"; node_bin="$value" ;;
    backup_dir) [[ -z "$backup_dir" ]] || die "duplicate backup_dir"; backup_dir="$value" ;;
    log_dir) [[ -z "$log_dir" ]] || die "duplicate log_dir"; log_dir="$value" ;;
    unit) units+=("$value") ;;
    database) databases+=("$value") ;;
    *) die "unknown rollout config key: $key" ;;
  esac
done < "$config_file"

for value_name in project_dir runtime_user node_bin backup_dir log_dir; do
  [[ -n "${!value_name}" ]] || die "missing rollout config key: $value_name"
done
(( ${#units[@]} > 0 )) || die "fixed unit allowlist must select at least one service"
(( ${#databases[@]} > 0 )) || die "fixed database allowlist must contain at least one entry"
[[ "$project_dir" == /* && "$node_bin" == /* && "$backup_dir" == /* && "$log_dir" == /* ]] || die "configured paths must be absolute"
[[ -d "$project_dir" && ! -L "$project_dir" ]] || die "project directory is missing or symlinked"
[[ "$(/usr/bin/realpath -e "$project_dir")" == "$project_dir" ]] || die "project directory is not canonical"
[[ -x "$node_bin" && ! -L "$node_bin" ]] || die "configured Node binary is missing or symlinked"
[[ "$runtime_user" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || die "invalid runtime user"
if (( test_mode == 0 )); then /usr/bin/id -u "$runtime_user" >/dev/null || die "runtime user does not exist"; fi

secure_owner_uid="$EUID"
if (( test_mode == 0 )); then secure_owner_uid=0; fi
validate_secure_path() {
  local path="$1" kind="$2" mode owner canonical
  if [[ "$kind" == directory ]]; then [[ -d "$path" && ! -L "$path" ]] || die "$path must be a non-symlink directory"
  else [[ -f "$path" && ! -L "$path" ]] || die "$path must be a non-symlink regular file"
  fi
  canonical="$(/usr/bin/realpath -e "$path")"
  [[ "$canonical" == "$path" ]] || die "$path is not canonical"
  owner="$(/usr/bin/stat -c %u "$path")"
  [[ "$owner" == "$secure_owner_uid" ]] || die "$path has unsafe ownership"
  mode="$(/usr/bin/stat -c %a "$path")"
  (( (8#$mode & 022) == 0 )) || die "$path must not be group/world writable"
}
validate_secure_path "$backup_dir" directory
validate_secure_path "$log_dir" directory

declare -A selected_units=()
for unit in "${units[@]}"; do
  is_allowed_unit "$unit" || die "unit is not in the compiled allowlist: $unit"
  [[ -z "${selected_units[$unit]:-}" ]] || die "duplicate selected unit: $unit"
  selected_units[$unit]=1
done

shared_env="$defaults_dir/agent-bridge-shared"
if [[ -e "$shared_env" ]]; then validate_secure_path "$shared_env" file; fi
read_env_key() {
  local file="$1" target_key="$2" line value="$3"
  [[ -e "$file" ]] || { resolved_env_value="$value"; return 0; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" == "$target_key="* ]]; then
      value="${line#*=}"
      [[ -n "$value" && "$value" != *[[:space:]\"\'\\\$]* ]] || die "unsupported or empty $target_key in $file"
    fi
  done < "$file"
  resolved_env_value="$value"
}

declare -A discovered_databases=()
declare -A unit_databases=()
for unit in "${units[@]}"; do
  unit_env="$defaults_dir/${unit%.service}"
  validate_secure_path "$unit_env" file
  expected_environment_files="$shared_env (ignore_errors=yes)"$'\n'"$unit_env (ignore_errors=no)"
  actual_environment_files="$("$systemctl_cmd" show "$unit" --property=EnvironmentFiles --value)"
  [[ "$actual_environment_files" == "$expected_environment_files" ]] || die "effective EnvironmentFiles mismatch for $unit"
  db_key=DB_PATH
  [[ "$unit" == "agent-bridge-health.service" ]] && db_key=HEALTH_DB_PATH
  explicit_environment="$("$systemctl_cmd" show "$unit" --property=Environment --value)"
  [[ " $explicit_environment " != *" $db_key="* ]] || die "explicit systemd $db_key override is unsupported for $unit"
  resolved_env_value=""
  read_env_key "$shared_env" "$db_key" ""
  inherited_value="$resolved_env_value"
  read_env_key "$unit_env" "$db_key" "$inherited_value"
  discovered="$resolved_env_value"
  [[ "$discovered" == /* ]] || die "$unit would use a missing, relative, or defaulted $db_key"
  [[ -f "$discovered" && ! -L "$discovered" ]] || die "missing database or symlinked database for $unit: $discovered"
  canonical="$(/usr/bin/realpath -e "$discovered")"
  [[ "$canonical" == "$discovered" ]] || die "database path for $unit is not canonical: $discovered"
  unit_databases[$unit]="$canonical"
  discovered_databases[$canonical]=1
done

declare -A canonical_databases=()
for database in "${databases[@]}"; do
  [[ "$database" == /* && "$database" != *[[:space:]]* ]] || die "database allowlist entries must be canonical absolute paths without whitespace"
  [[ -f "$database" && ! -L "$database" ]] || die "missing database or symlinked database: $database"
  canonical="$(/usr/bin/realpath -e "$database")"
  [[ "$canonical" == "$database" ]] || die "database path is not canonical: $database"
  [[ -z "${canonical_databases[$canonical]:-}" ]] || die "duplicate database allowlist entry: $database"
  canonical_databases[$canonical]=1
done
(( ${#canonical_databases[@]} == ${#discovered_databases[@]} )) || die "configured and discovered database inventory counts differ"
for database in "${!canonical_databases[@]}"; do [[ -n "${discovered_databases[$database]:-}" ]] || die "extra configured database not selected by any unit: $database"; done
for database in "${!discovered_databases[@]}"; do [[ -n "${canonical_databases[$database]:-}" ]] || die "discovered database missing from root allowlist: $database"; done

/usr/bin/mkdir -p "$(/usr/bin/dirname "$lock_file")"
exec 9>"$lock_file"
/usr/bin/flock --exclusive --nonblock 9 || die "another rollout is already active"

timestamp="$(/usr/bin/date -u +%Y%m%dT%H%M%SZ)"
artifact_dir="$log_dir/$timestamp-$expected_commit"
[[ ! -e "$artifact_dir" ]] || die "rollout artifact directory already exists: $artifact_dir"
/usr/bin/mkdir --mode=0700 -- "$artifact_dir"
/usr/bin/chmod 0700 "$artifact_dir"
log_file="$artifact_dir/rollout.log"
latest_tmp="$(/usr/bin/mktemp --tmpdir="$log_dir" .latest.XXXXXX)"
printf '%s\n' "$artifact_dir" > "$latest_tmp"
/usr/bin/chmod 0600 "$latest_tmp"
/usr/bin/mv -T -- "$latest_tmp" "$log_dir/latest"
exec > >(/usr/bin/tee -a "$log_file") 2>&1

echo "rollout start timestamp=$timestamp expected_commit=$expected_commit"
echo "units=${units[*]}"
echo "database_count=${#databases[@]}"

manifest="$artifact_dir/backup-manifest.tsv"
backup_set="$backup_dir/$timestamp-$expected_commit"
start_attempted=0
services_started=0
stop_attempted=0
completed=0
declare -a expected_backups=()

backup_databases() {
  /usr/bin/mkdir --mode=0700 -- "$backup_set"
  printf 'index\tsource\tbackup\tuid\tgid\tmode\tsize\tsource_sha256\tbackup_sha256\tparent_device\tparent_inode\tparent_uid\tparent_gid\tparent_mode\n' > "$manifest"
  local index source source_dir backup uid gid mode size source_hash backup_hash backup_canonical
  local parent_device parent_inode parent_uid parent_gid parent_mode
  for index in "${!databases[@]}"; do
    source="${databases[$index]}"
    source_dir="$(/usr/bin/dirname "$source")"
    [[ -d "$source_dir" && ! -L "$source_dir" && "$(/usr/bin/realpath -e "$source_dir")" == "$source_dir" ]] || die "database parent is unsafe: $source_dir"
    [[ ! -e "${source}-wal" && ! -e "${source}-shm" ]] || die "database has live WAL/SHM sidecars after service stop: $source"
    backup="$backup_set/$(printf '%02d' "$((index + 1))")-${source##*/}"
    expected_backups[$index]="$backup"
    [[ ! -e "$backup" && ! -L "$backup" ]] || die "backup destination already exists: $backup"
    uid="$(/usr/bin/stat -c %u "$source")"
    gid="$(/usr/bin/stat -c %g "$source")"
    mode="$(/usr/bin/stat -c %a "$source")"
    size="$(/usr/bin/stat -c %s "$source")"
    source_hash="$(/usr/bin/sha256sum "$source" | /usr/bin/cut -d' ' -f1)"
    parent_device="$(/usr/bin/stat -c %d "$source_dir")"
    parent_inode="$(/usr/bin/stat -c %i "$source_dir")"
    parent_uid="$(/usr/bin/stat -c %u "$source_dir")"
    parent_gid="$(/usr/bin/stat -c %g "$source_dir")"
    parent_mode="$(/usr/bin/stat -c %a "$source_dir")"
    "$cp_cmd" --preserve=all --no-dereference -- "$source" "$backup"
    [[ -f "$backup" && ! -L "$backup" ]] || die "backup is not a regular file: $backup"
    backup_canonical="$(/usr/bin/realpath -e "$backup")"
    [[ "$backup_canonical" == "$backup" && "$(/usr/bin/dirname "$backup")" == "$backup_set" ]] || die "backup escaped fixed backup directory: $backup"
    backup_hash="$(/usr/bin/sha256sum "$backup" | /usr/bin/cut -d' ' -f1)"
    [[ "$source_hash" == "$backup_hash" ]] || die "byte-exact backup verification failed: $source"
    [[ "$(/usr/bin/stat -c %u "$backup")" == "$uid" && "$(/usr/bin/stat -c %g "$backup")" == "$gid" && "$(/usr/bin/stat -c %a "$backup")" == "$mode" && "$(/usr/bin/stat -c %s "$backup")" == "$size" ]] || die "backup metadata verification failed: $source"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$index" "$source" "$backup" "$uid" "$gid" "$mode" "$size" "$source_hash" "$backup_hash" "$parent_device" "$parent_inode" "$parent_uid" "$parent_gid" "$parent_mode" >> "$manifest"
  done
}

restore_backups() {
  [[ -s "$manifest" ]] || return 0
  echo "restoring pre-rollout databases from $manifest"
  local restore_failed=0 restored_count=0
  local index source source_dir backup uid gid mode size source_hash backup_hash actual_backup_hash
  local parent_device parent_inode parent_uid parent_gid parent_mode
  while IFS=$'\t' read -r index source backup uid gid mode size source_hash backup_hash parent_device parent_inode parent_uid parent_gid parent_mode; do
    [[ "$index" == "index" ]] && continue
    [[ "$index" =~ ^[0-9]+$ && "$index" == "$restored_count" ]] || { echo "invalid rollback manifest index: $index" >&2; restore_failed=1; continue; }
    [[ "$source" == "${databases[$index]:-}" && "$backup" == "${expected_backups[$index]:-}" ]] || { echo "rollback manifest path mismatch at index $index" >&2; restore_failed=1; continue; }
    source_dir="$(/usr/bin/dirname "$source")"
    [[ -f "$source" && ! -L "$source" && -f "$backup" && ! -L "$backup" ]] || { echo "unsafe rollback source or backup at index $index" >&2; restore_failed=1; continue; }
    [[ "$(/usr/bin/realpath -e "$source")" == "$source" && "$(/usr/bin/realpath -e "$backup")" == "$backup" && "$(/usr/bin/dirname "$backup")" == "$backup_set" ]] || { echo "rollback path escaped fixed inventory at index $index" >&2; restore_failed=1; continue; }
    [[ -d "$source_dir" && ! -L "$source_dir" && "$(/usr/bin/realpath -e "$source_dir")" == "$source_dir" && "$(/usr/bin/stat -c %d "$source_dir")" == "$parent_device" && "$(/usr/bin/stat -c %i "$source_dir")" == "$parent_inode" && "$(/usr/bin/stat -c %u "$source_dir")" == "$parent_uid" && "$(/usr/bin/stat -c %g "$source_dir")" == "$parent_gid" && "$(/usr/bin/stat -c %a "$source_dir")" == "$parent_mode" ]] || { echo "rollback parent metadata mismatch at index $index" >&2; restore_failed=1; continue; }
    actual_backup_hash="$(/usr/bin/sha256sum "$backup" | /usr/bin/cut -d' ' -f1)"
    [[ "$source_hash" == "$backup_hash" && "$actual_backup_hash" == "$backup_hash" && "$(/usr/bin/stat -c %u "$backup")" == "$uid" && "$(/usr/bin/stat -c %g "$backup")" == "$gid" && "$(/usr/bin/stat -c %a "$backup")" == "$mode" && "$(/usr/bin/stat -c %s "$backup")" == "$size" ]] || { echo "rollback backup metadata/hash mismatch at index $index" >&2; restore_failed=1; continue; }
    if ! "$restore_cmd" --source "$source" --backup "$backup" --uid "$uid" --gid "$gid" --mode "$mode" --size "$size" --sha256 "$source_hash" --parent-device "$parent_device" --parent-inode "$parent_inode" --parent-uid "$parent_uid" --parent-gid "$parent_gid" --parent-mode "$parent_mode"; then
      echo "descriptor-based rollback failed: $source" >&2; restore_failed=1; continue
    fi
    /usr/bin/rm -f -- "${source}-wal" "${source}-shm"
    [[ "$(/usr/bin/sha256sum "$source" | /usr/bin/cut -d' ' -f1)" == "$source_hash" && "$(/usr/bin/stat -c %u "$source")" == "$uid" && "$(/usr/bin/stat -c %g "$source")" == "$gid" && "$(/usr/bin/stat -c %a "$source")" == "$mode" && "$(/usr/bin/stat -c %s "$source")" == "$size" ]] || { echo "restored database verification failed: $source" >&2; restore_failed=1; continue; }
    restored_count=$((restored_count + 1))
  done < "$manifest"
  (( restored_count == ${#databases[@]} )) || restore_failed=1
  (( restore_failed == 0 )) || { echo "ROLLBACK INCOMPLETE; services remain stopped" >&2; return 1; }
  echo "database rollback completed with metadata and hashes verified"
}

stop_and_verify_all_services() {
  local stop_ok=1 verify_ok=1 unit active_state sub_state result exec_main_code exec_main_status
  local main_pid control_pid control_group cgroup_path cgroup_file pid pair_ok value index
  local evidence_file="$artifact_dir/containment-evidence.json" first_unit=1
  local -a remaining_pids=()
  if ! "$systemctl_cmd" stop "${units[@]}"; then stop_ok=0; fi
  printf '{\n  "createdAt": "%s",\n  "stopCommandSucceeded": %s,\n  "units": [\n' \
    "$(/usr/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$([[ "$stop_ok" == 1 ]] && echo true || echo false)" > "$evidence_file"
  for unit in "${units[@]}"; do
    if ! active_state="$("$systemctl_cmd" show "$unit" --property=ActiveState --value 2>/dev/null)" \
      || ! sub_state="$("$systemctl_cmd" show "$unit" --property=SubState --value 2>/dev/null)" \
      || ! result="$("$systemctl_cmd" show "$unit" --property=Result --value 2>/dev/null)" \
      || ! exec_main_code="$("$systemctl_cmd" show "$unit" --property=ExecMainCode --value 2>/dev/null)" \
      || ! exec_main_status="$("$systemctl_cmd" show "$unit" --property=ExecMainStatus --value 2>/dev/null)" \
      || ! main_pid="$("$systemctl_cmd" show "$unit" --property=MainPID --value 2>/dev/null)" \
      || ! control_pid="$("$systemctl_cmd" show "$unit" --property=ControlPID --value 2>/dev/null)" \
      || ! control_group="$("$systemctl_cmd" show "$unit" --property=ControlGroup --value 2>/dev/null)"; then
      verify_ok=0
      active_state=unknown; sub_state=unknown; result=unknown; exec_main_code=unknown; exec_main_status=unknown
      main_pid=unknown; control_pid=unknown; control_group=unknown
    fi
    for value in "$active_state" "$sub_state" "$result" "$exec_main_code" "$exec_main_status" "$main_pid" "$control_pid"; do
      [[ "$value" =~ ^[A-Za-z0-9_-]+$ ]] || verify_ok=0
    done
    [[ -z "$control_group" || ( "$control_group" == /* && "$control_group" != *..* && "$control_group" =~ ^/[A-Za-z0-9_@./:-]+$ ) ]] || verify_ok=0
    pair_ok=0
    [[ "$active_state" == inactive && ( "$sub_state" == dead || "$sub_state" == exited ) ]] && pair_ok=1
    [[ "$active_state" == failed && ( "$sub_state" == dead || "$sub_state" == failed ) ]] && pair_ok=1
    (( pair_ok == 1 )) || verify_ok=0
    [[ "$main_pid" == 0 && "$control_pid" == 0 ]] || verify_ok=0
    remaining_pids=()
    if [[ -n "$control_group" && "$control_group" == /* && "$control_group" != *..* ]]; then
      cgroup_path="$cgroup_root$control_group"
      if [[ -e "$cgroup_path" ]]; then
        if [[ ! -d "$cgroup_path" || -L "$cgroup_path" ]]; then
          verify_ok=0
        else
          while IFS= read -r -d '' cgroup_file; do
            while IFS= read -r pid || [[ -n "$pid" ]]; do
              [[ -z "$pid" ]] && continue
              if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then remaining_pids+=("$pid"); else verify_ok=0; fi
            done < "$cgroup_file"
          done < <(/usr/bin/find "$cgroup_path" -type f -name cgroup.procs -print0)
        fi
      fi
    fi
    (( ${#remaining_pids[@]} == 0 )) || verify_ok=0
    (( first_unit == 1 )) || printf ',\n' >> "$evidence_file"
    first_unit=0
    printf '    {"unit":"%s","ActiveState":"%s","SubState":"%s","Result":"%s","ExecMainCode":"%s","ExecMainStatus":"%s","MainPID":%s,"ControlPID":%s,"ControlGroup":"%s","remainingCgroupPids":[' \
      "$unit" "$active_state" "$sub_state" "$result" "$exec_main_code" "$exec_main_status" \
      "$([[ "$main_pid" =~ ^[0-9]+$ ]] && echo "$main_pid" || echo -1)" \
      "$([[ "$control_pid" =~ ^[0-9]+$ ]] && echo "$control_pid" || echo -1)" "$control_group" >> "$evidence_file"
    for index in "${!remaining_pids[@]}"; do
      (( index == 0 )) || printf ',' >> "$evidence_file"
      printf '%s' "${remaining_pids[$index]}" >> "$evidence_file"
    done
    printf ']}' >> "$evidence_file"
  done
  printf '\n  ]\n}\n' >> "$evidence_file"
  /usr/bin/sha256sum "$evidence_file" > "$artifact_dir/containment-evidence.sha256"
  if (( verify_ok == 0 )); then
    echo "CONTAINMENT INCOMPLETE: stop_ok=$stop_ok verify_ok=$verify_ok" >&2
    return 1
  fi
  (( stop_ok == 1 )) || echo "systemctl stop returned nonzero; containment independently verified" >&2
  echo "all selected services verified stopped"
}

on_exit() {
  status=$?
  if (( status == 0 && completed == 1 )); then return 0; fi
  set +e
  echo "rollout failed status=$status start_attempted=$start_attempted services_started=$services_started; containing services"
  containment_verified=0
  if (( stop_attempted == 1 )); then
    if stop_and_verify_all_services; then containment_verified=1; else status=1; fi
  fi
  if (( start_attempted == 0 )) && [[ -s "$manifest" ]]; then
    if (( containment_verified == 1 )); then
      restore_backups || status=1
    else
      echo "rollback skipped: stopped state could not be proven" >&2
    fi
  fi
  if (( containment_verified == 1 )); then echo "services remain stopped; operator review required"; fi
  exit "${status:-1}"
}
trap on_exit EXIT

run_as_runtime() {
  "$runuser_cmd" --user "$runtime_user" -- "$@"
}
git_check() {
  [[ "$(run_as_runtime /usr/bin/git -C "$project_dir" rev-parse --is-inside-work-tree)" == "true" ]] || die "project is not a Git worktree"
  [[ "$(run_as_runtime /usr/bin/git -C "$project_dir" branch --show-current)" == "main" ]] || die "project must be on main"
  actual_commit="$(run_as_runtime /usr/bin/git -C "$project_dir" rev-parse HEAD)"
  [[ "$actual_commit" == "$expected_commit" ]] || die "expected commit $expected_commit but found $actual_commit"
  [[ -z "$(run_as_runtime /usr/bin/git -C "$project_dir" status --porcelain --untracked-files=normal)" ]] || die "project must have a clean working tree"
}
git_check
[[ -f "$project_dir/scripts/rollout-db.ts" ]] || die "migration helper is missing from expected commit"
[[ -f "$project_dir/node_modules/tsx/dist/cli.mjs" ]] || die "tsx runtime is missing"

db_args=()
for database in "${databases[@]}"; do db_args+=(--db "$database"); done
run_db_tool() {
  run_as_runtime "$node_bin" "$project_dir/node_modules/tsx/dist/cli.mjs" "$project_dir/scripts/rollout-db.ts" "$@"
}

assert_service_active() {
  local unit="$1" active_state sub_state
  "$systemctl_cmd" is-active --quiet "$unit" || die "service is not active: $unit"
  if "$systemctl_cmd" is-failed --quiet "$unit"; then die "service is failed: $unit"; fi
  active_state="$("$systemctl_cmd" show "$unit" --property=ActiveState --value)"
  sub_state="$("$systemctl_cmd" show "$unit" --property=SubState --value)"
  [[ "$active_state" == active && "$sub_state" == running ]] || die "service is not stably running: $unit state=$active_state/$sub_state"
}

declare -A restart_baseline=()
for unit in "${units[@]}"; do
  assert_service_active "$unit"
  restart_baseline[$unit]="$("$systemctl_cmd" show "$unit" --property=NRestarts --value)"
  [[ "${restart_baseline[$unit]}" =~ ^[0-9]+$ ]] || die "invalid NRestarts for $unit"
done
run_db_tool inspect --evidence - "${db_args[@]}" > "$artifact_dir/preflight-evidence.json"
/usr/bin/sha256sum "$artifact_dir/preflight-evidence.json" > "$artifact_dir/preflight-evidence.sha256"

echo "stopping all services"
stop_attempted=1
stop_and_verify_all_services || die "CONTAINMENT INCOMPLETE during primary stop"

git_check
run_db_tool inspect --evidence - "${db_args[@]}" > "$artifact_dir/stopped-evidence.json"

echo "backing up all databases"
backup_databases
/usr/bin/sha256sum "$manifest" > "$artifact_dir/backup-manifest.sha256"

echo "migrating databases using pre-staged commit $expected_commit"
git_check
run_db_tool migrate --evidence - "${db_args[@]}" > "$artifact_dir/migration-evidence.json"
echo "validating migrated databases"
run_db_tool validate --evidence - "${db_args[@]}" > "$artifact_dir/validation-evidence.json"
/usr/bin/sha256sum "$artifact_dir/migration-evidence.json" "$artifact_dir/validation-evidence.json" > "$artifact_dir/migration-evidence.sha256"

echo "starting all services"
journal_since="$(/usr/bin/date -u '+%Y-%m-%d %H:%M:%S UTC')"
start_attempted=1
"$systemctl_cmd" reset-failed "${units[@]}"
"$systemctl_cmd" start "${units[@]}"
for unit in "${units[@]}"; do assert_service_active "$unit"; done
services_started=1
if (( smoke_delay > 0 )); then /usr/bin/sleep "$smoke_delay"; fi
journal_args=()
for unit in "${units[@]}"; do journal_args+=(-u "$unit"); done
startup_errors="$("$journalctl_cmd" --since "$journal_since" --priority err --no-pager "${journal_args[@]}" 2>&1)" || die "journal smoke command failed"
[[ -z "$startup_errors" ]] || die "startup journal smoke found errors: $startup_errors"
for unit in "${units[@]}"; do
  assert_service_active "$unit"
  current_restarts="$("$systemctl_cmd" show "$unit" --property=NRestarts --value)"
  [[ "$current_restarts" =~ ^[0-9]+$ && "$current_restarts" == "${restart_baseline[$unit]}" ]] || die "service restarted or crash-looped during smoke: $unit"
done
run_db_tool validate --evidence - "${db_args[@]}" > "$artifact_dir/post-start-evidence.json"

completed=1
echo "rollout completed commit=$expected_commit artifacts=$artifact_dir"
