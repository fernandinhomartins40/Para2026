# Envio Manual WhatsApp

Aplicação web **multiusuário com cadastro próprio (e-mail e senha)** para enviar **texto + imagem** pelo WhatsApp Web, **um número por vez, com um clique para cada envio** — nada é disparado automaticamente para a lista toda.

- **Cadastro e login com e-mail e senha** (senhas com hash scrypt; 10 tentativas erradas bloqueiam por 15 min). Cada usuário tem **seu próprio WhatsApp, mensagem, imagem, lista de números e histórico** — um não vê nada do outro.
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
npm start
```

Abra http://localhost:3000, crie sua conta em **Criar conta** e:

1. **Conexão**: leia o QR Code com o celular (WhatsApp → Aparelhos conectados → Conectar aparelho).
2. **Mensagem**: escreva o texto e clique em *Salvar texto*. Escolha a imagem (opcional). Texto e imagem vão em **duas mensagens separadas**, na ordem escolhida em *Ordem de envio* (padrão: texto primeiro, depois a imagem).
   - `{nome}` (ou `{primeiro_nome}`) vira o **primeiro nome da lista**, com a primeira letra maiúscula ("MARIA SILVA" → "Maria"); `{nome_completo}` vira o nome inteiro. O nome vem só da lista — coloque nome e número em cada linha. Abaixo do botão de envio aparece a **prévia** exata da próxima mensagem.
3. **Adicionar números**: um por linha, com ou sem nome, em qualquer ordem e separador:
   ```
   11999998888
   11999997777;Maria Silva
   Maria Souza 11 99999-6666
   João - (21) 98888-7777
   ```
   Números com DDD sem o código do país recebem `55` automaticamente.
4. Clique em **Enviar para o próximo pendente** a cada envio. O status muda para *Enviado* quando o WhatsApp confirma a saída da mensagem (sai o reloginho).

Qualquer erro durante o envio (número inválido, sem WhatsApp, tempo esgotado...) marca o número como **Falhou** com o motivo e o tira da fila — o próximo clique segue para o número seguinte. O botão **Marcar falha** tira um pendente da fila manualmente; na aba *Falhas* dá para voltá-los para pendente.

## Configuração (variáveis de ambiente)

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta do servidor web |
| `ALLOW_REGISTRATION` | `true` | `false` bloqueia novos cadastros (só quem já tem conta entra) |
| `GOOGLE_CLIENT_ID` | — | Opcional: mostra também "Entrar com Google" (precisa de Client ID OAuth do Google) |
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

## Acesso e contas

Endereço: **https://zap.fuselink.com.br** (definido em `DOMAIN` nos workflows). O deploy configura sozinho o nginx do host e o certificado HTTPS: cria só o arquivo `/etc/nginx/sites-available/para2026`, emite o certificado com `certbot --webroot` (renovação automática) e encaminha para `127.0.0.1:47815`. Toda mudança passa por `nginx -t` antes do `reload` e é desfeita se falhar — os sites das outras aplicações não são tocados.

- Qualquer pessoa pode **criar uma conta** com nome, e-mail e senha. Para fechar novos cadastros, defina `ALLOW_REGISTRATION=false` no `docker-compose.vps.yml`.
- Cada usuário pode trocar a senha em **Alterar senha**. Não há "esqueci a senha" por e-mail (não há serviço de e-mail configurado).
- **Primeiro cadastro:** os dados da versão anterior (lista, mensagem, imagem e sessão do WhatsApp já conectada) vão para **a primeira conta criada**. Crie a sua primeiro.
- Login com Google é opcional: só aparece se `GOOGLE_CLIENT_ID` for preenchido nos workflows.

## Estrutura

```
src/server.js     API Express + arquivos estáticos
src/whatsapp.js   Automação do WhatsApp Web (Playwright), um cliente por usuário
src/db.js         SQLite (usuários, sessões, contatos, histórico e configurações por usuário)
src/auth.js       Cadastro/login com e-mail e senha (scrypt), limite de tentativas, sessão por cookie e Google opcional
src/phone.js      Normalização e leitura da lista de números
public/           Interface web
docker/            Dockerfiles das imagens base (Chromium) e deps (node_modules)
scripts/vps-deploy.sh  Executado na VPS pelos workflows (pull + up)
data/             Criado em tempo de execução (banco, imagem, sessão) — não versionado
```

## Observações

- O WhatsApp Web muda a interface com frequência; se algum envio falhar, rode com `HEADLESS=false` para ver o que está acontecendo.
- Envie apenas para pessoas que esperam receber sua mensagem. Envios em ritmo alto para desconhecidos podem levar ao bloqueio do número pelo WhatsApp.
