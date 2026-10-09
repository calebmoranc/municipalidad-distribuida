# Especificación Técnica — Sistema de Gestión Municipal

> Documento generado a partir del análisis del código fuente existente.
> Refleja el estado actual del proyecto (Jul. 2026) y los requisitos que el sistema
> debe cumplir. Las secciones marcadas con **Estado** indican qué parte ya está
> implementada y qué parte es pendiente.

---

## 1. Propósito y alcance

Plataforma web para la gestión de trámites de una municipalidad. Los ciudadanos
registran su cuenta, inician **trámites** y realizan los **pagos** correspondientes.
Cada dominio de negocio opera como un servicio independiente, tolerante a fallos y
escalable horizontalmente.

### 1.1 Objetivos

| # | Objetivo |
|---|----------|
| O1 | Desacoplar cada dominio de negocio (usuarios, trámites, pagos) en servicios independientes. |
| O2 | Garantizar alta disponibilidad mediante réplicas y balanceo de carga con failover. |
| O3 | Persistir datos de forma centralizada y consistente en PostgreSQL. |
| O4 | Autenticación stateless mediante tokens de acceso (JWT-ready) para consumo por frontend SPA. |
| O5 | Asegurar consistencia transaccional entre el registro de un pago y el cambio de estado de su trámite. |

### 1.2 Fuera de alcance (por ahora)

- Panel de administración municipal.
- Notificaciones por email/SMS.
- Integración con pasarelas de pago reales (tarjetas, transferencias).
- Reportes, auditoría y analítica.
- App móvil nativa.

---

## 2. Arquitectura

### 2.1 Estilo: microservicios con bases de datos separadas

```
                      Cliente (SPA / curl)
                              │
                              ▼
                   ┌──────────────────────┐
                   │  gateway (Nginx)     │  :8080 → :80
                   │  balanceo + failover │
                   └──────────┬───────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
 ┌──────────────┐     ┌──────────────┐      ┌──────────────┐
 │  tramites_1  │     │  usuarios_1  │      │   pagos_1    │
 │  tramites_2  │     │  usuarios_2  │      │   pagos_2    │
 │   AdonisJS   │     │   AdonisJS   │      │   AdonisJS   │
 │   :3333      │     │   :3333      │      │   :3333      │
 └──────┬───────┘     └──────┬───────┘      └──────┬───────┘
        │                    │                     │
        │            ┌───────┴────────┐            │
        │            │  PostgreSQL 16 │            │
        └────────────┤  usuarios_db  ├────────────┘
                     │  pagos_db     │   (comunicación vía
                     │ municipalidad │    REST + gateway)
                     └────────────────┘
```

**Decisión clave:** cada réplica es stateless. No hay sesiones compartidas ni estado en
memoria, lo que permite añadir réplicas (`tramites_3`, `usuarios_3`, …) sin cambios de
código ni de esquema.

### 2.2 Topología de contenedores

| Contenedor | Puerto host | Puerto interno | Rol |
|---|---|---|---|
| `municipalidad_gateway` | 8080 | 80 | Punto de entrada único, reverse proxy |
| `municipalidad_postgres` | — | 5432 | Almacén de datos |
| `tramites_1` / `tramites_2` | 3333 / 3334 | 3333 | Servicio de trámites |
| `usuarios_1` / `usuarios_2` | 3335 / 3336 | 3333 | Servicio de usuarios |
| `pagos_1` / `pagos_2` | 3337 / 3338 | 3333 | Servicio de pagos |

Healthcheck de PostgreSQL (`pg_isready`, intervalo 5s, 10 reintentos). Las réplicas
esperan `condition: service_healthy` antes de arrancar. Volumen persistente
`postgres_data` para sobrevivir a reinicios.

### 2.3 Stack tecnológico

| Capa | Tecnología | Versión |
|---|---|---|
| Runtime | Node.js | 24 (alpine en Nginx) |
| Lenguaje | TypeScript | ~6.0.3, ESM |
| Framework | AdonisJS Core | ^7.5.0 |
| ORM / Migraciones | Lucid | ^22.4.2 |
| Autenticación | @adonisjs/auth (tokens guard) | ^10.1.0 |
| Validación | VineJS | ^4.4.0 |
| Serialización | @adonisjs/core transformers | — |
| Base de datos | PostgreSQL | 16-alpine |
| Proxy | Nginx | alpine |
| Gestor de paquetes | pnpm (corepack) | — |
| Testing | Japa | ^5.3.0 |
| Lint / Formato | ESLint 10 + Prettier | — |
| Dev server | `node ace serve --hmr` (hot-hook) | — |

**Nota de despliegue:** los `Dockerfile` ejecutan `pnpm dev` (servidor de desarrollo con
HMR). Para producción se requiere un build (`node ace build`) y `pnpm start`.

---

## 3. Estructura de directorios

```
municipalidad/
├── docker-compose.yml          Orquestación: 8 contenedores + volumen
├── gateway/
│   └── nginx.conf              Upstreams, balanceo, failover, rutas públicas
├── spects.md                   Este documento
├── usuarios/                   Servicio de usuarios   → usuarios_db
├── tramites/                   Servicio de trámites   → municipalidad
└── pagos/                      Servicio de pagos      → pagos_db
```

### 3.1 Anatomía de un servicio (idéntica en los tres)

| Ruta | Responsabilidad |
|---|---|
| `app/controllers/` | Handlers HTTP. Stack de auth replicado en cada servicio + controlador de dominio. |
| `app/models/` | Modelos Lucid (`User` en los tres; `Tramite` en tramites; `Pago` en pagos). |
| `app/middleware/` | `auth_middleware` (exige token), `silent_auth_middleware` (token opcional), `container_bindings_middleware`, `force_json_response_middleware`. |
| `app/validators/` | Esquemas Vine para signup y login. |
| `app/transformers/` | Forma de la respuesta JSON (`UserTransformer`; excluye password). |
| `app/exceptions/handler.ts` | Traducción de excepciones a respuestas HTTP. |
| `config/` | `app`, `auth`, `database`, `bodyparser`, `cors`, `encryption`, `hash`, `logger`, `session`, `shield`. |
| `start/routes.ts` | Tabla de endpoints. |
| `start/kernel.ts` | Registro de middleware (server / router / named). |
| `start/env.ts` | Validación y tipado de variables de entorno. |
| `start/validator.ts` | Configuración global de Vine. |
| `database/migrations/` | Migraciones versionadas. |
| `database/schema.ts` | Esquema generado (no editar). |
| `database/schema_rules.ts` | Reglas de generación de esquema. |
| `providers/api_provider.ts` | Bootstrap de la app + inyección de dependencias. |
| `bin/` | `server.ts` (HTTP), `console.ts` (CLI ace), `test.ts` (runner). |
| `tests/` | Bootstrap de Japa. |
| `Dockerfile` | Imagen de servicio. |
| `.env` / `.env.example` | Configuración local (los `.env` están en `.gitignore`). |

---

## 4. Especificación de la API

Base path: `/api/v1`. Todas las respuestas son JSON.

### 4.1 Servicio Usuarios

Base de datos: `usuarios_db`.

| Método | Ruta | Auth | Descripción | Respuesta |
|---|---|---|---|---|
| GET | `/` | No | Health check | `200 {hello:"world"}` |
| POST | `/api/v1/auth/signup` | No | Crear cuenta y emitir token | `200 {user, token}` |
| POST | `/api/v1/auth/login` | No | Verificar credenciales y emitir token | `200 {user, token}` |
| GET | `/api/v1/account/profile` | Sí | Perfil del usuario autenticado | `200 user` |
| POST | `/api/v1/account/logout` | Sí | Revocar el token actual | `200 {message}` |
| POST | `/api/v1/usuarios` | No | Crear usuario | `200 user` |
| GET | `/api/v1/usuarios` | No | Listar usuarios | `200 [user]` |
| GET | `/api/v1/usuarios/:id` | No | Obtener usuario por id | `200 user` / `404` |

**Payloads**

```jsonc
// POST /api/v1/auth/signup  (signupValidator)
{
  "fullName": "string|null",      // opcional
  "email": "string",              // formato email, máx 254, único en users.email
  "password": "string",           // 8–32 caracteres
  "passwordConfirmation": "string"// debe coincidir con password
}

// POST /api/v1/auth/login  (loginValidator)
{ "email": "string", "password": "string" }
```

**Respuesta de auth**

```jsonc
{
  "user": { "id": 1, "fullName": "…", "email": "…",
            "createdAt": "…", "updatedAt": "…", "initials": "AB" },
  "token": "<access token opaco>"
}
```

El campo `password` está marcado `serializeAs: null`, por lo que **nunca** aparece en
las respuestas.

### 4.2 Servicio Trámites

Base de datos: `municipalidad`.

| Método | Ruta | Auth | Descripción | Respuesta |
|---|---|---|---|---|
| GET | `/` | No | Health check | `200 {hello:"world"}` |
| GET | `/api/v1/tramites` | No | Listar trámites | `200 [tramite]` |
| POST | `/api/v1/tramites` | No | Crear trámite | `201 tramite` |
| GET | `/api/v1/tramites/:id` | No | Detalle de un trámite | `200 tramite` / `404 {message}` |
| PATCH | `/api/v1/tramites/:id` | No | Actualizar estado | `200 tramite` / `404 {message}` |
| POST | `/api/v1/auth/signup` | No | (stack auth replicado) | `200 {user, token}` |
| POST | `/api/v1/auth/login` | No | (stack auth replicado) | `200 {user, token}` |
| GET | `/api/v1/account/profile` | Sí | Perfil autenticado | `200 user` |
| POST | `/api/v1/account/logout` | Sí | Revocar token | `200 {message}` |

**Payloads**

```jsonc
// POST /api/v1/tramites
{ "usuarioId": 1, "tipo": "licencia de conducir", "descripcion": "…" }
// estado se asigna automáticamente: "pendiente"

// PATCH /api/v1/tramites/:id
{ "estado": "pagado" }
```

**Códigos de error**: `404 { "message": "Trámite no encontrado" }`.

### 4.3 Servicio Pagos

Base de datos: `pagos_db`. Variable `TRAMITES_SERVICE_URL` (en Docker:
`http://gateway`).

| Método | Ruta | Auth | Descripción | Respuesta |
|---|---|---|---|---|
| GET | `/` | No | Health check | `200 {hello:"world"}` |
| GET | `/api/v1/pagos` | No | Listar pagos | `200 [pago]` |
| POST | `/api/v1/pagos` | No | Registrar pago (orquesta trámite) | `201 pago` |
| POST | `/api/v1/auth/signup` | No | (stack auth replicado) | `200 {user, token}` |
| POST | `/api/v1/auth/login` | No | (stack auth replicado) | `200 {user, token}` |
| GET | `/api/v1/account/profile` | Sí | Perfil autenticado | `200 user` |
| POST | `/api/v1/account/logout` | Sí | Revocar token | `200 {message}` |

**Payload**

```jsonc
// POST /api/v1/pagos
{ "id_tramite": 1, "monto": 15000.00,
  "metodo_pago": "tarjeta", "fecha_pago": "2026-01-15T10:00:00Z",
  "estado": "pendiente" }
```

### 4.4 Reglas de enrutamiento del gateway

| Path match | Upstream |
|---|---|
| `/tramites`, `/api/v1/tramites` | `tramites_1`, `tramites_2` |
| `/api/v1/usuarios` | `usuarios_1`, `usuarios_2` |
| `/api/v1/pagos` | `pagos_1`, `pagos_2` |

Política de failover: `max_fails=1 fail_timeout=10s`, reintento en `error`, `timeout`,
`502`, `503`, `504`, hasta 2 intentos. Se propagan `Host` y `X-Real-IP`.

---

## 5. Modelo de datos

### 5.1 `users` (servicio Usuarios)

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | increments | PK, not null |
| `full_name` | string | nullable |
| `email` | string(254) | not null, **unique** |
| `password` | string | not null (hash) |
| `created_at` | timestamp | not null |
| `updated_at` | timestamp | nullable |

Índice único implícito en `email` por la restricción `UNIQUE`.

### 5.2 `auth_access_tokens` (servicio Usuarios)

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | increments | PK |
| `tokenable_id` | integer | not null, unsigned, **FK → users.id ON DELETE CASCADE** |
| `type` | string | not null |
| `name` | string | nullable |
| `hash` | string | not null |
| `abilities` | text | not null |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |
| `last_used_at` | timestamp | nullable |
| `expires_at` | timestamp | nullable |

Única FK del proyecto. Permite revocación individual de tokens y expiración.

### 5.3 `tramites` (servicio Trámites)

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | increments | PK |
| `usuario_id` | integer | not null, unsigned |
| `tipo` | string(100) | not null |
| `descripcion` | text | not null |
| `estado` | string(30) | not null, default `'pendiente'` |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

### 5.4 `pagos` (servicio Pagos)

| Columna | Tipo | Restricciones |
|---|---|---|
| `id_pago` | increments | PK |
| `id_tramite` | integer | not null |
| `monto` | decimal(10,2) | not null |
| `metodo_pago` | string | not null |
| `fecha_pago` | timestamp | not null |
| `estado` | string | not null, default `'pendiente'` |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

### 5.5 Diagrama de relaciones

```
usuarios_db                          municipalidad            pagos_db
┌──────────────┐                    ┌──────────────┐          ┌──────────────┐
│    users     │                    │   tramites   │          │    pagos     │
│──────────────│                    │──────────────│          │──────────────│
│ id      PK   │◄──┐                │ id      PK   │          │ id_pago  PK  │
│ email  UQ   │   │                │ usuario_id   │          │ id_tramite ──┼─┐
│ password    │   │ (FK CASCADE)   │ tipo         │          │ monto        │ │
│ full_name   │   │                │ descripcion  │          │ metodo_pago  │ │
└──────────────┘   │                │ estado       │          │ fecha_pago   │ │
       ▲          │                └──────────────┘          │ estado       │ │
       │          │                        ▲                 └──────────────┘ │
┌──────┴───────┐  │                        │                        ▲         │
│auth_access_  │──┘                        └────────────────────────┼─────────┘
│   tokens     │         referencias lógicas entre servicios            │
└──────────────┘                          (validada vía REST)         │
                                                                       │
   Nota: `tramites.usuario_id` y `pagos.id_tramite` NO tienen foreign key    │
   (bases separadas). La integridad se aplica en la capa de aplicación.     │
```

**Restricción de integridad entre servicios:** al no existir FK cross-database, la
coherencia de `pagos.id_tramite → tramites.id` se valida en el servicio de pagos
mediante una llamada HTTP al servicio de trámites.

---

## 6. Autenticación y autorización

### 6.1 Mecanismo

Guard por defecto: `api` (tokens). Configurado en `config/auth.ts`:

- **`api`** — `tokensGuard` + `tokensUserProvider`, modelo `User`, tabla de tokens
  `auth_access_tokens`. Apropiado para APIs stateless.
- **`web`** — `sessionGuard`, con remember-me desactivado. Reservado para el futuro
  frontend con SSR.

### 6.2 Flujo

```
signup/login
   │  validator (Vine)
   │  User.verifyCredentials()  ── Argon2/scrypt sobre hash ──┐
   │  User.accessTokens.create()  → genera token + hash en BD │
   ▼                                                          │
{ user, token }                                               │
                                                              │
Petición subsiguiente:  Authorization: Bearer <token>         │
   │                                                          │
initialize_auth_middleware →DbAccessTokensProvider            │
   │  busca por hash, actualiza last_used_at                  │
   ▼                                                          │
silent_auth_middleware → ctx.auth.check() (no falla)          │
   │                                                          ▼
auth_middleware (named: auth) en rutas /account → 401 si no hay token ◄┘
```

### 6.3 Requisitos

- R1. Las contraseñas se almacenan **hasheadas** (nunca en texto plano).
- R2. El campo `password` nunca se serializa (`serializeAs: null`).
- R3. `signup` devuelve token: no se requiere un login adicional.
- R4. `logout` revoca el token actual de la BD, no solo del cliente.
- R5. El email es único a nivel de base de datos.
- R6. Rutas `/account/*` exigen autenticación; el resto son públicas.
- R7. La validación de email y password es obligatoria antes de tocar la BD.

---

## 7. Flujo de negocio crítico: registro de pago

Este es el único flujo multi-servicio del sistema y el que concentra el riesgo de
consistencia. Secuencia implementada en `pagos/app/controllers/pagos_controller.ts:10`.

```
 Cliente        pagos            gateway          tramites
   │             │                 │                 │
   ├─ POST /api/v1/pagos ────────►│                 │
   │             │ 1. GET /api/v1/tramites/:id ────►│
   │             │◄───────────────┼─────────────────┤
   │             │   404 → 400 "El trámite no existe"
   │             │   !ok  → 503 "No se pudo verificar"
   │             │   throw → 503 "No se pudo conectar"
   │             │ 2. INSERT pago (estado pendiente)
   │             │ 3. PATCH /api/v1/tramites/:id {estado:"pagado"}
   │             │◄───────────────┼─────────────────┤
   │             │   !ok  → DELETE pago + 503
   │             │   throw → DELETE pago + 503
   │◄─ 201 pago ──┤ 4. éxito
```

**Contrato de consistencia (compensación manual):** si el paso 3 falla, el pago
recién creado se elimina y se devuelve `503`. Es un patrón *compensating transaction*
en lugar de una transacción distribuida, adecuado dado que sólo participan dos servicios.

**Errores del flujo**

| Situación | Código | Mensaje |
|---|---|---|
| Trámite inexistente | 400 | `El trámite indicado no existe` |
| Trámite no verificable | 503 | `No se pudo verificar el trámite` |
| Servicio caído | 503 | `No se pudo conectar con el servicio de trámites` |
| Actualización fallida (pago revertido) | 503 | `No se pudo actualizar el trámite. El pago fue eliminado.` |

---

## 8. Variables de entorno

Cada servicio define su esquema en `start/env.ts`; una variable faltante o inválida
impide el arranque (fail-fast).

| Variable | Tipo | Requerida | Servicio | Default / valor |
|---|---|---|---|---|
| `NODE_ENV` | enum | Sí | Todos | `development` |
| `PORT` | number | Sí | Todos | `3333` |
| `HOST` | host | Sí | Todos | `localhost` / `0.0.0.0` en Docker |
| `LOG_LEVEL` | string | Sí | Todos | `info` |
| `APP_KEY` | secret | Sí | Todos | 32 bytes, **único por servicio** |
| `APP_URL` | url | Sí | Todos | `http://${HOST}:${PORT}` |
| `SESSION_DRIVER` | enum | Sí | Todos | `cookie` |
| `DB_CONNECTION` | string | Sí | Todos | `sqlite` local / `pg` en Docker |
| `DB_HOST` | string | Sí (pg) | Todos | `postgres` en Docker |
| `DB_PORT` | number | Sí (pg) | Todos | `5432` |
| `DB_USER` | string | Sí (pg) | Todos | `municipalidad` |
| `DB_PASSWORD` | string | Sí (pg) | Todos | `municipalidad_dev` |
| `DB_DATABASE` | string | Sí (pg) | Todos | por servicio |
| `TRAMITES_SERVICE_URL` | string | Sí | **pagos** | `http://gateway` |
| `CORS_ORIGIN` | lista | No | Todos | comentado (deshabilitado) |

**Seguridad de configuración:** los `.env` están en `.gitignore`; sólo se versionan
los `.env.example`. Las `APP_KEY` presentes en los `.env` locales no deben reutilizarse
en producción. `DB_CONNECTION=sqlite` en los `.env` locales se sobreescribe con `pg`
mediante `environment:` en `docker-compose.yml`.

---

## 9. Requisitos funcionales

| ID | Requisito | Módulo | Estado |
|---|---|---|---|
| RF-01 | Registrar usuario con email único y contraseña validada | usuarios | **Implementado** |
| RF-02 | Autenticarse y recibir token de acceso | usuarios | **Implementado** |
| RF-03 | Consultar el perfil del usuario autenticado | usuarios | **Implementado** |
| RF-04 | Cerrar sesión revocando el token | usuarios | **Implementado** |
| RF-05 | Listar y consultar usuarios | usuarios | **Implementado** |
| RF-06 | Crear trámites con estado inicial `pendiente` | tramites | **Implementado** |
| RF-07 | Listar, consultar y actualizar el estado de trámites | tramites | **Implementado** |
| RF-08 | Registrar pagos validando la existencia del trámite | pagos | **Implementado** |
| RF-09 | Marcar el trámite como `pagado` al registrar el pago | pagos | **Implementado** |
| RF-10 | Revertir el pago si falla la actualización del trámite | pagos | **Implementado** |
| RF-11 | Listar pagos | pagos | **Implementado** |
| RF-12 | Balanceo de carga y failover entre réplicas | gateway | **Implementado** |
| RF-13 | Persistencia de datos sobreviva a reinicios | infra | **Implementado** |
| RF-14 | Filtrar trámites por usuario | tramites | Pendiente |
| RF-15 | Paginación y filtros en listados | todos | Pendiente |
| RF-16 | Validación de entrada en trámites y pagos (Vine) | tramites, pagos | Pendiente |
| RF-17 | Proteger rutas de escritura con autenticación | tramites, pagos | Pendiente |
| RF-18 | Historial de estados del trámite | tramites | Pendiente |
| RF-19 | Comprobantes / recibo de pago | pagos | Pendiente |
| RF-20 | Roles y permisos (ciudadano vs. municipal) | todos | Pendiente |

---

## 10. Requisitos no funcionales

### 10.1 Rendimiento y escalabilidad

| ID | Requisito | Métrica |
|---|---|---|
| RNF-01 | Tiempo de respuesta de lectura bajo carga normal | p95 < 300 ms |
| RNF-02 | Añadir una réplica requiere sólo una entrada en `docker-compose.yml` + un `server` en `nginx.conf` | Sin cambios de código |
| RNF-03 | La API es stateless: cualquier réplica puede atender cualquier petición | — |
| RNF-04 | El gateway debe enrutar a la réplica sana cuando una cae | `max_fails=1 fail_timeout=10s` |

### 10.2 Disponibilidad

| ID | Requisito |
|---|---|
| RNF-05 | El sistema opera con una réplica caída por servicio sin interrupción. |
| RNF-06 | El healthcheck de PostgreSQL evita arranques con base de datos no disponible. |
| RNF-07 | Los datos sobreviven a `docker compose down` (volumen `postgres_data`). |

### 10.3 Seguridad

| ID | Requisito | Implementación |
|---|---|---|
| RNF-08 | Contraseñas hasheadas con salt | `withAuthFinder(hash)` |
| RNF-09 | Contraseñas nunca en la respuesta | `serializeAs: null` |
| RNF-10 | Secretos fuera del control de versiones | `.gitignore` con `.env*` |
| RNF-11 | `APP_KEY` distinta por servicio | 3 claves en `.env` actuales |
| RNF-12 | Validación de toda entrada externa | Vine en auth; **pendiente** en trámites/pagos |
| RNF-13 | Protección de headers HTTP | `@adonisjs/shield` |
| RNF-14 | CORS restringido a orígenes permitidos | `@adonisjs/cors` (orígenes por configurar) |
| RNF-15 | Consultas parametrizadas (prevención de SQLi) | Lucid/Knex |
| RNF-16 | Actualizar contraseñas de ejemplo antes de producción | `.env` con credenciales por defecto |

### 10.4 Mantenibilidad

| ID | Requisito |
|---|---|
| RNF-17 | Código en TypeScript con tipado estricto y `typecheck` sin errores. |
| RNF-18 | Lint y formato automáticos (`eslint`, `prettier`). |
| RNF-19 | Cobertura de pruebas sobre el flujo de pago y los endpoints auth. |
| RNF-20 | Migraciones versionadas e idempotentes por servicio. |

### 10.5 Observabilidad

| ID | Requisito |
|---|---|
| RNF-21 | Logs estructurados en JSON (Pino) con niveles configurables. |
| RNF-22 | Endpoint de health check por servicio (`GET /`). |
| RNF-23 | Trazas distribuidas entre pagos y trámites (pendiente: OpenTelemetry). |
| RNF-24 | Métricas de latencia y tasa de error (pendiente: Prometheus). |

### 10.6 Mantenimiento y despliegue

| ID | Requisito |
|---|---|
| RNF-25 | Un solo `docker compose up` levanta la plataforma completa. |
| RNF-26 | Cada servicio se despliega y escala de forma independiente. |
| RNF-27 | Secretos gestionados por variables de entorno, no embebidos en la imagen. |

---

## 11. Hallazgos del análisis

Observaciones derivadas de la lectura del código. No son requisitos, sino
observaciones sobre el estado actual.

### 11.1 Inconsistencias funcionales

| # | Hallazgo | Ubicación | Impacto |
|---|---|---|---|
| H-01 | El controlador de pagos lee `id_tramite`, `metodo_pago`, `fecha_pago` (snake_case) pero el modelo `Pago` declara `idTramite`, `metodoPago`, `fechaPago` (camelCase). Lucid no expone las columnas en snake_case sin `parseColumn`, por lo que el mapeo no es evidente. | `pagos/app/controllers/pagos_controller.ts:11` vs `pagos/app/models/pago.ts` | **Alto** — Riesgo de columnas nulas o error en la inserción. |
| H-02 | `POST /api/v1/tramites` y `POST /api/v1/pagos` son públicas: cualquier cliente anónimo puede crear trámites y pagos. | `tramites/start/routes.ts:21`, `pagos/start/routes.ts:14` | **Alto** |
| H-03 | `GET /api/v1/usuarios` devuelve la lista completa de usuarios sin paginación ni filtro. | `usuarios/app/controllers/usuarios_controller.ts:6` | Medio |
| H-04 | `tramites.usuario_id` no tiene foreign key a `users.id`; se acepta cualquier `usuarioId`. | `tramites/database/migrations/1788911025790_create_tramites_table.ts:10` | Medio |
| H-05 | El servicio `pagos` expone rutas `signup`, `login`, `profile` contra un modelo `User` y una tabla `auth_access_tokens` en `pagos_db`; `usuarios` es el único servicio que gestiona usuarios. Duplicación de responsabilidad. | `pagos/start/routes.ts:19-38` | Medio |
| H-06 | El mensaje de error del flujo de pagos usa la clave `mensaje` mientras el servicio de trámites usa `message`. Inconsistencia de contrato entre servicios. | `pagos/app/controllers/pagos_controller.ts` vs `tramites/app/controllers/tramites_controller.ts:26` | Bajo |
| H-07 | `PATCH /api/v1/tramites/:id` permite transicionar a cualquier string sin validar contra una lista de estados válidos. | `tramites/app/controllers/tramites_controller.ts:42` | Medio |
| H-08 | `pagos` no tiene migración de la tabla `users` ni de `auth_access_tokens`, pero su `schema.ts` y su modelo `User` las asumen. | `pagos/database/` | **Alto** — Rutas de auth de `pagos` fallarán en runtime. |

### 11.2 Configuración e infraestructura

| # | Hallazgo | Detalle |
|---|---|---|
| H-09 | Los `Dockerfile` ejecutan `pnpm dev` (servidor de desarrollo con HMR) en lugar de un build de producción. No es apto para despliegue real. |
| H-10 | El `.env` de `usuarios` y `tramites` fija `DB_CONNECTION=sqlite`; Docker lo sobreescribe con `pg`. La configuración local y la de contenedores difieren. |
| H-11 | PostgreSQL se inicializa con `POSTGRES_DB=municipalidad`. `usuarios_db` y `pagos_db` deben crearse manualmente antes de migrar. |
| H-12 | `CORS_ORIGIN` está comentado en los tres `.env.example`: cualquier origen puede consumir la API. |
| H-13 | No hay migración inicial ni mecanismo de arranque que aplique migraciones automáticamente en los contenedores. |
| H-14 | Las contraseñas de ejemplo (`municipalidad_dev`) viven en `docker-compose.yml`, que sí se versiona. |
| H-15 | El `.gitignore` de la raíz sólo cubre `tramites/`; `usuarios/` y `pagos/` heredan los `.gitignore` propios. Conviene unificar. |
| H-16 | `TRAMITES_SERVICE_URL` está en `pagos/.env` pero **no** en `pagos/.env.example`, aunque `start/env.ts` la exige. Un despliegue siguiendo el ejemplo fallaría al arrancar. |

### 11.3 Calidad

| # | Hallazgo | Detalle |
|---|---|---|
| H-17 | No existen casos de prueba. `tests/` sólo contiene `bootstrap.ts`, pese a que Japa está configurado. |
| H-18 | No hay validadores Vine para trámites ni pagos; el `store` de ambos acepta `request.only()` sin validación. |
| H-19 | No hay manejo de errores de BD (violación de unique, campos inválidos) en los controladores. |
| H-20 | No hay logging de negocio: el registro de un pago y la compensación no dejan rastro auditable. |

---

## 12. Plan de trabajo sugerido

### Fase 1 — Corrección de bloqueantes

1. Resolver H-01: alinear la convención de nombres entre `Pago` y su controlador.
2. Resolver H-08: crear las migraciones de `users` y `auth_access_tokens` en `pagos`, o eliminar las rutas de auth de `pagos` y `tramites` (recomendado: H-05).
3. Cerrar H-02 y H-04: exigir `auth` en las rutas de escritura y validar la existencia del usuario.
4. Añadir `TRAMITES_SERVICE_URL` a `pagos/.env.example` (H-16).

### Fase 2 — Validación y seguridad

5. Implementar validadores Vine para trámites y pagos (H-18, RNF-12).
6. Definir catálogo de estados válidos y transiciones permitidas (H-07).
7. Unificar la clave de error a `message` en todos los servicios (H-06).
8. Configurar `CORS_ORIGIN` por entorno (H-12) y mover credenciales a `.env` (H-14).

### Fase 3 — Calidad y pruebas

9. Migrar los `Dockerfile` a build de producción multi-stage (H-09).
10. Escribir pruebas Japa para auth, trámites y el flujo de pago completo (H-17, RNF-19).
11. Añadir `npm run typecheck` y `lint` a un pipeline de CI.

### Fase 4 — Escalabilidad de producto

12. Paginación y filtros en los listados (RF-15, H-03).
13. Historial de estados de trámite y comprobantes de pago (RF-18, RF-19).
14. Roles y permisos diferenciados ciudadano/municipal (RF-20).
15. Observabilidad: OpenTelemetry y métricas Prometheus (RNF-23, RNF-24).

---

## 13. Glosario

| Término | Significado |
|---|---|
| **Trámite** | Solicitud administrativa que un ciudadano inicia ante la municipalidad (licencias, permisos, certificados). |
| **Pago** | Transacción económica asociada a un trámite, que lo lleva a estado `pagado`. |
| **Réplica** | Instancia adicional de un servicio, idéntica y sin estado propio. |
| **Failover** | Redirección automática del tráfico a otra réplica cuando una falla. |
| **Compensating transaction** | Deshacer una escritura previa cuando una segunda operación falla, en lugar de usar transacciones distribuidas. |
| **Tokens guard** | Estrategia de autenticación stateless basada en tokens de acceso persistidos. |
| **Fail-fast** | Fallar en el arranque si la configuración es inválida, en lugar de fallar en runtime. |
