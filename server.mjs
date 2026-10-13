#!/usr/bin/env node
/**
 * Recepção e leitura do log de diagnóstico do app nativo routeID.
 *
 * O app (`routeid_mobile`) envia lotes em `POST /api/logs`; esta máquina guarda
 * um arquivo NDJSON por dia e serve um painel de leitura em `/`.
 *
 * Decisões:
 *   - **zero dependências**: só a biblioteca padrão do Node 20+, para o serviço
 *     não precisar de `npm install` num VPS pequeno (nem de pipeline de build);
 *   - **gravura append-only por dia**: um arquivo `.ndjson` por dia é trivial de
 *     rotacionar, copiar e ler com `grep`/`jq` direto no servidor;
 *   - **autenticação por token único**: o log é ferramenta de suporte interno,
 *     não um dado de cliente — o token é o mesmo para toda a frota e deve ser
 *     trocado junto com o build do app.
 *
 * Variáveis de ambiente (ver `.env.example`):
 *   LOG_TOKEN            obrigatório — token exigido em todas as rotas /api/*
 *   PORT                 padrão 8787
 *   HOST                 padrão 127.0.0.1 (deixe o nginx expor para a internet)
 *   DATA_DIR             padrão ./data
 *   LOG_RETENTION_DAYS   padrão 30 dias
 *   LOG_MAX_BODY_BYTES   padrão 256 KiB por requisição
 *   LOG_ALLOWED_ORIGIN   opcional — habilita CORS só para esta origem
 */

import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.LOG_TOKEN?.trim() ?? '';
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(HERE, 'data'));
const PUBLIC_DIR = join(HERE, 'public');
const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS ?? 30);
const MAX_BODY_BYTES = Number(process.env.LOG_MAX_BODY_BYTES ?? 256 * 1024);
const ALLOWED_ORIGIN = process.env.LOG_ALLOWED_ORIGIN?.trim() || null;

/** Teto de registros aceitos numa requisição (o app manda 50 por lote). */
const MAX_ENTRIES_PER_REQUEST = 200;

/** Teto de linhas devolvidas numa consulta. */
const MAX_QUERY_LIMIT = 5_000;

const SCOPES = new Set(['app', 'bridge', 'engine', 'geofence', 'gps', 'perm', 'push', 'track']);
const LEVELS = new Set(['info', 'warn', 'error']);

if (!TOKEN) {
  console.error('[native-log] LOG_TOKEN não definido — recusando subir sem autenticação.');
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Armazenamento                                                              */
/* -------------------------------------------------------------------------- */

/** `2026-10-13` no fuso do servidor. */
function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function fileForDay(day) {
  return join(DATA_DIR, `${day}.ndjson`);
}

/** Nomes dos arquivos disponíveis, do mais novo para o mais antigo. */
async function listDayFiles() {
  try {
    const names = await readdir(DATA_DIR);
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

async function appendBatch(lines) {
  await mkdir(DATA_DIR, { recursive: true });
  // O_APPEND garante que escritas concorrentes não se sobreponham.
  await appendFile(fileForDay(dayKey()), lines.join('\n') + '\n', 'utf8');
}

/** Apaga arquivos fora da janela de retenção. */
async function pruneOldFiles() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffKey = dayKey(cutoff);

  for (const name of await listDayFiles()) {
    if (name.slice(0, 10) < cutoffKey) {
      await unlink(join(DATA_DIR, name)).catch(() => undefined);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Validação                                                                  */
/* -------------------------------------------------------------------------- */

function text(value, max) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

/** Normaliza um registro vindo do app. `null` quando não dá para confiar. */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const id = text(raw.id, 80);
  const event = text(raw.event, 80);
  const scope = text(raw.scope, 24);
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : null;

  if (!id || !event || !scope || at === null) return null;
  if (!SCOPES.has(scope)) return null;

  const level = LEVELS.has(raw.level) ? raw.level : 'info';
  const dir = raw.dir === 'web→nativo' || raw.dir === 'nativo→web' ? raw.dir : null;

  return {
    id,
    at,
    scope,
    event,
    level,
    dir,
    detail: text(raw.detail, 600),
  };
}

/** Normaliza a identificação do aparelho anexada ao lote. */
function normalizeDevice(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const deviceId = text(raw.deviceId, 64);
  if (!deviceId) return null;

  return {
    deviceId,
    model: text(raw.model, 64),
    os: text(raw.os, 64),
    app: text(raw.app, 32),
    sessionId: text(raw.sessionId, 64),
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function corsHeaders() {
  if (!ALLOWED_ORIGIN) return {};
  return {
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  };
}

/** Aceita `Authorization: Bearer <token>` ou `?token=` (para o painel). */
function authorized(req, url) {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const query = url.searchParams.get('token') ?? '';
  return bearer === TOKEN || query === TOKEN;
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* -------------------------------------------------------------------------- */
/* Rotas                                                                      */
/* -------------------------------------------------------------------------- */

async function handleIngest(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    json(res, 400, { error: String(error.message ?? error) }, corsHeaders());
    return;
  }

  const device = normalizeDevice(payload?.device);
  const rawEntries = Array.isArray(payload?.entries) ? payload.entries : null;
  if (!device || !rawEntries) {
    json(res, 400, { error: 'payload inválido: esperado { device, entries[] }' }, corsHeaders());
    return;
  }

  const receivedAt = Date.now();
  const lines = [];
  for (const raw of rawEntries.slice(0, MAX_ENTRIES_PER_REQUEST)) {
    const entry = normalizeEntry(raw);
    if (entry) lines.push(JSON.stringify({ receivedAt, device, entry }));
  }

  if (lines.length === 0) {
    json(res, 202, { accepted: 0 }, corsHeaders());
    return;
  }

  try {
    await appendBatch(lines);
  } catch (error) {
    // 500 mantém o lote na fila do aparelho: ele reenvia depois.
    json(res, 500, { error: `falha ao gravar: ${String(error)}` }, corsHeaders());
    return;
  }

  json(res, 202, { accepted: lines.length }, corsHeaders());
}

/** Arquivos que cobrem o período pedido, do mais novo para o mais antigo. */
async function filesInRange(from, to) {
  const names = await listDayFiles();
  const fromKey = from ? dayKey(new Date(from)) : null;
  const toKey = to ? dayKey(new Date(to)) : null;

  return names.filter((name) => {
    const key = name.slice(0, 10);
    if (fromKey && key < fromKey) return false;
    if (toKey && key > toKey) return false;
    return true;
  });
}

function rowFrom(line) {
  try {
    const parsed = JSON.parse(line);
    if (!parsed?.entry?.id) return null;
    return { ...parsed.entry, receivedAt: parsed.receivedAt, device: parsed.device };
  } catch {
    return null;
  }
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function readEntries(filters) {
  const { deviceId, scope, level, q, from, to, limit } = filters;
  const needle = q ? q.toLowerCase() : null;
  const entries = [];

  for (const name of await filesInRange(from, to)) {
    const content = await readFile(join(DATA_DIR, name), 'utf8').catch(() => '');
    const lines = content.split('\n');

    // O arquivo é cronológico: ler de trás para frente devolve o mais novo
    // primeiro sem carregar tudo em memória.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;

      const row = rowFrom(line);
      if (!row) continue;

      if (deviceId && row.device?.deviceId !== deviceId) continue;
      if (scope && row.scope !== scope) continue;
      if (level && row.level !== level) continue;
      if (from && row.at < from) continue;
      if (to && row.at > to) continue;
      if (needle) {
        const haystack = `${row.event} ${row.detail ?? ''} ${row.scope} ${row.dir ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }

      entries.push(row);
      if (entries.length >= limit) return entries;
    }
  }

  return entries;
}

function parseFilters(url) {
  const params = url.searchParams;
  const number = (key) => {
    const raw = params.get(key);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };

  // `days` é o atalho do painel; `from`/`to` (epoch ms) têm prioridade.
  const days = number('days');
  const from = number('from') ?? (days ? Date.now() - days * 24 * 60 * 60 * 1000 : null);

  return {
    deviceId: params.get('deviceId')?.trim() || null,
    scope: SCOPES.has(params.get('scope')) ? params.get('scope') : null,
    level: LEVELS.has(params.get('level')) ? params.get('level') : null,
    q: params.get('q')?.trim() || null,
    from,
    to: number('to'),
    limit: Math.min(number('limit') ?? 500, MAX_QUERY_LIMIT),
  };
}

async function handleQuery(req, res, url) {
  const filters = parseFilters(url);
  const entries = await readEntries(filters);
  const format = url.searchParams.get('format') ?? 'json';

  if (format === 'ndjson') {
    const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(),
    });
    res.end(body);
    return;
  }

  if (format === 'csv') {
    const header = 'at_iso,received_iso,deviceId,model,os,app,sessionId,scope,dir,level,event,detail';
    const rows = entries.map((entry) =>
      [
        new Date(entry.at).toISOString(),
        new Date(entry.receivedAt).toISOString(),
        entry.device?.deviceId,
        entry.device?.model,
        entry.device?.os,
        entry.device?.app,
        entry.device?.sessionId,
        entry.scope,
        entry.dir,
        entry.level,
        entry.event,
        entry.detail,
      ]
        .map(csvCell)
        .join(',')
    );

    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="routeid-native-log.csv"`,
      'cache-control': 'no-store',
      ...corsHeaders(),
    });
    res.end([header, ...rows].join('\n'));
    return;
  }

  json(res, 200, { count: entries.length, entries }, corsHeaders());
}

/** Agregado por aparelho — a primeira tela que o suporte precisa ver. */
async function handleDevices(req, res, url) {
  const filters = parseFilters(url);
  const entries = await readEntries({ ...filters, deviceId: null, limit: MAX_QUERY_LIMIT });
  const devices = new Map();

  for (const entry of entries) {
    const deviceId = entry.device?.deviceId ?? 'desconhecido';
    const current = devices.get(deviceId) ?? {
      deviceId,
      model: entry.device?.model ?? null,
      os: entry.device?.os ?? null,
      app: entry.device?.app ?? null,
      sessions: new Set(),
      count: 0,
      errors: 0,
      firstAt: entry.at,
      lastAt: entry.at,
    };

    current.count += 1;
    if (entry.level === 'error') current.errors += 1;
    if (entry.device?.sessionId) current.sessions.add(entry.device.sessionId);
    current.firstAt = Math.min(current.firstAt, entry.at);
    current.lastAt = Math.max(current.lastAt, entry.at);
    devices.set(deviceId, current);
  }

  const list = [...devices.values()]
    .map((device) => ({ ...device, sessions: device.sessions.size }))
    .sort((a, b) => b.lastAt - a.lastAt);

  json(res, 200, { count: list.length, devices: list }, corsHeaders());
}

/** Esvazia o log (manutenção). `?before=<epoch ms>` limita o que sai. */
async function handleClear(req, res, url) {
  const before = Number(url.searchParams.get('before'));
  const hasCutoff = Number.isFinite(before) && before > 0;
  let removed = 0;

  for (const name of await listDayFiles()) {
    const path = join(DATA_DIR, name);

    if (!hasCutoff) {
      removed += (await stat(path).catch(() => null))?.size ?? 0;
      await unlink(path).catch(() => undefined);
      continue;
    }

    // Reescrita preservando o que é mais novo que o corte.
    const content = await readFile(path, 'utf8').catch(() => '');
    const remaining = content
      .split('\n')
      .filter((line) => line.trim() && (rowFrom(line)?.at ?? 0) >= before);

    await writeFile(path, remaining.length ? `${remaining.join('\n')}\n` : '', 'utf8');
    removed += 1;
  }

  json(res, 200, { cleared: true, removed }, corsHeaders());
}

async function serveStatic(res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');

  // Só o que existe em `public/`, sem escapar do diretório.
  if (file.includes('..')) {
    res.writeHead(400).end('bad request');
    return;
  }

  try {
    const content = readFileSync(join(PUBLIC_DIR, file));
    const type = file.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : file.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : file.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';

    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('não encontrado');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  try {
    if (url.pathname === '/api/health') {
      json(res, 200, { ok: true, retentionDays: RETENTION_DAYS, dataDir: DATA_DIR });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req, url)) {
        json(res, 401, { error: 'token inválido' }, corsHeaders());
        return;
      }

      if (url.pathname === '/api/logs' && req.method === 'POST') {
        await handleIngest(req, res);
        return;
      }
      if (url.pathname === '/api/logs' && req.method === 'GET') {
        await handleQuery(req, res, url);
        return;
      }
      if (url.pathname === '/api/logs' && req.method === 'DELETE') {
        await handleClear(req, res, url);
        return;
      }
      if (url.pathname === '/api/devices' && req.method === 'GET') {
        await handleDevices(req, res, url);
        return;
      }

      json(res, 404, { error: 'rota inexistente' }, corsHeaders());
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    json(res, 500, { error: String(error) }, corsHeaders());
  }
});

await mkdir(DATA_DIR, { recursive: true });
await pruneOldFiles();
// Retenção também em execução longa: sem isso o disco só é limpo em restart.
setInterval(() => void pruneOldFiles().catch(() => undefined), 6 * 60 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`[native-log] ouvindo em http://${HOST}:${PORT}`);
  console.log(`[native-log] dados em ${DATA_DIR} · retenção ${RETENTION_DAYS} dias`);
  console.log(`[native-log] painel em / (informe o token no cabeçalho Authorization)`);
});
