#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_EXAMPLE_FILE="${PROJECT_ROOT}/.env.example"
ENV_FILE="${PROJECT_ROOT}/.env"
LOG_FILE="${PROJECT_ROOT}/data/install-dev.log"

DEV_PID=""

cleanup() {
  if [[ -n "${DEV_PID}" ]] && kill -0 "${DEV_PID}" >/dev/null 2>&1; then
    kill "${DEV_PID}" >/dev/null 2>&1 || true
    wait "${DEV_PID}" 2>/dev/null || true
  fi
}

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "[install] missing command: ${cmd}" >&2
    exit 1
  fi
}

wait_for_health() {
  local url="$1"
  local attempts="$2"
  local i=1
  while (( i <= attempts )); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    ((i++))
  done
  return 1
}

trap cleanup EXIT

echo "[install] project root: ${PROJECT_ROOT}"

require_cmd node
require_cmd npm
require_cmd curl

mkdir -p "${PROJECT_ROOT}/data"

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ ! -f "${ENV_EXAMPLE_FILE}" ]]; then
    echo "[install] missing .env.example, cannot initialize .env" >&2
    exit 1
  fi
  cp "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
  echo "[install] created .env from .env.example"
else
  echo "[install] .env already exists, keep current config"
fi

echo "[install] installing npm dependencies..."
(
  cd "${PROJECT_ROOT}"
  npm install
)

HOST="127.0.0.1"
PORT="3000"
if [[ -f "${ENV_FILE}" ]]; then
  source "${ENV_FILE}" || true
  HOST="${HOST:-127.0.0.1}"
  PORT="${PORT:-3000}"
fi
HEALTH_URL="http://${HOST}:${PORT}/health"

if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
  echo "[install] health check passed (service already running): ${HEALTH_URL}"
  exit 0
fi

echo "[install] starting temporary dev server for health check..."
CURRENT_DIR="$(pwd)"
cd "${PROJECT_ROOT}"
npm run dev >"${LOG_FILE}" 2>&1 &
DEV_PID=$!
cd "${CURRENT_DIR}"

if [[ -z "${DEV_PID}" ]]; then
  echo "[install] failed to start temporary dev server" >&2
  exit 1
fi

if wait_for_health "${HEALTH_URL}" 45; then
  echo "[install] health check passed: ${HEALTH_URL}"
  echo "[install] install workflow succeeded"
else
  echo "[install] health check failed: ${HEALTH_URL}" >&2
  echo "[install] recent dev log:" >&2
  tail -n 80 "${LOG_FILE}" >&2 || true
  exit 1
fi
