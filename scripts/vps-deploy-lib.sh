#!/usr/bin/env bash
# Funções usadas pelos workflows de deploy na VPS (deploy.yml e redeploy.yml). A VPS nunca compila: só faz pull.

APP_DIR="${APP_DIR:-/opt/para2026}"
CONTAINER="${CONTAINER:-para2026-whatsapp}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.vps.yml}"

# Clona (primeira vez) ou sincroniza o código em $APP_DIR com a branch indicada.
# O token vai inline na URL para NÃO ficar gravado no .git/config. O .env é preservado.
sync_repo() {
  local branch="$1"
  local remote="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
  if [ ! -d "$APP_DIR/.git" ]; then
    echo "Primeiro deploy: clonando em $APP_DIR"
    mkdir -p "$APP_DIR"
    git clone --branch "$branch" --single-branch "$remote" "$APP_DIR"
    git -C "$APP_DIR" remote set-url origin "https://github.com/${GITHUB_REPOSITORY}.git"
  fi
  cd "$APP_DIR"
  [ -f .env ] && cp .env .env.backup
  git fetch --prune --force "$remote" "+refs/heads/${branch}:refs/remotes/origin/${branch}"
  git reset --hard "origin/${branch}"
  git clean -fdx -e .env -e .env.backup
  [ ! -f .env ] && [ -f .env.backup ] && cp .env.backup .env
  touch .env
  echo "Código no commit: $(git rev-parse --short HEAD)"
}

# Define (ou substitui) uma variável no .env — sempre exatamente uma linha por chave.
set_env_var() {
  local key="$1" value="$2"
  sed -i "/^${key}=/d" .env
  echo "${key}=${value}" >> .env
}

get_env_var() {
  grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true
}

# Grava porta e senha opcional. Secrets vazios mantêm o que já estiver no .env da VPS.
write_env() {
  set_env_var APP_PORT "${APP_PORT}"
  if [ -n "${BASIC_AUTH_USER:-}" ] && [ -n "${BASIC_AUTH_PASS:-}" ]; then
    set_env_var BASIC_AUTH_USER "${BASIC_AUTH_USER}"
    set_env_var BASIC_AUTH_PASS "${BASIC_AUTH_PASS}"
  fi
}

# Falha se a porta já estiver em uso por OUTRO container/processo (VPS compartilhada).
check_port() {
  local port="$1"
  local owners
  owners=$(docker ps --filter "publish=${port}" --format '{{.Names}}' | grep -vx "${CONTAINER}" || true)
  if [ -n "$owners" ]; then
    echo "ERRO: porta ${port} já está em uso pelo(s) container(s): ${owners}"
    echo "Troque a variável APP_PORT no workflow para outra porta alta livre."
    exit 1
  fi
  if command -v ss >/dev/null 2>&1 \
     && ss -ltnH "sport = :${port}" | grep -q . \
     && ! docker ps --filter "name=^${CONTAINER}$" --filter "publish=${port}" --format '{{.Names}}' | grep -q .; then
    echo "ERRO: porta ${port} já está em uso por um processo fora do Docker:"
    ss -ltnp "sport = :${port}" || true
    exit 1
  fi
  echo "Porta ${port} OK"
}

wait_healthy() {
  local tries="${1:-30}" interval="${2:-5}" status
  for i in $(seq 1 "$tries"); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || echo "missing")
    echo "[$i/$tries] ${CONTAINER}: ${status}"
    [ "$status" = "healthy" ] && return 0
    sleep "$interval"
  done
  echo "ERRO: ${CONTAINER} não ficou saudável"
  docker logs "$CONTAINER" --tail=100 || true
  return 1
}

final_check() {
  local port="$1"
  curl -fsS "http://localhost:${port}/health" && echo
  docker-compose -f "$COMPOSE_FILE" ps
  local ip
  ip=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  echo "=== Aplicação disponível em: http://${ip}:${port} ==="
}
