# Imagem base: Node + Chromium do Playwright com as dependências do sistema.
# Muda raramente (só quando a versão do Playwright muda) e fica em cache no GHCR.
FROM node:22-bookworm-slim

ARG PLAYWRIGHT_VERSION
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TZ=America/Sao_Paulo

RUN test -n "$PLAYWRIGHT_VERSION" \
 && apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates fonts-noto-color-emoji \
 && npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm
