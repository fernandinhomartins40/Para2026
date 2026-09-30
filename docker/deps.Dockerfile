# node_modules de produção. Usa a imagem completa (tem python3, make e g++)
# para compilar módulos nativos como o better-sqlite3 quando não há binário pronto.
FROM node:22-bookworm

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && rm -rf /root/.npm
