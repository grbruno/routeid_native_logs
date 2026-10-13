# native-log — recepção e leitura do log do app nativo

Serviço que recebe os lotes de diagnóstico enviados pelo app `routeid_mobile` e
serve um painel para ler esse log de qualquer lugar.

O app manda, o serviço grava um arquivo NDJSON por dia e o painel (`/`) filtra
por aparelho, área, nível e período. **Não tem dependências**: só a biblioteca
padrão do Node 20+ (`npm install` não é necessário).

```
app nativo ──POST /api/logs──▶ native-log ──▶ data/2026-10-13.ndjson
                                   │
painel / ◀──GET /api/logs──────────┘
```

## 1. Subir no servidor

Escolha **uma** das formas abaixo. As duas primeiras usam contêiner; a última
roda direto no host.

### Coolify (Dockerfile) — recomendado se o VPS já está no Coolify

O Coolify faz o build, publica a porta, emite o certificado e cuida do volume:
**não é preciso nginx** (o proxy e o TLS são dele).

1. **New Resource → Application** apontando para este repositório.
2. **Base Directory**: `/server/native-log` — é onde está o `Dockerfile`.
3. **Build Pack**: `Dockerfile`. **Ports Exposes**: `8787`.
4. **Environment Variables** (runtime):
   - `LOG_TOKEN` = resultado de `openssl rand -hex 32`
   - `LOG_RETENTION_DAYS` = `30`

   **Não defina `HOST` nem `DATA_DIR`** — a imagem já traz `HOST=0.0.0.0` e
   `DATA_DIR=/data`. Copiar o `.env.example` inteiro para cá causa exatamente os
   dois erros que ele alerta: `HOST=127.0.0.1` faz o proxy receber "connection
   refused" (o sintoma é `502 Bad Gateway` em **todas** as rotas, inclusive
   `/api/health`, sem nenhum erro no log do serviço) e `DATA_DIR=./data` joga o
   log para dentro da camada do contêiner, fora do volume.
5. **Storages → Add**: Volume com **Destination Path** `/data`.
   É o diretório dos NDJSON — **sem este volume o log se perde a cada redeploy**.
   O `docker-entrypoint.sh` da imagem ajusta o dono do volume no start: sem esse
   passo a gravação falharia com `EACCES`.
6. **Domains**: `https://logs.seudominio.com` na porta `8787`.
7. **Deploy**. O healthcheck (`/api/health`, sem token) já vem do `Dockerfile` e
   é o que o Coolify usa para confirmar que o serviço subiu.

Conferência pelo terminal do próprio contêiner (aba *Terminal* no Coolify):

```sh
wget -qO- http://127.0.0.1:8787/api/health
ls -la /data          # deve estar gravável pelo usuário node
```

> **Watch Paths**: restrinja para `server/native-log/**`. Sem isso um commit no
> app Expo dispara redeploy do serviço de log (e vice-versa).

#### Testar a imagem na sua máquina

```sh
docker build -t routeid-native-log .
docker run --rm -p 8787:8787 -v native-log-data:/data \
  -e LOG_TOKEN=tok routeid-native-log
curl http://127.0.0.1:8787/api/health
```

### Docker Compose (VPS comum, com nginx)

```sh
cd server/native-log
cp .env.example .env
openssl rand -hex 32                       # gere o token e cole no .env
docker compose up -d --build
curl http://127.0.0.1:8787/api/health
```

### systemd (sem contêiner)

```sh
sudo mkdir -p /opt/routeid-native-log
sudo cp -r server.mjs public package.json /opt/routeid-native-log/
sudo cp .env.example /opt/routeid-native-log/.env   # edite o LOG_TOKEN
sudo cp deploy/routeid-native-log.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now routeid-native-log
```

## 2. Expor com TLS (nginx)

> **No Coolify este passo não existe**: o proxy reverso e o certificado são do
> próprio Coolify (basta configurar o domínio na aplicação). Siga abaixo apenas
> se o serviço roda num VPS comum, fora do Coolify.

```sh
sudo cp deploy/nginx.conf /etc/nginx/sites-available/routeid-native-log
sudo nano /etc/nginx/sites-available/routeid-native-log   # troque o domínio
sudo ln -s /etc/nginx/sites-available/routeid-native-log /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d logs.seudominio.com
```

O serviço escuta só em `127.0.0.1:8787` — quem publica para a internet é o nginx.
**Use https**: o token vai no cabeçalho `Authorization` e não pode trafegar em claro.

## 3. Apontar o app para este servidor

No build do app (`routeid_mobile/.env`):

```sh
EXPO_PUBLIC_ROUTEID_LOG_URL=https://logs.seudominio.com/api/logs
EXPO_PUBLIC_ROUTEID_LOG_TOKEN=<o mesmo LOG_TOKEN>
```

Variáveis `EXPO_PUBLIC_*` entram no bundle em tempo de build: **é preciso um novo
build** (`eas build`) para valer. Sem as duas variáveis o app não coleta nada.

## 4. Ler o log

Abra `https://logs.seudominio.com` no navegador, cole o token e use os filtros.
O token fica no `localStorage` do navegador, nunca no servidor.

Também dá para ler direto na linha de comando — é a razão de o formato ser NDJSON:

```sh
TOKEN=<o mesmo LOG_TOKEN>

# últimos 200 registros
curl -s -H "Authorization: Bearer $TOKEN" \
  'https://logs.seudominio.com/api/logs?days=1&limit=200' | jq '.entries[] | "\(.scope) \(.event)"'

# só as falhas dos últimos 7 dias
curl -s -H "Authorization: Bearer $TOKEN" \
  'https://logs.seudominio.com/api/logs?days=7&level=error' | jq '.entries'

# o que aconteceu com uma rota específica
curl -s -H "Authorization: Bearer $TOKEN" \
  'https://logs.seudominio.com/api/logs?days=7&q=r-123' | jq

# CSV para abrir no Excel
curl -s -H "Authorization: Bearer $TOKEN" \
  'https://logs.seudominio.com/api/logs?days=30&format=csv' -o log.csv

# no próprio servidor, sem passar pela API
jq -c 'select(.entry.scope=="geofence")' data/2026-10-13.ndjson
```

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| `POST` | `/api/logs` | Ingestão. Corpo: `{ device, entries[] }`. Responde `202 { accepted, duplicates }`. |
| `GET` | `/api/logs` | Consulta. `deviceId`, `scope`, `level`, `q`, `days`, `from`, `to`, `limit`, `format=json\|ndjson\|csv`. |
| `GET` | `/api/devices` | Agregado por aparelho (modelo, SO, sessões, erros, último registro). |
| `DELETE` | `/api/logs` | Apaga tudo. `?before=<epoch ms>` preserva o mais novo que o corte. |
| `GET` | `/api/health` | Sonda de saúde (sem autenticação). |

Autenticação: `Authorization: Bearer <LOG_TOKEN>` (ou `?token=<LOG_TOKEN>`).
Todas as rotas `/api/*`, exceto `/api/health`, exigem o token. Um `500` na
ingestão mantém o lote na fila do aparelho — ele reenvia sozinho depois.

**Idempotência:** o servidor guarda os `id` que aceitou (janela de 48 h, em
memória, repovoada a partir dos arquivos no start) e descarta o que já viu. Isso
importa porque o app só remove o lote da fila depois do `2xx`: se a resposta se
perder no caminho, ele reenvia o mesmo lote — e sem essa memória o painel
mostraria o evento duas vezes.

### Formato de uma linha gravada

```json
{
  "receivedAt": 1760400000000,
  "device": { "deviceId": "9f1c…", "model": "Galaxy A54", "os": "android 14", "app": "1.0.0", "sessionId": "…" },
  "entry": { "id": "…", "at": 1760399940000, "scope": "geofence", "event": "event:queued", "level": "info", "detail": "{\"stopId\":\"s-1\",\"accuracy\":12}" }
}
```

`at` é o relógio do **aparelho**; `receivedAt`, o do servidor. A diferença entre
os dois é o que o painel mostra na coluna **Atraso** — valores grandes indicam
que o aparelho ficou sem rede/WebView e a fila só subiu depois.

## Operação

- **Retenção**: os arquivos mais antigos que `LOG_RETENTION_DAYS` são apagados no
  start e a cada 6 h. Padrão: 30 dias.
- **Volume**: cada registro ocupa ~200 bytes. Uma frota de 50 aparelhos gera
  algo em torno de 1–3 MB por dia.
- **Backup**: basta copiar `data/` (`tar -czf log.tgz data/`).
- **Trocar o token**: mude `LOG_TOKEN` no serviço e gere um novo build do app.
  Enquanto o token estiver defasado, o app recebe `401` e mantém a fila local —
  os registros não são perdidos, só param até o build novo chegar.

## Aviso

Este log é **ferramenta interna de suporte**: contém identificadores de rota e
parada, versões, estado de permissões e o horário dos eventos no aparelho do
motorista. Trate como dado operacional restrito, mantenha o TLS e a retenção
curta, e não exponha a rota `/api/logs` sem token.
