# Dockerfile único, parametrizado pelo serviço (D22).
#   docker build -f infra/docker/Dockerfile --build-arg SERVICE=@broker/<pacote> .
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
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
# Usuário sem privilégios (já existe na imagem oficial do Node).
USER node
CMD ["node", "dist/main.js"]
