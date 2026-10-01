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
# Client ID do Google (público). Vazio no workflow = mantém o que já estiver no .env da VPS.
if [ -n "${GOOGLE_CLIENT_ID:-}" ]; then set_env_var GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID"; fi

# ===== nginx do host + HTTPS (Let's Encrypt) para o subdomínio, se DOMAIN foi informado =====
# Cria SÓ o arquivo deste app (sites-available/para2026); nunca altera os sites das outras aplicações.
# Toda mudança passa por `nginx -t` antes do reload; se falhar, o arquivo é removido/restaurado.
setup_nginx() {
  local domain="$1" port="$2"
  local site="/etc/nginx/sites-available/para2026"
  local link="/etc/nginx/sites-enabled/para2026"
  local webroot="/var/www/para2026-acme"
  local cert="/etc/letsencrypt/live/${domain}/fullchain.pem"
  mkdir -p "$webroot"

  apply_site() { # $1 = conteúdo do arquivo
    local backup=""
    [ -f "$site" ] && backup=$(cat "$site")
    printf '%s\n' "$1" > "$site"
    ln -sf "$site" "$link"
    if nginx -t 2>&1; then
      systemctl reload nginx
    else
      echo "ERRO: configuração nginx inválida, desfazendo"
      if [ -n "$backup" ]; then printf '%s\n' "$backup" > "$site"; else rm -f "$site" "$link"; fi
      nginx -t && systemctl reload nginx
      exit 1
    fi
  }

  local acme="    location /.well-known/acme-challenge/ { root ${webroot}; }"
  local http_only="server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
${acme}
    location / { return 301 https://\$host\$request_uri; }
}"

  if [ ! -f "$cert" ]; then
    echo "=== Emitindo certificado para ${domain} ==="
    apply_site "$http_only"
    certbot certonly --webroot -w "$webroot" -d "$domain" --non-interactive --agree-tos \
      --register-unsafely-without-email --keep-until-expiring --deploy-hook "systemctl reload nginx"
  fi

  echo "=== Configurando nginx: https://${domain} -> 127.0.0.1:${port} ==="
  apply_site "${http_only}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${domain};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 180s;
    }
}"
}

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
if [ -n "${DOMAIN:-}" ]; then
  setup_nginx "$DOMAIN" "$APP_PORT"
  # O reload do nginx troca os workers em segundo plano: tenta algumas vezes antes de avisar.
  ok=0
  for i in 1 2 3 4 5 6; do
    sleep 3
    if curl -fsS --max-time 10 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/health"; then ok=1; echo " <- OK via https://${DOMAIN}"; break; fi
  done
  [ "$ok" = 1 ] || echo "AVISO: https://${DOMAIN} ainda não respondeu com o certificado certo"
fi

echo "=== Limpando versões antigas da imagem ==="
docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep "^${IMAGE}:" \
  | grep -v -e ":latest$" -e ":buildcache$" -e ":${RELEASE}$" \
  | { if [ -n "$RELEASE_ANTERIOR" ]; then grep -v ":${RELEASE_ANTERIOR}$"; else cat; fi; } \
  | xargs -r docker rmi 2>/dev/null || true
docker image prune -f >/dev/null || true

echo "=== Deploy concluído (RELEASE=${RELEASE}) ==="
