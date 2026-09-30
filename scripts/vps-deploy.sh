#!/usr/bin/env bash
# Executado NA VPS pelos workflows (via SSH). A VPS nunca compila: só faz pull da imagem do GHCR.
# Uso: echo "$GHCR_TOKEN" | RELEASE=<tag> APP_PORT=<porta> GHCR_USER=<user> bash vps-deploy.sh
set -euo pipefail

APP_DIR="/opt/para2026"
CONTAINER="para2026-whatsapp"
IMAGE="ghcr.io/fernandinhomartins40/para2026-whatsapp"
COMPOSE="docker-compose -f docker-compose.vps.yml"
: "${RELEASE:?RELEASE obrigatório}" "${APP_PORT:?APP_PORT obrigatório}" "${GHCR_USER:?GHCR_USER obrigatório}"

# Token do GHCR chega pelo stdin (não aparece na lista de processos)
read -r GHCR_TOKEN

cd "$APP_DIR"
touch .env

set_env_var() {
  sed -i "/^$1=/d" .env
  echo "$1=$2" >> .env
}

RELEASE_ANTERIOR=$(grep -E '^RELEASE=' .env | tail -1 | cut -d= -f2- || true)
echo "Release anterior: ${RELEASE_ANTERIOR:-<nenhuma>} -> nova: ${RELEASE}"

echo "=== Verificando porta ${APP_PORT} ==="
OUTROS=$(docker ps --filter "publish=${APP_PORT}" --format '{{.Names}}' | grep -vx "$CONTAINER" || true)
if [ -n "$OUTROS" ]; then
  echo "ERRO: porta ${APP_PORT} já usada por: ${OUTROS}. Troque APP_PORT no workflow."
  exit 1
fi
if command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :${APP_PORT}" | grep -q . \
   && ! docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}' | grep -q .; then
  echo "ERRO: porta ${APP_PORT} já usada por um processo fora do Docker:"
  ss -ltnp "sport = :${APP_PORT}" || true
  exit 1
fi
echo "Porta ${APP_PORT} livre"

set_env_var APP_PORT "$APP_PORT"
set_env_var RELEASE "$RELEASE"

# Login isolado nesta pasta: não mexe nas credenciais Docker das outras aplicações da VPS
export DOCKER_CONFIG="$APP_DIR/.docker"
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

echo "=== Baixando ${IMAGE}:${RELEASE} ==="
$COMPOSE pull whatsapp
docker logout ghcr.io >/dev/null 2>&1 || true

echo "=== Subindo container ==="
$COMPOSE up -d --no-build --force-recreate whatsapp

for i in $(seq 1 30); do
  STATUS=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || echo missing)
  echo "[$i/30] ${CONTAINER}: ${STATUS}"
  [ "$STATUS" = "healthy" ] && break
  if [ "$i" = 30 ]; then
    echo "ERRO: container não ficou saudável"
    docker logs "$CONTAINER" --tail=100 || true
    exit 1
  fi
  sleep 5
done

curl -fsS "http://localhost:${APP_PORT}/health" && echo
$COMPOSE ps

# Limpeza restrita a ESTA imagem (VPS compartilhada: nunca `prune -a`).
# Mantém a release atual e a anterior (rede de rollback).
echo "=== Limpando versões antigas da imagem ==="
docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep "^${IMAGE}:" \
  | grep -v -e ":latest$" -e ":buildcache$" -e ":${RELEASE}$" \
  | { if [ -n "$RELEASE_ANTERIOR" ]; then grep -v ":${RELEASE_ANTERIOR}$"; else cat; fi; } \
  | xargs -r docker rmi 2>/dev/null || true
docker image prune -f >/dev/null || true

echo "=== Deploy concluído (RELEASE=${RELEASE}) ==="
