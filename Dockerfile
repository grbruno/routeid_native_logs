# Imagem do serviço de log para o Coolify.
#
# No Coolify:
#   Base Directory ....... /server/native-log
#   Build Pack ........... Dockerfile
#   Ports Exposes ........ 8787
#   Storages ............. Volume em /data   (persistência dos NDJSON)
#   Env (runtime) ........ LOG_TOKEN (obrigatório), LOG_RETENTION_DAYS
#   Domains .............. https://logs.seudominio.com → porta 8787
#
# Não há etapa de build: o serviço não tem dependências (só a stdlib do Node).

FROM node:22-alpine

# `tini`  — PID 1, para o SIGTERM do redeploy chegar ao Node e ele sair limpo.
# `su-exec` — usado pelo entrypoint para largar o root depois de preparar o volume.
RUN apk add --no-cache tini su-exec

WORKDIR /app

COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node public ./public
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# `HOST=0.0.0.0` é obrigatório em contêiner: com o padrão (127.0.0.1) o proxy do
# Coolify não alcançaria o serviço pela rede do Docker. `PORT` fica igual ao
# declarado em EXPOSE porque é o valor que o Coolify publica.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data

# Ponto de montagem do volume de persistência (Coolify → Storages).
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

EXPOSE 8787

# O Coolify usa este healthcheck para saber se o deploy subiu de verdade.
# `/api/health` é a única rota que não exige token.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
