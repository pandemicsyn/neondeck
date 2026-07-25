#!/usr/bin/env bash

set -Eeuo pipefail

package_spec="${1:-${NEONDECK_QA_PACKAGE:-neondeck@latest}}"
qa_root="${NEONDECK_QA_ROOT:-${HOME}/.local/state/neondeck-npm-qa}"
qa_port="${NEONDECK_QA_PORT:-13583}"
health_timeout_seconds="${NEONDECK_QA_HEALTH_TIMEOUT_SECONDS:-20}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
run_dir="${qa_root}/runs/${run_id}"
install_prefix="${run_dir}/install"
runtime_home="${run_dir}/home"
server_log="${run_dir}/server.log"
server_pid=""

log() {
  printf '\n[neondeck-npm-qa] %s\n' "$*"
}

fail() {
  printf '\n[neondeck-npm-qa] ERROR: %s\n' "$*" >&2
  printf '[neondeck-npm-qa] Run artifacts: %s\n' "$run_dir" >&2
  exit 1
}

stop_server() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  server_pid=""
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is missing: $1"
}

validate_environment() {
  local node_major

  node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
  ((node_major >= 26)) ||
    fail "Node 26 or newer is required; found $(node --version)."
  [[ "$qa_port" =~ ^[0-9]+$ ]] || fail "NEONDECK_QA_PORT must be an integer."
  ((qa_port >= 1 && qa_port <= 65535)) ||
    fail "NEONDECK_QA_PORT must be between 1 and 65535."
  [[ "$health_timeout_seconds" =~ ^[0-9]+$ ]] ||
    fail "NEONDECK_QA_HEALTH_TIMEOUT_SECONDS must be an integer."
  ((health_timeout_seconds >= 1)) ||
    fail "NEONDECK_QA_HEALTH_TIMEOUT_SECONDS must be positive."
}

validate_generated_home() {
  node --input-type=module - "$runtime_home" <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.argv[2];
const required = [
  '.env',
  'config.json',
  'mcp.json',
  'repos.json',
  'dashboard.json',
  'dashboard.schema.json',
  'SOUL.md',
  'data/neondeck.db',
  'data/flue.db',
];

for (const path of required) {
  if (!existsSync(join(home, path))) {
    throw new Error(`Setup did not create ${path}`);
  }
}

const readJson = (path) =>
  JSON.parse(readFileSync(join(home, path), 'utf8'));
const config = readJson('config.json');
const repos = readJson('repos.json');
const mcp = readJson('mcp.json');
const dashboard = readJson('dashboard.json');

if (!Number.isInteger(config.version) || config.version < 1) {
  throw new Error('config.json has no valid version');
}
if (!/^[A-Za-z0-9_-]{32,}$/.test(config.localApi?.token ?? '')) {
  throw new Error('config.json has no valid local API token');
}
if (!Array.isArray(repos.repos)) {
  throw new Error('repos.json has no repos array');
}
if (!mcp.servers || typeof mcp.servers !== 'object') {
  throw new Error('mcp.json has no servers object');
}
if (!dashboard || typeof dashboard !== 'object') {
  throw new Error('dashboard.json is invalid');
}
NODE
}

wait_for_health() {
  local health_url="http://127.0.0.1:${qa_port}/api/health"
  local deadline=$((SECONDS + health_timeout_seconds))

  while ((SECONDS < deadline)); do
    if curl --fail --silent --show-error "$health_url" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -n "$server_pid" ]] && ! kill -0 "$server_pid" 2>/dev/null; then
      return 1
    fi
    sleep 1
  done
  return 1
}

main() {
  require_command node
  require_command npm
  require_command curl
  validate_environment
  mkdir -p "$run_dir"
  trap stop_server EXIT INT TERM

  log "Resolving published package"
  expected_version="$(npm view "$package_spec" version)"
  printf 'package   %s\n' "$package_spec"
  printf 'registry  %s\n' "$expected_version"
  printf 'node      %s\n' "$(node --version)"
  printf 'npm       %s\n' "$(npm --version)"
  printf 'run       %s\n' "$run_dir"

  log "Installing from the npm registry"
  npm install --global --prefix "$install_prefix" "$package_spec"

  package_root="${install_prefix}/lib/node_modules/neondeck"
  cli="${install_prefix}/bin/neondeck"
  [[ -x "$cli" ]] || fail "The installed package did not provide the neondeck CLI."
  installed_version="$(
    cd "$package_root"
    node -p "require('./package.json').version"
  )"
  [[ "$installed_version" == "$expected_version" ]] ||
    fail "Registry resolved $expected_version but npm installed $installed_version."

  log "Running the installed package setup command"
  npm --prefix "$package_root" run setup -- --home "$runtime_home" --json
  validate_generated_home

  log "Validating the installed CLI against generated state"
  "$cli" --home "$runtime_home" --json status >"$run_dir/status.json"
  "$cli" --home "$runtime_home" --json db status >"$run_dir/db-status.json"

  if curl --silent --max-time 1 \
    "http://127.0.0.1:${qa_port}/api/health" >/dev/null 2>&1; then
    fail "Port $qa_port already has a healthy HTTP service."
  fi

  log "Booting the installed release"
  NEONDECK_DISABLE_SCHEDULER=1 \
    "$cli" --home "$runtime_home" serve --port "$qa_port" \
    >"$server_log" 2>&1 &
  server_pid=$!

  if ! wait_for_health; then
    printf '\nServer log:\n' >&2
    tail -n 80 "$server_log" >&2 || true
    fail "The installed release did not become healthy."
  fi

  curl --fail --silent --show-error \
    "http://127.0.0.1:${qa_port}/" >"$run_dir/index.html"
  curl --fail --silent --show-error \
    "http://127.0.0.1:${qa_port}/api/runtime/status" \
    >"$run_dir/runtime-status.json"

  node --input-type=module - "$run_dir/runtime-status.json" <<'NODE'
import { readFileSync } from 'node:fs';

const status = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const skills = status.checks?.find((check) => check.id === 'skills');
if (skills?.ok !== true || !(status.counts?.activeSkills >= 7)) {
  throw new Error('The installed release did not load its built-in skills');
}
NODE

  stop_server
  trap - EXIT INT TERM

  log "Published npm release passed"
  printf 'version   %s\n' "$installed_version"
  printf 'home      %s\n' "$runtime_home"
  printf 'artifacts %s\n' "$run_dir"
}

main "$@"
