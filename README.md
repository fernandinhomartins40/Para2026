# Envio Manual WhatsApp

Aplicação web (sem login) para enviar **texto + imagem** pelo WhatsApp Web, **um número por vez, com um clique seu para cada envio** — nada é disparado automaticamente para a lista toda.

- Conecta ao WhatsApp Web com **Playwright** e mostra o **QR Code** na própria página.
- Você cola a lista de números, e clica em **"Enviar para o próximo pendente"** (ou em "Enviar" numa linha específica).
- **Banco SQLite** guarda para quem já foi enviado (data/hora), falhas e histórico. Números repetidos não são duplicados, e um número já enviado não recebe de novo a menos que você clique em "Reenviar".
- A sessão do WhatsApp fica salva: depois de ler o QR uma vez, não precisa ler de novo ao reiniciar.

## Requisitos

- Node.js 18 ou superior

## Instalação

```bash
npm install
npx playwright install chromium
```

## Uso

```bash
npm start
```

Abra http://localhost:3000 e:

1. **Conexão**: leia o QR Code com o celular (WhatsApp → Aparelhos conectados → Conectar aparelho).
2. **Mensagem**: escreva o texto e clique em *Salvar texto*. Escolha a imagem (opcional). A imagem é enviada com o texto como legenda; sem imagem, vai só o texto.
   - `{nome}` e `{primeiro_nome}` são substituídos pelo nome do contato (se informado).
3. **Adicionar números**: um por linha, com ou sem nome:
   ```
   11999998888
   11999997777;Maria Silva
   +55 (21) 98888-7777, João
   ```
   Números com DDD sem o código do país recebem `55` automaticamente.
4. Clique em **Enviar para o próximo pendente** a cada envio. O status muda para *Enviado* quando o WhatsApp confirma a saída da mensagem (sai o reloginho).

Números inválidos/sem WhatsApp ficam como **Falhou** com o motivo; você pode voltá-los para pendente.

## Configuração (variáveis de ambiente)

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta do servidor web |
| `HEADLESS` | `true` | Use `false` para ver a janela do Chromium enquanto envia |
| `DEFAULT_COUNTRY_CODE` | `55` | Código do país adicionado a números com 10–11 dígitos |
| `DATA_DIR` | `./data` | Onde ficam o banco (`envios.db`), a imagem e a sessão do WhatsApp |
| `CHROMIUM_PATH` | — | Caminho de um Chromium/Chrome específico (opcional) |

Exemplo (Linux/macOS): `HEADLESS=false npm start`
Exemplo (Windows PowerShell): `$env:HEADLESS="false"; npm start`

## Deploy na VPS (Docker, sem domínio)

A imagem é **sempre construída no GitHub Actions** e publicada no GHCR (`ghcr.io/fernandinhomartins40/para2026-whatsapp`). A VPS **nunca compila**: o GitHub entra nela por SSH, faz `pull` e sobe o container.

| Workflow | Quando roda | O que faz |
|---|---|---|
| `.github/workflows/deploy.yml` | push na `main` ou manual | Jobs separados no GitHub: `build-base` (Node + Chromium) e `build-deps` (node_modules) em paralelo → `build-app` (imagem final) → `deploy` (SSH na VPS, pull e sobe) |
| `.github/workflows/redeploy.yml` | manual | Sobe de novo `latest` ou faz rollback para o SHA de um commit (só pull) |

- Único secret necessário: **`VPS_PASSWORD`** (senha SSH do `root@72.60.10.108`).
- Porta no host: **47815** (variável `APP_PORT` nos dois workflows). Acesso: `http://72.60.10.108:47815`
- O script `scripts/vps-deploy.sh` confere antes se a porta está ocupada por outro container/processo e aborta se estiver.
- Na VPS: arquivos em `/opt/para2026`, container `para2026-whatsapp`, volume `para2026_data` (banco, imagem e sessão do WhatsApp; sobrevive aos deploys).
- A limpeza remove só versões antigas **desta** imagem (mantém a atual e a anterior); nunca faz `prune -a`.
- Se a VPS tiver firewall, libere a porta: `ufw allow 47815/tcp`.

## Estrutura

```
src/server.js     API Express + arquivos estáticos
src/whatsapp.js   Automação do WhatsApp Web (Playwright)
src/db.js         SQLite (contatos, histórico de envios, configurações)
src/phone.js      Normalização e leitura da lista de números
public/           Interface web
docker/            Dockerfiles das imagens base (Chromium) e deps (node_modules)
scripts/vps-deploy.sh  Executado na VPS pelos workflows (pull + up)
data/             Criado em tempo de execução (banco, imagem, sessão) — não versionado
```

## Observações

- Não exponha esta aplicação na internet: ela não tem login e controla o seu WhatsApp. Rode localmente.
- O WhatsApp Web muda a interface com frequência; se algum envio falhar, rode com `HEADLESS=false` para ver o que está acontecendo.
- Envie apenas para pessoas que esperam receber sua mensagem. Envios em ritmo alto para desconhecidos podem levar ao bloqueio do número pelo WhatsApp.
