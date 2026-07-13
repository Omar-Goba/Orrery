#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE_IMAGE="alpine:3.21"
FORMAT_VERSION="1"

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$ROOT")}"
OUTPUT_DIR=""
DRY_RUN=0
FORCE=0
NO_RESTART=0
RESTART_NEEDED=0
PARTIAL_DIR=""
RUNNING_SERVICES=()
RUNNING_COUNTS=()

usage() {
  cat <<'EOF'
Usage:
  ./scripts/docker-volumes.sh backup [options]
  ./scripts/docker-volumes.sh restore <backup-directory> [options]
  ./scripts/docker-volumes.sh list [options]

Options:
  --project-name NAME  Compose project name (default: repository directory name)
  --output-dir PATH    Backup root (default: hub auxilary/docker-volume-backups)
  --dry-run            Validate the bundle and print actions without changing Docker or files
  --no-restart         Leave a running stack stopped after backup
  --force              Allow restore to replace existing non-empty target volumes
  -h, --help           Show this help

Backup stops a running Compose project, archives both persistent volumes, verifies
the archives, and restarts the project unless --no-restart is set. Restore never
starts containers. Use `docker compose -p NAME up -d` after restoring.
EOF
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

note() {
  printf '%s\n' "$1"
}

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

default_output_dir() {
  local common_dir hub_dir
  common_dir="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
    || die "cannot locate the repository hub"
  hub_dir="$(dirname "$common_dir")"
  printf '%s/auxilary/docker-volume-backups' "$hub_dir"
}

volume_name() {
  local logical="$1" labels expected matches
  labels="$(docker volume ls -q \
    --filter "label=com.docker.compose.project=$PROJECT_NAME" \
    --filter "label=com.docker.compose.volume=$logical")"
  if [[ -n "$labels" ]]; then
    matches="$(printf '%s\n' "$labels" | wc -l | tr -d ' ')"
    [[ "$matches" == "1" ]] || die "multiple volumes match project '$PROJECT_NAME' and logical volume '$logical'"
    printf '%s' "$labels"
    return
  fi

  expected="${PROJECT_NAME}_${logical}"
  docker volume inspect "$expected" >/dev/null 2>&1 \
    || die "volume '$expected' does not exist; start the Compose project once before backing it up"
  printf '%s' "$expected"
}

project_container_ids() {
  docker ps -aq --filter "label=com.docker.compose.project=$PROJECT_NAME"
}

project_running_ids() {
  docker ps -q --filter "label=com.docker.compose.project=$PROJECT_NAME"
}

capture_running_services() {
  local count service declared candidate is_declared running_services grouped_services
  RUNNING_SERVICES=()
  RUNNING_COUNTS=()
  declared="$(docker compose --project-name "$PROJECT_NAME" --project-directory "$ROOT" config --services)" \
    || die "could not read declared Compose services for '$PROJECT_NAME'"
  running_services="$(docker ps \
    --filter "label=com.docker.compose.project=$PROJECT_NAME" \
    --filter "label=com.docker.compose.oneoff=False" \
    --format '{{.Label "com.docker.compose.service"}}')" \
    || die "could not inspect running Compose services for '$PROJECT_NAME'"
  grouped_services="$(printf '%s\n' "$running_services" | sort | uniq -c)" \
    || die "could not group running Compose services for '$PROJECT_NAME'"
  while read -r count service; do
    [[ -n "$service" ]] || continue
    is_declared=0
    while IFS= read -r candidate; do
      if [[ "$candidate" == "$service" ]]; then
        is_declared=1
        break
      fi
    done <<< "$declared"
    if [[ "$is_declared" == "1" ]]; then
      RUNNING_SERVICES+=("$service")
      RUNNING_COUNTS+=("$count")
    else
      printf 'warning: running orphan service %s will be removed and not restarted\n' "$service" >&2
    fi
  done <<< "$grouped_services"
}

restart_on_exit() {
  local status=$? index
  local command=(docker compose --project-name "$PROJECT_NAME" --project-directory "$ROOT" up -d)
  trap - EXIT INT TERM
  if [[ -n "$PARTIAL_DIR" && -d "$PARTIAL_DIR" ]]; then
    rm -rf "$PARTIAL_DIR" || printf 'warning: could not remove partial backup %s\n' "$PARTIAL_DIR" >&2
  fi
  if [[ "$RESTART_NEEDED" == "1" ]]; then
    note "Restarting Compose project '$PROJECT_NAME'..."
    for ((index = 0; index < ${#RUNNING_SERVICES[@]}; index++)); do
      command+=(--scale "${RUNNING_SERVICES[$index]}=${RUNNING_COUNTS[$index]}")
    done
    command+=("${RUNNING_SERVICES[@]}")
    if ! "${command[@]}"; then
      printf 'error: backup finished, but Compose restart failed\n' >&2
      status=1
    fi
  fi
  exit "$status"
}

checksum_write() {
  local directory="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$directory" && sha256sum orrery_data.tar.gz minio_data.tar.gz > SHA256SUMS)
  else
    (cd "$directory" && shasum -a 256 orrery_data.tar.gz minio_data.tar.gz > SHA256SUMS)
  fi
}

checksum_verify() {
  local directory="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$directory" && sha256sum -c SHA256SUMS)
  else
    (cd "$directory" && shasum -a 256 -c SHA256SUMS)
  fi
}

validate_bundle() {
  local bundle="$1" version
  [[ -d "$bundle" ]] || die "backup directory not found: $bundle"
  [[ -f "$bundle/manifest.txt" ]] || die "missing manifest.txt in $bundle"
  [[ -f "$bundle/SHA256SUMS" ]] || die "missing SHA256SUMS in $bundle"
  [[ -f "$bundle/orrery_data.tar.gz" ]] || die "missing orrery_data.tar.gz in $bundle"
  [[ -f "$bundle/minio_data.tar.gz" ]] || die "missing minio_data.tar.gz in $bundle"
  [[ "$(wc -l < "$bundle/SHA256SUMS" | tr -d ' ')" == "2" ]] \
    || die "SHA256SUMS must contain exactly two entries"
  awk '$2 == "orrery_data.tar.gz" { count++ } END { exit count == 1 ? 0 : 1 }' "$bundle/SHA256SUMS" \
    || die "SHA256SUMS must contain exactly one orrery_data.tar.gz entry"
  awk '$2 == "minio_data.tar.gz" { count++ } END { exit count == 1 ? 0 : 1 }' "$bundle/SHA256SUMS" \
    || die "SHA256SUMS must contain exactly one minio_data.tar.gz entry"
  version=""
  while IFS='=' read -r key value; do
    if [[ "$key" == "format_version" ]]; then
      version="$value"
    fi
  done < "$bundle/manifest.txt"
  [[ "$version" == "$FORMAT_VERSION" ]] \
    || die "unsupported backup format '${version:-missing}'"
  checksum_verify "$bundle"
  gzip -t "$bundle/orrery_data.tar.gz"
  gzip -t "$bundle/minio_data.tar.gz"
}

archive_volume() {
  local volume="$1" logical="$2" destination="$3"
  run docker run --rm \
    --mount "type=volume,src=$volume,dst=/source,readonly" \
    --mount "type=bind,src=$destination,dst=/backup" \
    "$ARCHIVE_IMAGE" \
    tar -czf "/backup/${logical}.tar.gz" -C /source .
}

backup() {
  local timestamp partial final running remaining attached volume orrery_volume minio_volume

  orrery_volume="$(volume_name orrery_data)"
  minio_volume="$(volume_name minio_data)"

  running="$(project_running_ids)"
  if [[ -n "$running" ]]; then
    capture_running_services
    note "Stopping Compose project '$PROJECT_NAME' for a consistent backup..."
    if [[ "$DRY_RUN" == "0" && "$NO_RESTART" == "0" && ${#RUNNING_SERVICES[@]} -gt 0 ]]; then
      RESTART_NEEDED=1
      trap restart_on_exit EXIT INT TERM
    fi
    run docker compose --project-name "$PROJECT_NAME" --project-directory "$ROOT" down --remove-orphans
    if [[ "$DRY_RUN" == "0" ]]; then
      remaining="$(project_running_ids)"
      [[ -z "$remaining" ]] \
        || die "project '$PROJECT_NAME' still has running containers after Compose shutdown"
    fi
  fi

  for volume in "$orrery_volume" "$minio_volume"; do
    attached="$(docker ps -q --filter "volume=$volume")"
    if [[ -n "$attached" ]]; then
      if [[ "$DRY_RUN" == "1" ]]; then
        note "Would verify '$volume' is detached after Compose shutdown."
      else
        die "volume '$volume' is mounted by a running container"
      fi
    fi
  done

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  final="$OUTPUT_DIR/$timestamp"
  partial="$OUTPUT_DIR/.${timestamp}.partial"
  [[ ! -e "$final" && ! -e "$partial" ]] || die "backup destination already exists for timestamp $timestamp"
  PARTIAL_DIR="$partial"
  trap restart_on_exit EXIT INT TERM

  note "Backing up '$orrery_volume' and '$minio_volume'..."
  run mkdir -p "$partial"
  if [[ "$DRY_RUN" == "0" ]]; then
    chmod 700 "$partial"
  fi
  archive_volume "$orrery_volume" orrery_data "$partial"
  archive_volume "$minio_volume" minio_data "$partial"

  if [[ "$DRY_RUN" == "0" ]]; then
    cat > "$partial/manifest.txt" <<EOF
format_version=$FORMAT_VERSION
created_at=$timestamp
source_project=$PROJECT_NAME
orrery_volume=$orrery_volume
minio_volume=$minio_volume
archive_image=$ARCHIVE_IMAGE
EOF
    checksum_write "$partial"
    validate_bundle "$partial"
    chmod 600 "$partial"/*
    mv "$partial" "$final"
    PARTIAL_DIR=""
    note "Backup complete: $final"
  else
    note "Dry run complete; no containers, volumes, or files were changed."
  fi
}

create_volume() {
  local logical="$1" name
  name="${PROJECT_NAME}_${logical}"
  run docker volume create \
    --label "com.docker.compose.project=$PROJECT_NAME" \
    --label "com.docker.compose.volume=$logical" \
    "$name" >/dev/null
  printf '%s' "$name"
}

volume_is_empty() {
  local volume="$1"
  docker run --rm \
    --mount "type=volume,src=$volume,dst=/volume,readonly" \
    "$ARCHIVE_IMAGE" \
    sh -c 'entries="$(ls -A /volume)" || exit 2; test -z "$entries"'
}

preflight_restore_volume() {
  local logical="$1" name attached empty_status
  name="${PROJECT_NAME}_${logical}"
  if docker volume inspect "$name" >/dev/null 2>&1; then
    attached="$(docker ps -aq --filter "volume=$name")"
    if [[ -n "$attached" ]]; then
      if [[ "$DRY_RUN" == "1" ]]; then
        note "Would require containers attached to '$name' to be removed before restore."
      else
        die "target volume '$name' is attached to a container"
      fi
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
      note "Would inspect '$name' for existing data before restore."
      return
    fi
    if volume_is_empty "$name"; then
      empty_status=0
    else
      empty_status=$?
    fi
    case "$empty_status" in
      0) ;;
      1)
        [[ "$FORCE" == "1" ]] \
          || die "target volume '$name' is not empty; rerun with --force to replace it"
        ;;
      *) die "could not inspect target volume '$name'" ;;
    esac
  fi
}

prepare_restore_volume() {
  local logical="$1" name
  name="${PROJECT_NAME}_${logical}"
  if docker volume inspect "$name" >/dev/null 2>&1 && [[ "$FORCE" == "1" ]]; then
    run docker volume rm "$name" >/dev/null
  fi
  if ! docker volume inspect "$name" >/dev/null 2>&1; then
    create_volume "$logical"
    return
  fi
  printf '%s' "$name"
}

restore_archive() {
  local archive="$1" volume="$2" bundle="$3"
  run docker run --rm \
    --mount "type=volume,src=$volume,dst=/target" \
    --mount "type=bind,src=$bundle,dst=/backup,readonly" \
    "$ARCHIVE_IMAGE" \
    tar -xzf "/backup/$archive" -C /target
}

restore() {
  local bundle="$1" containers orrery_volume minio_volume
  bundle="$(cd "$bundle" 2>/dev/null && pwd)" || die "backup directory not found: $1"
  validate_bundle "$bundle"

  containers="$(project_container_ids)"
  if [[ "$DRY_RUN" != "1" ]]; then
    [[ -z "$containers" ]] \
      || die "Compose project '$PROJECT_NAME' still has containers; run 'docker compose -p $PROJECT_NAME down' first"
  fi

  preflight_restore_volume orrery_data
  preflight_restore_volume minio_data

  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ -n "$containers" ]]; then
      note "Would require Compose project '$PROJECT_NAME' to be down before restore."
    fi
    if [[ "$FORCE" == "1" ]]; then
      note "Would replace any existing target volumes after full preflight."
    fi
    note "Would restore $bundle into '${PROJECT_NAME}_orrery_data' and '${PROJECT_NAME}_minio_data'."
    note "Dry run complete; no volumes were changed."
    return
  fi

  orrery_volume="$(prepare_restore_volume orrery_data)"
  minio_volume="$(prepare_restore_volume minio_data)"
  restore_archive orrery_data.tar.gz "$orrery_volume" "$bundle"
  restore_archive minio_data.tar.gz "$minio_volume" "$bundle"

  note "Restore complete. Start it with:"
  note "  docker compose -p $PROJECT_NAME up -d"
}

list_backups() {
  local found=0 directory
  if [[ ! -d "$OUTPUT_DIR" ]]; then
    note "No backups found in $OUTPUT_DIR"
    return
  fi
  for directory in "$OUTPUT_DIR"/*; do
    [[ -d "$directory" && -f "$directory/manifest.txt" ]] || continue
    found=1
    printf '%s\n' "$directory"
  done
  [[ "$found" == "1" ]] || note "No backups found in $OUTPUT_DIR"
}

main() {
  local command="${1:-}" bundle=""
  [[ -n "$command" ]] || { usage; exit 1; }
  shift || true

  case "$command" in
    help|-h|--help) usage; exit 0 ;;
  esac

  if [[ "$command" == "restore" ]]; then
    bundle="${1:-}"
    [[ -n "$bundle" && "$bundle" != -* ]] || die "restore requires a backup directory"
    shift
  fi

  while (($#)); do
    case "$1" in
      --project-name)
        [[ $# -ge 2 ]] || die "--project-name requires a value"
        PROJECT_NAME="$2"
        shift 2
        ;;
      --output-dir)
        [[ $# -ge 2 ]] || die "--output-dir requires a value"
        OUTPUT_DIR="$2"
        shift 2
        ;;
      --dry-run) DRY_RUN=1; shift ;;
      --no-restart) NO_RESTART=1; shift ;;
      --force) FORCE=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  require_command docker
  require_command git
  require_command gzip
  docker info >/dev/null 2>&1 || die "Docker daemon is not available"
  [[ -n "$OUTPUT_DIR" ]] || OUTPUT_DIR="$(default_output_dir)"
  OUTPUT_DIR="${OUTPUT_DIR/#\~/$HOME}"

  case "$command" in
    backup) backup ;;
    restore) restore "$bundle" ;;
    list) list_backups ;;
    *) die "unknown command: $command" ;;
  esac
}

main "$@"
