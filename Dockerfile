# Imagem final da aplicação: junta a base (Chromium) com o node_modules já compilado.
# BASE_IMAGE e DEPS_IMAGE são passados pelo workflow com a tag do commit.
ARG BASE_IMAGE=ghcr.io/fernandinhomartins40/para2026-whatsapp-base:latest
ARG DEPS_IMAGE=ghcr.io/fernandinhomartins40/para2026-whatsapp-deps:latest

FROM ${DEPS_IMAGE} AS deps

FROM ${BASE_IMAGE}

ENV NODE_ENV=production \
    TZ=America/Sao_Paulo \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DATA_DIR=/app/data \
    PORT=3000 \
    HEADLESS=true

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
