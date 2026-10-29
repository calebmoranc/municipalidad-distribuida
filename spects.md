# Especificación Técnica — Sistema de Gestión Municipal

> Documento generado a partir del análisis del código fuente existente.
> Las secciones 2–13 describen la **especificación base (Jul. 2026)**. El apartado 0
> resume el **estado actual (Oct. 2026)**; en cada sección se anota lo que ya cambió.

---

## 0. Estado actual (Oct. 2026)

Delta respecto a la especificación base. Todo lo de abajo está implementado y verificado
con `./scripts/verificacion.sh` (76/76) y `EVIDENCIAS.txt`.

| Tema | Especificación base | Estado actual |
|---|---|---|
| **Identificador de usuario** | `users.id` autoincremental | **DNI (`varchar(8)`)** como PK. El registro exige `dni` (8 dígitos) |
| **Login** | correo + contraseña | igual (el `id` devuelto es el DNI) |
| **Ids de trámite/pago** | autoincrementales | códigos legibles `T1`, `T13`, `T222` y `P1`, `P333` (`varchar(12)`, hasta 11 dígitos), con secuencias PostgreSQL |
| **Catálogo de trámites** | no existía | tabla `tipos_tramite` (`nombre`, `monto`, `activo`) gestionada solo por admin; el tipo `Otro` deja fijar `tipoDetalle` y `monto` |
| **Roles y permisos** | pendiente | `users.rol`: `ciudadano`, `personal_muni_tesoreria`, `admin`; `servicio` para llamadas internas |
| **Autenticación entre servicios** | Bearer en todos | **identidad firmada** HMAC-SHA256 en `X-Identidad`; el token opaco solo se usa con `/account/*` |
| **Registro de pago** | un solo paso, con compensación por `DELETE` | **dos pasos**: `POST /pagos` deja `pendiente`; `POST /pagos/:id/confirmar` (solo privilegiado) acredita con **saga** (`pagos_intentos`) |
| **Gateway** | rutas de trámites/pagos/usuarios | además `/api/v1/auth`, `/api/v1/account`, `/api/v1/tipos-tramite`, `/api/v1/admin/usuarios`, `/api/v1/reloj/*`, `/api/v1/circuitos/*`, `/api/v1/intentos` |
| **Auth replicado en trámites/pagos** | duplicado | **eliminado**: solo usuarios tiene rutas `auth/account`, `Users` y `auth_access_tokens`; trámites y pagos usan `X-Identidad` |
| **Consulta de usuario** | no existía | trámites y pagos validan al usuario por HTTP (`GET /api/v1/usuarios/:id`) |
| **Estados del trámite** | texto libre | catálogo `pendiente`, `en_revision`, `pagado`, `rechazado`, `anulado`, transiciones validadas (`estados.ts`) e **historial inmutable** en `tramites_eventos` |
| **Cola offline** | no existía | la UI guarda trámites no enviados en `localStorage` y los reintenta; el servidor garantiza idempotencia con `(usuario_id, clave_idempotencia)`, conserva `creado_cliente_en` y marca `origen='offline'` |
| **Acceso remoto** | solo localhost | túnel HTTPS temporal con `cloudflared` (`scripts/tunel.sh`, perfil `tunel`); la URL cambia al reiniciar |

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

**Nota de despliegue:** los `Dockerfile` son multi-stage: compilan con `node ace build`,
instalan solo dependencias de producción y ejecutan `node bin/server.js` con
`NODE_ENV=production`. Ya no se sirve con el servidor de desarrollo.

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

### 3.1 Anatomía de los servicios

La estructura es común a los tres; solo el servicio de usuarios incluye el stack de auth.

| Ruta | Responsabilidad |
|---|---|
| `app/controllers/` | Handlers HTTP. Usuarios incluye el stack de auth (`AccessTokens`, `NewAccount`, `Profile`); trámites y pagos solo sus controladores de dominio. |
| `app/models/` | Modelos Lucid: `User` en usuarios; `Tramite` y `TipoTramite` en trámites; `Pago` y `PagoIntento` en pagos. |
| `app/middleware/` | `container_bindings_middleware` y `force_json_response_middleware`; solo usuarios tiene `auth_middleware`/`silent_auth_middleware`. |
| `app/validators/` | Esquemas Vine de usuarios (signup/login y alta con rol); la identidad solo existe aquí. |
| `app/transformers/` | Forma de la respuesta JSON (solo usuarios: `UserTransformer`; excluye password). |
| `app/exceptions/handler.ts` | Traducción de excepciones a respuestas HTTP. |
| `config/` | `app`, `database`, `bodyparser`, `cors`, `encryption`, `hash`, `logger`, `session`, `shield` (y `auth` solo en usuarios). |
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
| POST | `/api/v1/auth/signup` | No | Crear cuenta (`ciudadano`) y emitir token | `200 {user, token, identidad}` |
| POST | `/api/v1/auth/login` | No | Verificar credenciales y emitir token | `200 {user, token, identidad}` |
| GET | `/api/v1/account/profile` | Sí | Perfil autenticado (renueva la identidad) | `200 {user, identidad}` |
| POST | `/api/v1/account/logout` | Sí | Revocar el token actual | `200 {message}` |
| POST | `/api/v1/usuarios` | No | Registro público; **exige `dni`**; el rol siempre es `ciudadano` | `200 {user, token, identidad}` |
| POST | `/api/v1/admin/usuarios` | Sí (**admin**) | Alta con rol elegido (`ciudadano`, `personal_muni_tesoreria`, `admin`) | `200 user` |
| GET | `/api/v1/usuarios` | Sí (**admin**) | Listar usuarios | `200 [user]` |
| GET | `/api/v1/usuarios/:id` | No | Obtener usuario por DNI | `200 user` / `404` |

**Payloads**

```jsonc
// POST /api/v1/auth/signup  (signupValidator)
{
  "dni": "string",                // 8 dígitos, único en users.id
  "fullName": "string|null",      // opcional
  "email": "string",              // formato email, máx 254, único en users.email
  "password": "string",           // 8–32 caracteres
  "passwordConfirmation": "string"// debe coincidir con password
}

// POST /api/v1/admin/usuarios  (crearUsuarioValidator)
// igual que el anterior + "rol": "ciudadano|personal_muni_tesoreria|admin"

// POST /api/v1/auth/login  (loginValidator)
{ "email": "string", "password": "string" }
```

**Respuesta de auth**

```jsonc
{
  "user": { "id": "10000001", "fullName": "…", "email": "…", "rol": "admin",
            "createdAt": "…", "updatedAt": "…", "initials": "AB" },
  "token": "<access token opaco>",
  "identidad": "<HMAC firmado: id + rol + caducidad>"
}
```

El campo `password` está marcado `serializeAs: null`, por lo que **nunca** aparece en
las respuestas.

### 4.2 Servicio Trámites

Base de datos: `municipalidad`.

| Método | Ruta | Auth | Descripción | Respuesta |
|---|---|---|---|---|
| GET | `/` | No | Health check | `200 {hello:"world"}` |
| GET | `/api/v1/tramites` | `X-Identidad` | Listar trámites (ciudadano: solo los suyos) | `200 [tramite]` |
| POST | `/api/v1/tramites` | `X-Identidad` | Crear trámite (valida el usuario por HTTP) | `201 tramite` |
| GET | `/api/v1/tramites/:id` | `X-Identidad` | Detalle de un trámite | `200 tramite` / `404 {message}` |
| GET | `/api/v1/tramites/:id/eventos` | `X-Identidad` | Historial de estados (eventos inmutables con sello Lamport) | `200 [evento]` / `404 {message}` |
| PATCH | `/api/v1/tramites/:id` | `X-Identidad` | Cambiar estado (catálogo y transiciones validadas); el admin además tipo/descripción/monto | `200 tramite` / `400` / `403` / `404 {message}` |
| DELETE | `/api/v1/tramites/:id` | `X-Identidad` (**admin**) | Eliminar un trámite | `200 {message, id}` / `403` |
| GET | `/api/v1/tipos-tramite` | `X-Identidad` | Catálogo de tipos y montos | `200 [tipo]` |
| POST/PATCH/DELETE | `/api/v1/tipos-tramite[/:id]` | `X-Identidad` (**admin**) | Gestionar el catálogo | `201` / `200` / `403` |

**Payloads**

```jsonc
// POST /api/v1/tramites — tipo del catálogo (el monto lo fija la BD)
{ "usuarioId": "10000001", "tipo": "Licencia de funcionamiento", "descripcion": "…" }

// POST /api/v1/tramites — tipo "Otro" (monto libre)
{ "usuarioId": "10000001", "tipo": "Otro", "tipoDetalle": "…",
  "monto": 5000, "descripcion": "…" }
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
| GET | `/api/v1/pagos` | `X-Identidad` | Listar pagos (ciudadano: solo los suyos) | `200 [pago]` |
| POST | `/api/v1/pagos` | `X-Identidad` | Registrar **solicitud** de pago (nace `pendiente`) | `201 pago` |
| POST | `/api/v1/pagos/:id/confirmar` | `X-Identidad` (**privilegiado**) | Acreditar pago y trámite (saga) | `200 pago` / `403` |
| GET | `/api/v1/intentos` | No | Intenciones de pago registradas | `200 {porEstado, ultimos}` |
| POST | `/api/v1/intentos/reconciliar` | No | Forzar una pasada del reconciliador | `200 {confirmados, revertidos, pendientes}` |

**Payload**

```jsonc
// POST /api/v1/pagos
{ "id_tramite": "T1", "usuario_id": "10000001", "monto": 15000.00,
  "metodo_pago": "tarjeta", "fecha_pago": "2026-01-15T10:00:00Z" }
// estado lo fija el servidor: "pendiente". El ciudadano no envía usuario_id
// (lo impone su identidad firmada).
```

### 4.4 Reglas de enrutamiento del gateway

| Path match | Upstream |
|---|---|
| `/tramites`, `/api/v1/tramites`, `/api/v1/tipos-tramite` | `tramites_1`, `tramites_2` |
| `/api/v1/auth`, `/api/v1/account`, `/api/v1/usuarios`, `/api/v1/admin/usuarios` | `usuarios_1`, `usuarios_2` |
| `/api/v1/pagos`, `/api/v1/intentos` | `pagos_1`, `pagos_2` |
| `/api/v1/reloj/{usuarios,tramites,pagos}`, `/api/v1/circuitos/{tramites,pagos}` | servicio correspondiente |
| `/health`, `/ui/` | nginx (estático) |

Política de failover: `max_fails=1 fail_timeout=10s`, reintento en `error`, `timeout`,
`502`, `503`, `504`, hasta 2 intentos. Se propagan `Host` y `X-Real-IP`.

---

## 5. Modelo de datos

### 5.1 `users` (servicio Usuarios)

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | **string(8)** | PK, not null (es el **DNI**) |
| `full_name` | string | nullable |
| `email` | string(254) | not null, **unique** |
| `password` | string | not null (hash) |
| `rol` | string(40) | not null, default `'ciudadano'` |
| `created_at` | timestamp | not null |
| `updated_at` | timestamp | nullable |

Índices únicos en `email`; `id` es la PK y guarda el DNI.

### 5.2 `auth_access_tokens` (servicio Usuarios)

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | increments | PK |
| `tokenable_id` | **string(8)** | not null, **FK → users.id ON DELETE CASCADE** (DNI) |
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
| `id` | **string(12)** | PK (`T1`…, hasta 11 dígitos, generado con `tramites_num_seq`) |
| `usuario_id` | **string(8)** | not null (DNI) |
| `tipo` | string(100) | not null (nombre del catálogo o `Otro`) |
| `tipo_detalle` | string(200) | nullable (solo `Otro`) |
| `descripcion` | text | not null |
| `monto` | decimal(10,2) | not null, default `0` |
| `estado` | string(30) | not null, default `'pendiente'` |
| `version` | integer | not null, default `1` (concurrencia optimista) |
| `lamport` | integer | nullable (reloj lógico) |
| `node_id` | string(100) | nullable (réplica) |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

Además existe **`tipos_tramite`**: `id` (increments), `nombre` (string(100), unique),
`monto` (decimal(10,2)), `activo` (boolean, default `true`), timestamps.

### 5.3.1 `tramites_eventos` (servicio Trámites)

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | increments | PK |
| `tramite_id` | string(12) | not null, FK → `tramites.id` **ON DELETE CASCADE** |
| `estado_anterior` | string(30) | nullable (null solo en la creación) |
| `estado_nuevo` | string(30) | not null |
| `actor_id` | string(20) | nullable (DNI o `servicio`) |
| `lamport` | integer | not null (sello inmutable del evento) |
| `node_id` | string(100) | not null |
| `created_at` | timestamp | not null |

Cada creación y cada cambio de estado insertan una fila; los eventos no se editan.
Así el sello de creación sobrevive aunque `tramites.lamport`/`node_id` se actualicen.

Cada `PATCH` incrementa `tramites.version` dentro de un `UPDATE ... WHERE version = ?`.
Si otra escritura ganó la carrera, afecta 0 filas y responde **409**; el cliente puede
enviar la `version` que leyó para detectar antes los datos viejos. La verificación 2.10
comprueba el caso correcto y el rechazo de una escritura con versión vieja.

### 5.4 `pagos` (servicio Pagos)

| Columna | Tipo | Restricciones |
|---|---|---|
| `id_pago` | **string(12)** | PK (`P1`…, hasta 11 dígitos, con `pagos_num_seq`) |
| `id_tramite` | **string(12)** | not null (`T1`…) |
| `usuario_id` | **string(8)** | nullable (DNI); el controlador lo exige |
| `monto` | decimal(10,2) | not null |
| `metodo_pago` | string | not null |
| `fecha_pago` | timestamp | not null |
| `estado` | string | not null, default `'pendiente'` |
| `lamport` | integer | nullable |
| `node_id` | string(100) | nullable |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

Y la tabla de la saga **`pagos_intentos`**: `id` (increments), `id_tramite` string(12),
`usuario_id` string(8), `pago_id` string(12) nullable, `estado`
(`pendiente|confirmado|revertido`), `intentos`, `ultimo_error`, `lamport`, `node_id`,
timestamps. |

### 5.5 Diagrama de relaciones

```
usuarios_db                          municipalidad            pagos_db
┌──────────────┐                    ┌──────────────┐          ┌──────────────┐
│    users     │                    │   tramites   │          │    pagos     │
│──────────────│                    │──────────────│          │──────────────│
│ id(DNI) PK   │◄──┐                │ id(T1)  PK   │          │ id_pago(P1)PK│
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

Solo el servicio de usuarios implementa el stack de auth (rutas `/auth/*` y `/account/*`,
`config/auth.ts`, tablas `users`/`auth_access_tokens`). Trámites y pagos eliminaron ese
andamiaje: no crean esas tablas y no consultan el token opaco.

Además del token opaco, existe una **identidad firmada** (`X-Identidad`): un HMAC-SHA256
de `{ id (DNI), rol, exp, jti }` que el servicio de usuarios emite al hacer login/signup y
que trámites, pagos y el listado de usuarios verifican **localmente**, sin llamar a usuarios.
El secreto es `AUTH_IDENTITY_SECRET` (TTL 12 h; 120 s cuando el rol es `servicio`). Se
acepta también `AUTH_IDENTITY_SECRET_ANTERIOR` durante la rotación. El `jti` permite
revocar una identidad concreta: se anota en `identidades_revocadas` y los servicios de
dominio cachean la lista (`REVOCACION_TTL_MS`, 5 s).

Guard por defecto: `api` (tokens). Configurado en `config/auth.ts`:

- **`api`** — `tokensGuard` + `tokensUserProvider`, modelo `User`, tabla de tokens
  `auth_access_tokens`. Apropiado para APIs stateless.
- **`web`** — `sessionGuard`, con remember-me desactivado. Reservado para el futuro
  frontend con SSR.

### 6.2 Flujo

En el servicio de usuarios:

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
- R3. `signup` devuelve token **e identidad**: no se requiere un login adicional.
- R4. `logout` revoca el token actual de la BD, no solo del cliente.
- R5. El email es único y el **DNI** (`users.id`) también.
- R6. Rutas de dominio exigen `X-Identidad`; `/account/*` además exige el token.
- R7. La validación de DNI, email y password es obligatoria antes de tocar la BD.

### 6.4 Roles

| Rol | Alcance |
|---|---|
| `ciudadano` | Solo ve y crea lo suyo; **solicita** pagos (quedan `pendiente`) |
| `personal_muni_tesoreria` | Ve todo y **confirma** pagos |
| `admin` | Todo lo anterior + CRUD de trámites, catálogo y alta de usuarios con rol |
| `servicio` | Identidad interna de corta vida para pagos/reconciliador |

---

## 7. Flujo de negocio crítico: registro de pago

Es el único flujo multi-servicio y concentra el riesgo de consistencia. En el modelo
actual **se divide en dos pasos**: la solicitud (ciudadano) y la confirmación
(privilegiado), coordinadas por una **saga** persistida en `pagos_intentos`.

### 7.1 Paso 1 — solicitud (`POST /api/v1/pagos`)

```
 Cliente        pagos            gateway          tramites
   │             │                 │                 │
   ├─ POST /api/v1/pagos ────────►│                 │
   │             │ 1. GET /api/v1/tramites/:id ────►│
   │             │◄───────────────┼─────────────────┤
   │             │   404 → 400 "El trámite indicado no existe"
   │             │ 2. valida el usuario por HTTP (GET /api/v1/usuarios/:id)
   │             │ 3. INSERT intento (pendiente) + INSERT pago (pendiente)
   │◄─ 201 pago ──┤   (el pago NO acredita todavía)
```

### 7.2 Paso 2 — confirmación (`POST /api/v1/pagos/:id/confirmar`)

```
   ├─ POST /pagos/P1/confirmar ──►│
   │             │ 1. PATCH trámite {estado:"pagado"}  (idempotente)
   │             │ 2. UPDATE pago  {estado:"pagado"}  + marca intento confirmado
   │◄─ 200 pago ──┤
```

- **Idempotencia:** reintentar la confirmación no vuelve a aplicar el PATCH.
- **Fallo inyectable:** con `PAGOS_FALLAR_ANTES_DE_PATCH=true`, el proceso aborta
  (`process.exit(70)`) entre PATCH y UPDATE; la saga deja el intento en `pendiente`.
- **Reconciliador:** `POST /api/v1/intentos/reconciliar` recorre los intentos
  pendientes y los confirma o revierte según el estado real.

**Errores del flujo**

| Situación | Código | Mensaje |
|---|---|---|
| Trámite inexistente | 400 | `El trámite indicado no existe` |
| Trámite no verificable | 503 | `No se pudo verificar el trámite` |
| Servicio caído | 503 | `No se pudo conectar con el servicio de trámites` |
| Confirmar sin privilegio | 403 | — |
| Actualización fallida (pago revertido) | 503 | `No se pudo actualizar el trámite. El pago fue eliminado.` |

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
| `DB_CONNECTION` | string | Sí | Todos | `pg` en Docker (los `.env` locales traen `sqlite`) |
| `DB_HOST` | string | Sí (pg) | Todos | `postgres` en Docker |
| `DB_PORT` | number | Sí (pg) | Todos | `5432` |
| `DB_USER` | string | Sí (pg) | Todos | `municipalidad` |
| `DB_PASSWORD` | string | Sí (pg) | Todos | `municipalidad_dev` |
| `DB_DATABASE` | string | Sí (pg) | Todos | por servicio |
| `TRAMITES_SERVICE_URL` | string | Sí | **pagos** | `http://gateway` |
| `USUARIOS_SERVICE_URL` | string | Sí | tramites, pagos | `http://gateway` |
| `AUTH_IDENTITY_SECRET` | secret | No | Todos | `municipalidad-identidad-dev` |
| `AUTH_IDENTITY_SECRET_ANTERIOR` | secret | No | Todos | vacío (secreto que se acepta durante la rotación) |
| `REVOCACION_TTL_MS` | number | No | tramites, pagos | 5000 (caché de identidades revocadas) |
| `NODE_ID` | string | No | Todos | nombre de la réplica (reloj lógico) |
| `PAGOS_FALLAR_ANTES_DE_PATCH` | boolean | No | pagos | `false` (demo de saga) |
| `PAGOS_INTENTOS_ANTIGUEDAD_SEG` | number | No | pagos | 30 |
| `CORS_ORIGIN` | lista | No | Todos | comentado (deshabilitado) |
| `HTTP_TIMEOUT_MS` | number | No | tramites, pagos | 2000 |
| `HTTP_REINTENTOS` | number | No | tramites, pagos | 1 (base) |
| `HTTP_REINTENTOS_TRAMITES` | number | No | pagos | hereda `HTTP_REINTENTOS` |
| `HTTP_REINTENTOS_USUARIOS` | number | No | tramites, pagos | hereda `HTTP_REINTENTOS` |
| `CIRCUIT_UMBRAL` | number | No | tramites, pagos | 3 |
| `CIRCUIT_ABIERTO_MS` | number | No | tramites, pagos | 10000 |

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
| RF-14 | Filtrar trámites por usuario | tramites | **Implementado** |
| RF-15 | Paginación y filtros en listados | todos | Pendiente |
| RF-16 | Validación de entrada en trámites y pagos | tramites, pagos | **Parcial** (manual en el controlador; sin esquemas Vine) |
| RF-17 | Proteger rutas de escritura con autenticación (`X-Identidad`) | tramites, pagos | **Implementado** |
| RF-18 | Historial de estados del trámite | tramites | **Implementado** (`tramites_eventos` + `GET /tramites/:id/eventos`) |
| RF-19 | Comprobantes / recibo de pago | pagos | Pendiente |
| RF-20 | Roles y permisos (`ciudadano`, `personal_muni_tesoreria`, `admin`) | todos | **Implementado** |
| RF-21 | Revocación de identidades antes de su caducidad | usuarios, tramites, pagos | **Implementado** (`jti` + lista cacheada) |
| RF-22 | Encolar y reintentar trámites creados sin conexión, sin duplicarlos | tramites, UI | **Implementado** (`localStorage` + `Idempotency-Key`) |

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
| RNF-28 | Concurrencia optimista en escrituras de trámites: `version` + `409` si la fila cambió. |
| RNF-29 | Rotación de secretos sin cortar sesiones y revocación individual de identidades por `jti`. |
| RNF-30 | Idempotencia en la creación de trámites: la misma clave devuelve el trámite existente (`200`, `Idempotent-Replay`). |
| RNF-31 | Acceso desde internet mediante túnel HTTPS temporal, sin abrir PostgreSQL ni los microservicios. |

---

## 11. Hallazgos del análisis

Observaciones derivadas de la lectura del código. No son requisitos, sino
observaciones sobre el estado actual.

### 11.1 Inconsistencias funcionales

> Estado Oct. 2026: **H-01 … H-08 resueltos**. Se conserva el registro histórico y se
> anota la solución aplicada.

| # | Hallazgo (base) | Solución actual |
|---|---|---|
| H-01 | snake_case vs camelCase en `Pago` | Resuelto: el controlador y el modelo usan las columnas snake_case con `parseColumn`/`serialize` consistentes. |
| H-02 | Escrituras públicas | Resuelto: todas las rutas de dominio exigen `X-Identidad`; el ciudadano solo actúa sobre lo suyo. |
| H-03 | `GET /api/v1/usuarios` sin control | Resuelto: exige rol `admin`. |
| H-04 | `usuario_id` sin validar | Resuelto: se valida por HTTP contra `usuarios` antes de persistir. |
| H-05 | Auth duplicado en pagos/trámites | **Resuelto**: se eliminó el andamiaje de auth de esos servicios (rutas, controladores, modelo y migraciones). |
| H-06 | `mensaje` vs `message` | Se mantiene consciente: pagos usa `mensaje`, trámites `message`. |
| H-07 | Estados sin catálogo | **Resuelto**: catálogo y transiciones en `tramites/app/services/estados.ts`; `PATCH` rechaza textos y transiciones inválidas (400). |
| H-08 | `users`/`auth_access_tokens` en pagos | **Resuelto**: ya no se crean esas tablas en `pagos_db` ni en la base de trámites. |

### 11.1.1 Nuevos hallazgos (Oct. 2026)

| # | Hallazgo | Impacto |
|---|---|---|
| H-21 | **Resuelto**: los códigos pasan a `varchar(12)` (`T`/`P` + hasta 11 dígitos) mediante `1792100…_ampliar_codigos.ts`; ya no se agota el rango de 3 dígitos. | — |
| H-22 | **Resuelto**: sin andamiaje de auth en trámites ni pagos, reenviar `Authorization` ya no busca `auth_access_tokens`. | — |
| H-23 | **Resuelto**: cada identidad lleva `jti`; logout y `POST /auth/revocar` lo anotan y trámites/pagos lo consultan desde una caché de 5 s. | — |
| H-24 | **Resuelto**: las escrituras concurrentes de trámites usan `version` optimista y responden 409 si la fila cambió. | — |
| H-25 | **Resuelto**: la creación de trámites acepta `Idempotency-Key`; el unique por usuario evita duplicados al reintentar una cola offline. | — |
| H-26 | **Resuelto**: la UI conserva fecha y origen originales (`creado_cliente_en`, `origen`) y ordena por la fecha de solicitud. | — |

### 11.2 Configuración e infraestructura

| # | Hallazgo | Detalle |
|---|---|---|
| H-09 | **Resuelto**: build multi-stage con `node ace build`, dependencias de producción y `node bin/server.js`. |
| H-10 | El `.env` de `usuarios` y `tramites` fija `DB_CONNECTION=sqlite`; Docker lo sobreescribe con `pg`. La configuración local y la de contenedores difieren. |
| H-11 | PostgreSQL se inicializa con `POSTGRES_DB=municipalidad`. `usuarios_db` y `pagos_db` deben crearse manualmente antes de migrar. |
| H-12 | `CORS_ORIGIN` está comentado en los tres `.env.example`: cualquier origen puede consumir la API. |
| H-13 | **Resuelto**: el contenedor `tramites_migrate` ejecuta `migration:run --force && db:seed`. |
| H-14 | Las contraseñas de ejemplo (`municipalidad_dev`) viven en `docker-compose.yml`, que sí se versiona. |
| H-15 | El `.gitignore` de la raíz sólo cubre `tramites/`; `usuarios/` y `pagos/` heredan los `.gitignore` propios. Conviene unificar. |
| H-16 | **Resuelto**: `TRAMITES_SERVICE_URL` y `USUARIOS_SERVICE_URL` figuran en los `.env.example`. |

### 11.3 Calidad

| # | Hallazgo | Detalle |
|---|---|---|
| H-17 | **Resuelto**: 44 pruebas Japa unitarias/de auth y `scripts/integracion_pagos.sh` (18 comprobaciones) cubren el flujo de pago en dos pasos contra el stack real. |
| H-18 | No hay validadores Vine para trámites ni pagos; el `store` de ambos acepta `request.only()` sin validación. |
| H-19 | **Parcial**: el `store` de trámites captura la violación `23505` para devolver el trámite idempotente; el resto de errores de BD sigue sin manejo específico. |
| H-20 | No hay logging de negocio: el registro de un pago y la compensación no dejan rastro auditable. |

---

## 12. Plan de trabajo sugerido

> Fases 1–4 mayormente completadas. Lo que sigue es el trabajo pendiente real.

### Pendiente prioritario

1. **Observabilidad**: OpenTelemetry y métricas Prometheus (RNF-23, RNF-24).

### Mejoras de producto

2. Paginación y filtros en los listados (RF-15, H-03 parcial).
3. Comprobantes de pago (RF-19) y mostrar el historial de estados en la interfaz.
4. CORS por entorno (H-12) y endurecimiento de secretos por servicio (H-14).

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
| **DNI** | Documento de identidad; en el sistema es la PK de `users` (`varchar(8)`). |
| **Código T/P** | Identificador legible de trámite (`T…`) o pago (`P…`) generado con secuencia. |
| **Identidad firmada** | HMAC-SHA256 de `{id, rol, exp}` en `X-Identidad`, verificada sin llamada remota. |
| **Saga** | Secuencia de pasos compensables persistida en `pagos_intentos` para acreditar un pago. |
| **Reloj de Lamport** | Contador lógico por servicio/réplica para ordenar eventos (demo de concurrencia). |
