# ---- etapa de build -------------------------------------------------------
FROM node:24 AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .

# .adonisjs esta excluido por .dockerignore y start/routes.ts lo importa como
# #generated/controllers, sin el no arranca nada. Se genera en el build.
# Las variables son de mentira y van en el propio RUN (no como ENV) para que no
# queden en la imagen: al final, las reales llegan por env_file y environment.
RUN APP_KEY=placeholder_for_build_only \
    NODE_ENV=development \
    PORT=3333 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    APP_URL=http://localhost:3333 \
    SESSION_DRIVER=memory \
    DB_CONNECTION=pg \
    DB_HOST=localhost \
    DB_PORT=5432 \
    DB_USER=build \
    DB_PASSWORD=build \
    DB_DATABASE=build \
    node ace build

# ---- etapa de ejecucion ---------------------------------------------------
FROM node:24

WORKDIR /app

# El build ya trae el JavaScript compilado, las migraciones y el ace.js.
COPY --from=build /app/build ./
COPY --from=build /app/pnpm-workspace.yaml ./

RUN corepack enable
RUN pnpm install --prod --frozen-lockfile

EXPOSE 3333

CMD ["node", "bin/server.js"]
