# Dockerfile único, parametrizado pelo serviço (D22).
#   docker build -f infra/docker/Dockerfile --build-arg SERVICE=@broker/<pacote> \
#     --build-arg GIT_COMMIT=$(git rev-parse HEAD) --build-arg SERVICE_VERSION=<versão> .
# Estágios: deps (instala o workspace) → build (compila o serviço e as dependências) →
# deploy (pnpm deploy isola o serviço com só as dependências de produção) → runtime.
ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG SERVICE
RUN test -n "$SERVICE" || (echo "informe --build-arg SERVICE=@broker/<pacote>" && false)
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter="${SERVICE}..."
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm deploy --filter="${SERVICE}" --prod /out

FROM ${NODE_IMAGE} AS runtime
# Versão e commit do artefato (RN-CICD-020): o commit vai para o /info (GIT_COMMIT); a versão vem
# do package.json do serviço, copiado abaixo. Os rótulos OCI deixam os dois visíveis na imagem.
ARG GIT_COMMIT=unknown
ARG SERVICE_VERSION=0.0.0
ARG SERVICE
LABEL org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.version="${SERVICE_VERSION}" \
      org.opencontainers.image.title="${SERVICE}" \
      org.opencontainers.image.source="https://github.com/steglich/broker-node"
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT}
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
# Usuário sem privilégios (já existe na imagem oficial do Node).
USER node
CMD ["node", "dist/main.js"]
