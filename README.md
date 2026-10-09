# Municipalidad — plataforma distribuida de trámites

Proyecto de Sistemas Operativos II. Tres microservicios independientes que gestionan
usuarios, trámites y pagos de una municipalidad, desplegados con Docker Compose y
expuestos a través de un gateway Nginx.

---

## 1. Arquitectura

```
                      ┌──────────────┐
   cliente ─────────▶ │    gateway   │  nginx:alpine  (host :8080 → :80)
                      └──────┬───────┘
             ┌───────────────┼───────────────┐
             ▼               ▼               ▼
      ┌────────────┐  ┌────────────┐  ┌────────────┐
      │ usuarios_1 │  │ tramites_1 │  │  pagos_1   │   2 réplicas por servicio
      │ usuarios_2 │  │ tramites_2 │  │  pagos_2   │   (round-robin en el gateway)
      └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
            │               │               │
      ┌─────┴───────────────┴───────────────┴──────┐
      │                  postgres                   │   3 bases separadas:
      │        municipalidad / usuarios_db / pagos_db │   una por servicio
      └────────────────────────────────────────────┘
```

Regla de la arquitectura: **toda llamada entre servicios pasa por el gateway**, nunca
directo de un servicio a otro. Por eso los servicios usan `http://gateway` como URL.

### Topología con IP fijas

| Contenedor | IP | Puerto host | Puerto interno |
|---|---|---|---|
| `municipalidad_postgres` | 172.28.0.10 | — | 5432 |
| `usuarios_1` | 172.28.0.11 | 3335 | 3333 |
| `usuarios_2` | 172.28.0.12 | 3336 | 3333 |
| `tramites_1` | 172.28.0.13 | 3333 | 3333 |
| `tramites_2` | 172.28.0.14 | 3334 | 3333 |
| `pagos_1` | 172.28.0.15 | 3337 | 3333 |
| `pagos_2` | 172.28.0.16 | 3338 | 3333 |
| `municipalidad_gateway` | 172.28.0.20 | 8080 | 80 |

> **Por qué las IP son fijas.** Nginx resuelve los nombres de los `upstream` **una sola
> vez, al arrancar**. Si un contenedor se recrea, Docker le puede asignar otra IP y
> nginx se queda hablando con la IP antigua, que ya pertenece a otro servicio. Pasó
> en la práctica: nginx mandaba peticiones de `/api/v1/usuarios/1` a `tramites_2`, que
> respondía 404. Con IP fijas la topología es siempre la misma.

---

## 2. Puesta en marcha

```bash
docker compose up -d --build     # la primera vez tarda: instala dependencias y genera código
docker compose ps -a             # postgres y las 6 réplicas en (healthy)
```

Para empezar de cero y borrar todos los datos:

```bash
docker compose down -v           # -v borra el volumen: se pierde la base de datos
docker compose up -d --build
```

### Contenedores de un solo uso

| Servicio | Qué hace | Resultado esperado |
|---|---|---|
| `db_init` | Crea `usuarios_db` y `pagos_db` (PostgreSQL solo crea la de `POSTGRES_DB`) | `Exited (0)` |
| `tramites_migrate` | `node ace migration:run --force` sobre `municipalidad` | `Exited (0)` |
| `usuarios_migrate` | `node ace migration:run --force` sobre `usuarios_db` | `Exited (0)` |
| `pagos_migrate` | `node ace migration:run --force` sobre `pagos_db` | `Exited (0)` |

Existe un contenedor de migración por servicio (y no las migraciones en el arranque de
cada réplica) para que las dos réplicas **no apliquen migraciones al mismo tiempo** sobre
la misma base.

`db_init` corre en cada `docker compose up` a propósito: los scripts de
`/docker-entrypoint-initdb.d/` de PostgreSQL solo se ejecutan cuando el volumen está
vacío, así que no sirven para un volumen ya inicializado.

---

## 3. Endpoints

Acceso normal por el gateway: `http://localhost:8080`.

### Servicio usuarios

| Método | Ruta | Descripción | ¿Por el gateway? |
|---|---|---|---|
| GET | `/api/v1/usuarios` | Listar usuarios | Sí |
| GET | `/api/v1/usuarios/:id` | Obtener un usuario (404 si no existe) | Sí |
| POST | `/api/v1/usuarios` | Crear usuario | Sí |
| POST | `/api/v1/auth/signup` | Registrarse | **No** |
| POST | `/api/v1/auth/login` | Iniciar sesión | **No** |
| GET | `/api/v1/account/profile` | Perfil (requiere token) | **No** |
| POST | `/api/v1/account/logout` | Revocar token | **No** |

### Servicio trámites

| Método | Ruta | Descripción | ¿Por el gateway? |
|---|---|---|---|
| GET | `/api/v1/tramites` | Listar trámites | Sí |
| POST | `/api/v1/tramites` | Crear trámite (**valida el usuario**) | Sí |
| GET | `/api/v1/tramites/:id` | Obtener un trámite | Sí |
| PATCH | `/api/v1/tramites/:id` | Cambiar `estado` | Sí |
| POST | `/api/v1/auth/*`, `/api/v1/account/*` | Stack de auth replicado | **No** |

### Servicio pagos

| Método | Ruta | Descripción | ¿Por el gateway? |
|---|---|---|---|
| GET | `/api/v1/pagos` | Listar pagos | Sí |
| POST | `/api/v1/pagos` | Registrar pago (**valida trámite y usuario**) | Sí |
| POST | `/api/v1/auth/*`, `/api/v1/account/*` | Stack de auth replicado | **No** |

### Gateway

| Ruta | Qué hace |
|---|---|
| `GET /health` | Sonda del propio nginx. Responde 200 **sin tocar ningún servicio**, así que distingue "nginx caído" de "servicios caídos". |

> **Limitación conocida:** `/api/v1/auth/*` y `/api/v1/account/*` existen en los tres
> servicios pero el gateway **no las enruta**, así que no son accesibles por el puerto
> 8080. Hay que llamar al puerto del host directamente (3335/3336, 3333/3334, 3337/3338).

---

## 4. Comunicación entre servicios

### 4.1 Crear un trámite

```
cliente ──POST /api/v1/tramites──▶ gateway ──▶ tramites_1 o tramites_2
                                                     │
                                    ┌────────────────┘
                                    ▼
                     GET gateway/api/v1/usuarios/:usuarioId
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
           200                404                     error/timeout
      el usuario existe    → 400                  → 503
                             "El usuario           "No se pudo
                              indicado no           verificar el
                              existe"               usuario"
              └──────────────────────┴──────────────────────┘
                                     ▼
                            INSERT en tramites
```

### 4.2 Registrar un pago

```
cliente ──POST /api/v1/pagos──▶ gateway ──▶ pagos_1 o pagos_2
                                        │
    1. GET gateway/tramites/:id_tramite ─┤ 404 → 400 "El trámite indicado no existe"
                                        │
    2. GET gateway/usuarios/:usuario_id  ─┤ 404 → 400 "El usuario indicado no existe"
                                        │ error → 503
                                        │
    3. INSERT en pagos (incluye usuario_id)
                                        │
    4. PATCH gateway/tramites/:id  estado="pagado"
                                        │
        ┌───────────────────────────────┴──────────────┐
        ▼                                              ▼
    200 → 201 con el pago                    error/5xx → DELETE del pago
                                              y 503 (transacción compensatoria)
```

El paso 4 es una **compensación**: si el pago se guardó pero el trámite no se pudo
actualizar, el pago se borra para no dejar el sistema en estado inconsistente.

### 4.3 Qué datos necesita cada servicio

| Servicio | Necesita de sus clientes | Consulta a otros servicios |
|---|---|---|
| usuarios | `email`, `password`, `fullName` | — |
| tramites | `usuarioId`, `tipo`, `descripcion` | `usuarios`: solo necesita saber si el usuario existe |
| pagos | `usuario_id`, `id_tramite`, `monto`, `metodo_pago`, `fecha_pago`, `estado` | `tramites`: que el trámite exista. `usuarios`: que el usuario exista |

### 4.4 Las validaciones son reales, no confianza en el cliente

El `usuarioId` que envía el cliente se usa **solo como parámetro de búsqueda**. La
autoridad es la respuesta del servicio `usuarios`, que viaja por el gateway como una
llamada HTTP real. Se puede comprobar parando el servicio:

```bash
docker compose stop usuarios_1 usuarios_2

# usuarioId=1 SÍ existe en la base, pero usuarios está caído:
curl -X POST http://localhost:8080/api/v1/tramites \
  -H 'Content-Type: application/json' \
  -d '{"usuarioId":1,"tipo":"x","descripcion":"y"}'
# {"message":"No se pudo verificar el usuario"}   ← no crea el trámite

docker compose start usuarios_1 usuarios_2
```

---

## 5. Modelo de datos

Una base de datos por servicio. **No hay foreign keys entre servicios**: cada servicio
sólo conoce su propio esquema, y las referencias se validan por HTTP.

### `municipalidad` (servicio trámites)

| Tabla | Columnas |
|---|---|
| `tramites` | `id`, `usuario_id`, `tipo`, `descripcion`, `estado` (default `pendiente`), `created_at`, `updated_at` |
| `users`, `auth_access_tokens` | Restos del stack de auth replicado; no las usa trámites |

### `usuarios_db` (servicio usuarios)

| Tabla | Columnas |
|---|---|
| `users` | `id`, `full_name`, `email`, `password`, `created_at`, `updated_at` |
| `auth_access_tokens` | `id`, `tokenable_id`, `type`, `name`, `hash`, `abilities`, `*_at` |

### `pagos_db` (servicio pagos)

| Tabla | Columnas |
|---|---|
| `pagos` | `id_pago`, `id_tramite`, `usuario_id`, `monto`, `metodo_pago`, `fecha_pago`, `estado` (default `pendiente`), `created_at`, `updated_at` |

> `usuario_id` es **nullable a propósito**: la tabla ya tenía filas de pruebas anteriores
> y no hay forma de saber de qué usuario eran. Si se declarara `NOT NULL` habría que
> borrarlas o inventar un usuario. La obligatoriedad se aplica en el controlador, que
> rechaza cualquier pago sin `usuario_id`.

---

## 6. Variables de entorno

| Variable | Servicio | Valor en Docker | Para qué |
|---|---|---|---|
| `DB_HOST` | los 3 | `postgres` | Host de PostgreSQL |
| `DB_DATABASE` | tramites | `municipalidad` | Base del servicio |
| `DB_DATABASE` | usuarios | `usuarios_db` | Base del servicio |
| `DB_DATABASE` | pagos | `pagos_db` | Base del servicio |
| `APP_KEY` | los 3 | (secreto) | Cifrado y cookies de sesión |
| `USUARIOS_SERVICE_URL` | tramites, pagos | `http://gateway` | Validación de usuario |
| `TRAMITES_SERVICE_URL` | pagos | `http://gateway` | Validación y actualización del trámite |

Cada servicio declara sus variables en `start/env.ts` y **falla al arrancar** si falta
alguna. Las de ejemplo están en `<servicio>/.env.example`.

> `.env` está excluido del contexto de Docker (`.dockerignore`) y las credenciales viajan
> por `env_file` + `environment` en `docker-compose.yml`. Por eso los `Dockerfile` pasan
> variables de mentira en el paso de `codegen` y no como `ENV`: no quedan en la imagen.

---

## 7. Comandos útiles

```bash
# Estado de todo
docker compose ps -a

# Ver a qué réplica responde el gateway (requiere la petición justo antes)
curl -s -o /dev/null http://localhost:8080/api/v1/tramites
docker compose logs --tail 5 gateway | tail -1

# Ver el log con detalle de upstream
docker compose logs gateway | grep upstream=

# Consultar una base de datos
docker compose exec postgres psql -U municipalidad -d usuarios_db -c '\dt'
docker compose exec postgres psql -U municipalidad -d pagos_db -c 'SELECT * FROM pagos'

# Reiniciar un solo servicio
docker compose restart pagos_1

# Ver las rutas de un servicio
docker compose exec usuarios_1 node ace list:routes

# Reconstruir tras cambiar código
docker compose up -d --build
```

El log del gateway incluye `upstream=`, `upstream_status=` y los tiempos, porque el log
por defecto de nginx no dice a qué réplica respondió.

---

## 8. Pruebas manuales de punta a punta

```bash
# 1. Crear un usuario
curl -X POST http://localhost:8080/api/v1/usuarios \
  -H 'Content-Type: application/json' \
  -d '{"email":"ana@mun.test","password":"secreto123","fullName":"Ana Ruiz","passwordConfirmation":"secreto123"}'

# 2. Trámite con usuario inexistente -> 400
curl -X POST http://localhost:8080/api/v1/tramites \
  -H 'Content-Type: application/json' \
  -d '{"usuarioId":999,"tipo":"licencia","descripcion":"prueba"}'

# 3. Trámite con usuario válido -> 201
curl -X POST http://localhost:8080/api/v1/tramites \
  -H 'Content-Type: application/json' \
  -d '{"usuarioId":1,"tipo":"licencia","descripcion":"prueba"}'

# 4. Pago con usuario inexistente -> 400
curl -X POST http://localhost:8080/api/v1/pagos \
  -H 'Content-Type: application/json' \
  -d '{"id_tramite":1,"usuario_id":999,"monto":15000,"metodo_pago":"tarjeta","fecha_pago":"2026-01-15T10:00:00Z"}'

# 5. Pago válido -> 201, y el trámite queda en estado "pagado"
curl -X POST http://localhost:8080/api/v1/pagos \
  -H 'Content-Type: application/json' \
  -d '{"id_tramite":1,"usuario_id":1,"monto":15000,"metodo_pago":"tarjeta","fecha_pago":"2026-01-15T10:00:00Z"}'

curl http://localhost:8080/api/v1/tramites/1
# {"id":1,"usuarioId":1,...,"estado":"pagado"}
```

---

## 9. Pendientes

- [ ] Autenticar `POST /tramites` y `POST /pagos` (hoy son públicas)
- [ ] Exponer `/api/v1/auth/*` y `/api/v1/account/*` en el gateway, o borrarlas de tramites y pagos
- [ ] Validar que el `usuario_id` del pago sea el dueño del trámite
- [ ] Reintentos y circuit breaker en las llamadas entre servicios
- [ ] Relojes lógicos de Lamport para analizar el orden de los eventos
- [ ] Casos de prueba automatizados (Japa está configurado pero no hay tests)
- [ ] `node ace build` en los `Dockerfile` en lugar de `pnpm dev`
- [ ] Catálogo de estados válidos para trámites (hoy `PATCH` acepta cualquier texto)
- [ ] Quitar `users` y `auth_access_tokens` de las bases de tramites y pagos