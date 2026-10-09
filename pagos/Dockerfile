FROM node:24

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .

# .adonisjs esta excluido por .dockerignore y start/routes.ts lo importa como
# #generated/controllers, sin el no arranca nada. Se genera en el build.
# Las variables son de mentira y van en el propio RUN (no como ENV) para que no
# queden en la imagen: al final, las reales llegan por env_file y environment.
# pagos ademas exige TRAMITES_SERVICE_URL y USUARIOS_SERVICE_URL en
# start/env.ts, asi que tambien van.
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
    TRAMITES_SERVICE_URL=http://localhost \
    USUARIOS_SERVICE_URL=http://localhost \
    node ace codegen

EXPOSE 3333

CMD ["pnpm", "dev"]
