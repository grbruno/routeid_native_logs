#!/bin/sh
# Prepara o volume de persistência e larga o root antes de subir o serviço.
#
# Por que isto existe: no Coolify o volume de Storages é criado e montado pelo
# Docker como root (`root:root`), e o serviço roda como `node`. Sem este passo o
# primeiro `append` no NDJSON falha com EACCES e a ingestão devolve 500 — o app
# mantém a fila, mas o log nunca sobe.
#
# O `chown -R` é condicional de propósito: num volume já correto ele não roda, e
# assim um redeploy não percorre um diretório que pode ter centenas de arquivos.

set -eu

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = '0' ]; then
  mkdir -p "$DATA_DIR"

  # Só reescreve o dono se o usuário do serviço ainda não puder gravar.
  if ! su-exec node /bin/sh -c "test -w '$DATA_DIR'"; then
    echo "[native-log] ajustando dono de $DATA_DIR para node"
    chown -R node:node "$DATA_DIR"
  fi

  exec su-exec node "$@"
fi

# Já não é root (ex.: `docker run --user`): segue direto, sem tentar chown.
exec "$@"
