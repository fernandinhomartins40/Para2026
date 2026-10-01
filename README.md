# Envio Manual WhatsApp

Aplicação web **multiusuário com login Google** para enviar **texto + imagem** pelo WhatsApp Web, **um número por vez, com um clique para cada envio** — nada é disparado automaticamente para a lista toda.

- **Login com Google**: qualquer conta Google pode entrar. Cada usuário tem **seu próprio WhatsApp, mensagem, imagem, lista de números e histórico** — um não vê nada do outro.
- Conecta ao WhatsApp Web com **Playwright** (um Chromium por usuário conectado) e mostra o **QR Code** na própria página.
- Você cola a lista de números, e clica em **"Enviar para o próximo pendente"** (ou em "Enviar" numa linha específica).
- **Banco SQLite** guarda para quem já foi enviado (data/hora), falhas e histórico. Números repetidos não são duplicados, e um número já enviado não recebe de novo a menos que você clique em "Reenviar".
- A sessão do WhatsApp fica salva: depois de ler o QR uma vez, não precisa ler de novo ao reiniciar.

## Requisitos

- Node.js 22 ou superior

## Instalação

```bash
npm install
npx playwright install chromium
```

## Uso

```bash
# Desenvolvimento local sem Google (entra digitando um e-mail):
DEV_LOGIN=true npm start
# Com Google (precisa de HTTPS ou http://localhost como origem autorizada no Client ID):
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com npm start
```

Abra http://localhost:3000, entre e:

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
| `GOOGLE_CLIENT_ID` | — | Client ID OAuth do Google (público; não há client secret) |
| `DEV_LOGIN` | `false` | `true` libera login só com e-mail, **apenas para desenvolvimento** |
| `MAX_BROWSERS` | `4` | Máximo de WhatsApps (Chromium) abertos ao mesmo tempo; quem passar disso fica "Na fila" |
| `IDLE_MINUTES` | `15` | Fecha o navegador de quem ficou esse tempo sem abrir a página (a sessão continua salva) |
| `HEADLESS` | `true` | Use `false` para ver a janela do Chromium enquanto envia |
| `DEFAULT_COUNTRY_CODE` | `55` | Código do país adicionado a números com 10–11 dígitos |
| `DATA_DIR` | `./data` | Onde ficam o banco (`envios.db`), as imagens e as sessões do WhatsApp de cada usuário |
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
- Porta no host: **47815** (variável `APP_PORT` nos dois workflows). O acesso dos usuários é pelo subdomínio HTTPS (veja *Login com Google*).
- O script `scripts/vps-deploy.sh` confere antes se a porta está ocupada por outro container/processo e aborta se estiver.
- Na VPS: arquivos em `/opt/para2026`, container `para2026-whatsapp`, volume `para2026_data` (banco, imagem e sessão do WhatsApp; sobrevive aos deploys).
- A limpeza remove só versões antigas **desta** imagem (mantém a atual e a anterior); nunca faz `prune -a`.
- Se a VPS tiver firewall, libere a porta: `ufw allow 47815/tcp`.

## Login com Google (configuração única)

O Google só aceita login em páginas **HTTPS com domínio** (ou `http://localhost`). Por isso a aplicação precisa ser acessada por um subdomínio, ex.: `https://zap.seudominio.com.br`.

**1. Subdomínio → aplicação (automático).** Crie o registro DNS `A` do subdomínio apontando para a VPS e coloque-o em `DOMAIN` nos workflows (atual: `zap.fuselink.com.br`). O deploy cria só o arquivo `/etc/nginx/sites-available/para2026` no nginx do host, emite o certificado com `certbot --webroot` (renovação automática pelo certbot) e encaminha para `127.0.0.1:47815`. Toda mudança passa por `nginx -t` antes do `reload`; se falhar, é desfeita — os sites das outras aplicações não são tocados.

**2. Client ID do Google.** Em https://console.cloud.google.com → *APIs e serviços* → *Tela de consentimento OAuth* (tipo **Externo**, publique o app) → *Credenciais* → *Criar credenciais* → *ID do cliente OAuth* → tipo **Aplicativo da Web**:
- **Origens JavaScript autorizadas**: `https://zap.seudominio.com.br`
- Não precisa de URI de redirecionamento nem de client secret.

**3.** Coloque o Client ID em `GOOGLE_CLIENT_ID` nos dois workflows (`deploy.yml` e `redeploy.yml`) e faça o deploy. Endereço: https://zap.fuselink.com.br

> **Primeiro login:** os dados da versão anterior (lista, mensagem, imagem e sessão do WhatsApp já conectada) vão para **o primeiro usuário que entrar**. Entre você primeiro.

## Estrutura

```
src/server.js     API Express + arquivos estáticos
src/whatsapp.js   Automação do WhatsApp Web (Playwright), um cliente por usuário
src/db.js         SQLite (usuários, sessões, contatos, histórico e configurações por usuário)
src/auth.js       Login com Google (validação do ID token) e sessão por cookie
src/phone.js      Normalização e leitura da lista de números
public/           Interface web
docker/            Dockerfiles das imagens base (Chromium) e deps (node_modules)
scripts/vps-deploy.sh  Executado na VPS pelos workflows (pull + up)
data/             Criado em tempo de execução (banco, imagem, sessão) — não versionado
```

## Observações

- O WhatsApp Web muda a interface com frequência; se algum envio falhar, rode com `HEADLESS=false` para ver o que está acontecendo.
- Envie apenas para pessoas que esperam receber sua mensagem. Envios em ritmo alto para desconhecidos podem levar ao bloqueio do número pelo WhatsApp.
