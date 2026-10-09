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

> Tras cambiar `gateway/nginx.conf` hay que recargar, porque el archivo está montado como
> bind mount y nginx no vuelve a leerlo solo:
> `docker compose exec gateway nginx -t && docker compose restart gateway`

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
| GET | `/api/v1/reloj` | Reloj lógico de esta réplica | Sí (`/api/v1/reloj/tramites`) |
| POST | `/api/v1/auth/*`, `/api/v1/account/*` | Stack de auth replicado | **No** |

### Servicio pagos

| Método | Ruta | Descripción | ¿Por el gateway? |
|---|---|---|---|
| GET | `/api/v1/pagos` | Listar pagos | Sí |
| POST | `/api/v1/pagos` | Registrar pago (**valida trámite y usuario**) | Sí |
| GET | `/api/v1/reloj` | Reloj lógico de esta réplica | Sí (`/api/v1/reloj/pagos`) |
| POST | `/api/v1/auth/*`, `/api/v1/account/*` | Stack de auth replicado | **No** |

### Gateway

| Ruta | Qué hace |
|---|---|
| `GET /health` | Sonda del propio nginx. Responde 200 **sin tocar ningún servicio**, así que distingue "nginx caído" de "servicios caídos". |
| `GET /api/v1/reloj/{usuarios,tramites,pagos}` | Reloj lógico del servicio indicado. Como cada réplica tiene el suyo, la ruta dice a qué servicio se pregunta. |

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
| `tramites` | `id`, `usuario_id`, `tipo`, `descripcion`, `estado` (default `pendiente`), `lamport`, `node_id`, `created_at`, `updated_at` |
| `users`, `auth_access_tokens` | Restos del stack de auth replicado; no las usa trámites |

### `usuarios_db` (servicio usuarios)

| Tabla | Columnas |
|---|---|
| `users` | `id`, `full_name`, `email`, `password`, `created_at`, `updated_at` |
| `auth_access_tokens` | `id`, `tokenable_id`, `type`, `name`, `hash`, `abilities`, `*_at` |

### `pagos_db` (servicio pagos)

| Tabla | Columnas |
|---|---|
| `pagos` | `id_pago`, `id_tramite`, `usuario_id`, `monto`, `metodo_pago`, `fecha_pago`, `estado` (default `pendiente`), `lamport`, `node_id`, `created_at`, `updated_at` |

> `usuario_id` es **nullable a propósito**: la tabla ya tenía filas de pruebas anteriores
> y no hay forma de saber de qué usuario eran. Si se declarara `NOT NULL` habría que
> borrarlas o inventar un usuario. La obligatoriedad se aplica en el controlador, que
> rechaza cualquier pago sin `usuario_id`.

---

## 5.b Relojes lógicos de Lamport

### Qué son

Un reloj lógico **no mide tiempo de pared**. Es un contador que depende sólo del orden en
que un proceso observa los eventos. Las reglas de Lamport (1978):

- **L1.** En todo evento local, `C := C + 1`.
- **L2.** Si A envía un mensaje a B con sello `s`, B cumple `C := max(C, s) + 1`.

Lo que se gana es una **garantía de causalidad**: si el sello de un evento es menor que el
de otro, el primero ocurrió antes de forma garantizada. Y lo importante es lo que **no**
se puede concluir: si A tiene un sello mayor que B, no se deduce nada, porque un proceso
que arrancó más tarde ya empieza con un valor más alto.

### Dónde está implementado

| Archivo | Qué hace |
|---|---|
| `*/app/services/reloj_logico.ts` | El reloj. Estado en memoria, **uno por proceso**. |
| `*/app/services/usuarios_client.ts` | Envía el sello al llamar a `usuarios` y sincroniza con el suyo. |
| `*/app/services/tramites_client.ts` (en `pagos`) | Igual, al hablar con `tramites`. |
| `*/app/controllers/*_controller.ts` | Sella los eventos de negocio y lo guarda en la fila. |
| `*/app/controllers/reloj_controller.ts` | Expone el reloj: `GET /api/v1/reloj`. |

El sello viaja en la cabecera **`X-Lamport`**. Sin ella la regla L2 no se aplicaría y los
relojes de `pagos` y `tramites` nunca se relacionarían.

**Cada réplica es un proceso independiente y por eso tiene su propio reloj.**
`tramites_1` y `tramites_2` no comparten contador, igual que dos procesos distintos en una
misma máquina. Por eso `node_id` (`tramites_1`, `pagos_2`, …) acompaña siempre al sello.

### Cómo leer un sello

```bash
# Por el gateway (devuelve una réplica al azar, porque hay round-robin)
curl -s http://localhost:8080/api/v1/reloj/tramites
# {"nodeId":"tramites_2","lamport":29}

# Fijando una réplica concreta, que es lo que sirve para comparar relojes
curl -s http://localhost:3333/api/v1/reloj    # tramites_1
curl -s http://localhost:3334/api/v1/reloj    # tramites_2
```

| Réplica | Puerto host |
|---|---|
| `usuarios_1` / `usuarios_2` | 3335 / 3336 |
| `tramites_1` / `tramites_2` | 3333 / 3334 |
| `pagos_1` / `pagos_2` | 3337 / 3338 |

### Traza real de un pago

Con los seis relojes en 0, un `POST /api/v1/tramites` y un `POST /api/v1/pagos`:

| # | Evento | Proceso | reloj antes → después |
|---|---|---|---|
| 1 | envía `GET /usuarios/1` con sello `1` | `tramites_2` | 0 → **1** |
| 2 | recibe el sello `1` | `usuarios_1` | 0 → max(0,1)+1 = **2** |
| 3 | responde, sello `3` | `usuarios_1` | 2 → **3** |
| 4 | recibe el sello `3` | `tramites_2` | 1 → max(1,3)+1 = **4** |
| 5 | evento local: inserta el trámite con sello `5` | `tramites_2` | 4 → **5** |
| 6 | envía `GET /tramites/16` con sello `1` | `pagos_1` | 0 → **1** |
| 7 | recibe sello `1` (`show` no responde con sello) | `pagos_1` | 1 → **2** |
| 8 | envía `GET /usuarios/1` con sello `3` | `pagos_1` | 2 → **3** |
| 9 | recibe el sello `3` | `usuarios_2` | 0 → max(0,3)+1 = **4** |
| 10 | responde, sello `5` | `usuarios_2` | 4 → **5** |
| 11 | recibe el sello `5` | `pagos_1` | 3 → max(3,5)+1 = **6** |
| 12 | evento local: inserta el pago con sello `7` | `pagos_1` | 6 → **7** |
| 13 | envía el `PATCH estado=pagado` con sello `8` | `pagos_1` | 7 → **8** |
| 14 | recibe el sello `8` | `tramites_1` | 0 → max(0,8)+1 = **9** |
| 15 | evento local: actualiza el trámite con sello `10` | `tramites_1` | 9 → **10** |
| 16 | recibe el sello `10` | `pagos_1` | 8 → max(8,10)+1 = **11** |

Resultado: el pago quedó con `lamport 7 / pagos_1` y los relojes finales fueron
`pagos_1: 11`, `tramites_1: 10`, `tramites_2: 5`, `usuarios_1: 3`, `usuarios_2: 5`.

### Concurrencia: lo que el reloj sí y lo que no puede decir

```bash
# Ocho trámites en paralelo, que el gateway reparte entre las dos réplicas
for i in $(seq 1 8); do
  curl -s -X POST http://localhost:8080/api/v1/tramites \
    -H 'Content-Type: application/json' \
    -d "{\"usuarioId\":1,\"tipo\":\"conc\",\"descripcion\":\"paralelo $i\"}" &
done; wait
```

```bash
docker compose exec postgres psql -U municipalidad -d municipalidad -c \
  "SELECT id, lamport, node_id FROM tramites WHERE tipo='conc' ORDER BY lamport, node_id"
```

```
 id | lamport |  node_id
----+---------+------------
 17 |      10 | tramites_2
 18 |      16 | tramites_1
 19 |      18 | tramites_1
 20 |      20 | tramites_1      <- mismo sello
 21 |      20 | tramites_2      <- que el anterior
 24 |      22 | tramites_1      <- mismo sello
 22 |      22 | tramites_2      <- que el anterior
 23 |      24 | tramites_2
```

Los trámites **20 y 21 tienen el mismo `lamport: 20` en procesos distintos**. Son eventos
concurrentes: el reloj lógico **no puede** decidir cuál fue primero, y no debe hacerlo,
porque ninguno de los dos procesos se enteró del otro. Lo mismo con 22 y 24.

Eso es justamente el límite honesto del método: da orden **donde hay causalidad**
(`pagos:11` → `tramites:10` → `usuarios:5`, es decir el pago ocurrió después del
sello de usuarios) y se declara indeterminate **donde no la hay**. Un `created_at`
con millisegundos no te da ninguna de las dos cosas.

### Limitaciones

- `lamport` y `node_id` en `tramites` guardan **el último evento que modificó la fila**,
  así que el `PATCH` de `pagos` sobrescribe el sello de creación. En `pagos`, que nunca se
  actualiza, el sello sí es siempre el de creación.
- Las columnas son `nullable`: las filas anteriores a esta etapa no tienen sello.
- El reloj es **en memoria**. Al reiniciar una réplica vuelve a 0, y los sellos antiguos
  quedan "en el futuro" respecto a los nuevos. Es inherente a los relojes lógicos, que
  solo razonan sobre una ejecución.
- No se comprueba la **concurrencia de escrituras**: dos `PATCH` simultáneos sobre el mismo
  trámite se resuelven por el `UPDATE` de PostgreSQL, no por el reloj. El reloj dice en qué
  orden *ocurrieron*, no cuál debe ganar.

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
| `NODE_ID` | los 3 | `tramites_1`, `pagos_2`, … | Identidad de la réplica en el reloj lógico. Opcional: si falta se usa el hostname. |

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
- [ ] Tabla de eventos para no sobrescribir el sello de creación de los trámites
- [ ] Control de concurrencia en las escrituras (el reloj informa el orden, no resuelve el conflicto)
- [ ] Reintentos y circuit breaker en las llamadas entre servicios
- [ ] Casos de prueba automatizados (Japa está configurado pero no hay tests)
- [ ] `node ace build` en los `Dockerfile` en lugar de `pnpm dev`
- [ ] Catálogo de estados válidos para trámites (hoy `PATCH` acepta cualquier texto)
- [ ] Quitar `users` y `auth_access_tokens` de las bases de tramites y pagos
- [ ] Sacar `pagos/.adonisjs/` del control de versiones (es código generado)