# Municipalidad — plataforma distribuida de trámites

Proyecto de Sistemas Operativos II. Tres microservicios independientes que gestionan
usuarios, trámites y pagos de una municipalidad, desplegados con Docker Compose y
expuestos a través de un gateway Nginx.

> **¿Vas a presentar el proyecto?** Hay dos formas:
>
> - **[GUION.md](./GUION.md)** — guion **manual**: qué decir, qué comando ejecutar y qué
>   se espera que salga, paso a paso. ~12 minutos. Empieza por aquí.
>
> - **[DEMOSTRACION.md](./DEMOSTRACION.md)** — script **automático** que mide lo mismo y
>   devuelve tablas de p50/p95/máx. Útil para verificar sin hablar.
>
> **Interfaz web:** abre **http://localhost:8080/ui/** después de `docker compose up -d --build`.
> El administrador se crea solo: `admin@municipalidad.gob` / `Municipal123`. Desde ahí se
> registran ciudadanos, trámites y pagos. Ver [§8.b](#8b-interfaz-web).
>
> **Para entrar desde otro equipo o por internet:** `./scripts/tunel.sh` levanta un túnel
> HTTPS temporal de Cloudflare y muestra la URL pública. Se detiene con
> `./scripts/tunel.sh parar`. Ver §7.
>
> **Comprobación automática de los tres puntos** (rápida, ~2 min, no destructiva):
>
> ```bash
> ./scripts/verificacion.sh
> ```
>
> Imprime un PASS/FAIL por cada comprobación y un resumen. La última salida está
> guardada en [EVIDENCIAS.txt](./EVIDENCIAS.txt).
>
> **Punto 3 del informe (recuperación ante fallos), §5 del guion:**
>
> ```bash
> ./scripts/recuperacion.sh demo-backup   # se borran datos y se restauran
> ./scripts/recuperacion.sh saga          # una operación interrumpida se recupera sola
> ./scripts/recuperacion.sh pitr-preparar # luego: pitr-destruir, pitr-recuperar, pitr-verificar
> ```
>
> La justificación de por qué eso es Saga y no 2PC está en
> [RECUPERACION.md](./RECUPERACION.md).
>
> ```bash
> ./scripts/demostracion.sh
> ```

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
> en la práctica: nginx mandaba peticiones de `/api/v1/usuarios/…` a `tramites_2`, que
> respondía 404. Con IP fijas la topología es siempre la misma.
>
> Además, por el mismo motivo **el gateway usa esas IP en sus `upstream` en lugar de los
> nombres de contenedor**. Con nombres, si una réplica estaba caída al arrancar, nginx
> abortaba y el gateway no levantaba:
>
> ```
> nginx: [emerg] host not found in upstream "tramites_1:3333"
> ```
>
> Si cambias una IP en `docker-compose.yml`, hay que cambiarla también en
> `gateway/nginx.conf`.

---

## 2. Puesta en marcha

```bash
docker compose up -d --build     # la primera vez tarda: instala dependencias y genera código
docker compose ps -a             # postgres y las 6 réplicas en (healthy)
```

La interfaz queda en **http://localhost:8080/ui/**. La cuenta de administrador la crea el
seeder la primera vez:

| Correo | Contraseña | Rol |
|---|---|---|
| `admin@municipalidad.gob` | `Municipal123` | `admin` (administrador general) |
| `tesoreria@municipalidad.gob` | `Tesoreria123` | `personal_muni_tesoreria` |

Los ciudadanos se registran desde la propia interfaz. Son credenciales de demostración:
en un despliegue real vendrían por variables de entorno.

Para empezar de cero y borrar todos los datos:

```bash
docker compose down -v           # -v borra el volumen: se pierde la base de datos
docker compose up -d --build
```

### Contenedores de un solo uso

| Servicio | Qué hace | Resultado esperado |
|---|---|---|
| `db_init` | Crea `usuarios_db` y `pagos_db` (PostgreSQL solo crea la de `POSTGRES_DB`) | `Exited (0)` |
| `tramites_migrate` | `node ace migration:run --force && node ace db:seed` sobre `municipalidad` | `Exited (0)` |
| `usuarios_migrate` | `node ace migration:run --force && node ace db:seed` sobre `usuarios_db` | `Exited (0)` |
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
| POST | `/api/v1/usuarios` | Registro público (siempre `ciudadano`); exige `dni` | Sí |
| POST | `/api/v1/admin/usuarios` | Alta de usuario con rol elegido (**solo admin**) | Sí |
| POST | `/api/v1/auth/signup` | Registrarse (alias de `/usuarios`) | Sí |
| POST | `/api/v1/auth/login` | Iniciar sesión | Sí |
| GET | `/api/v1/account/profile` | Perfil (requiere token) | Sí |
| POST | `/api/v1/account/logout` | Revocar token **y la identidad firmada** | Sí |
| POST | `/api/v1/auth/revocar` | Revocar una identidad por `jti` (**solo admin**) | Sí |
| GET | `/api/v1/identidades/revocadas` | Lista de `jti` revocados (admin o servicio) | Sí |

### Servicio trámites

| Método | Ruta | Descripción | ¿Por el gateway? |
|---|---|---|---|
| GET | `/api/v1/tramites` | Listar trámites | Sí |
| POST | `/api/v1/tramites` | Crear trámite (**valida el usuario**). Acepta `Idempotency-Key` y `X-Origen: offline`; conserva `creadoClienteEn` | Sí |
| GET | `/api/v1/tramites/:id` | Obtener un trámite | Sí |
| GET | `/api/v1/tramites/:id/eventos` | Historial de estados con su sello Lamport | Sí |
| PATCH | `/api/v1/tramites/:id` | Cambiar `estado`; admin además tipo/descripción/monto. Acepta `version` y responde **409** si la fila cambió | Sí |
| DELETE | `/api/v1/tramites/:id` | Eliminar un trámite (**solo admin**) | Sí |
| GET | `/api/v1/tipos-tramite` | Catálogo de tipos y montos | Sí |
| POST/PATCH/DELETE | `/api/v1/tipos-tramite[/:id]` | Gestionar el catálogo (**solo admin**) | Sí |
| GET | `/api/v1/reloj` | Reloj lógico de esta réplica | Sí (`/api/v1/reloj/tramites`) |

### Servicio pagos

| Método | Ruta | Descripción | ¿Por el gateway? |
|---|---|---|---|
| GET | `/api/v1/pagos` | Listar pagos | Sí |
| POST | `/api/v1/pagos` | Registrar pago (**valida trámite y usuario**) | Sí |
| GET | `/api/v1/reloj` | Reloj lógico de esta réplica | Sí (`/api/v1/reloj/pagos`) |

### Gateway

| Ruta | Qué hace |
|---|---|
| `GET /health` | Sonda del propio nginx. Responde 200 **sin tocar ningún servicio**, así que distingue "nginx caído" de "servicios caídos". |
| `GET /api/v1/reloj/{usuarios,tramites,pagos}` | Reloj lógico del servicio indicado. Como cada réplica tiene el suyo, la ruta dice a qué servicio se pregunta. |
| `GET /api/v1/circuitos/{tramites,pagos}` | Estado de los interruptores de circuito y métricas por dependencia. No existe en `usuarios` porque no depende de nadie. |
| `GET/POST/PATCH/DELETE /api/v1/tipos-tramite` | Catálogo de tipos y montos, enrutado a trámites. |
| `POST /api/v1/admin/usuarios` | Alta de usuarios con rol, enrutada a usuarios. |

> **Sobre `/api/v1/auth/*`:** el gateway enruta `/api/v1/auth/*` y `/api/v1/account/*`
> **solo hacia usuarios**, único servicio que emite y valida tokens. Trámites y pagos ya no
> incluyen el andamiaje de auth ni las tablas `users`/`auth_access_tokens`: su identidad
> llega firmada en `X-Identidad`. La interfaz **solo envía el token a `/api/v1/account/*`**.

---

## 4. Comunicación entre servicios

### 4.1 Crear un trámite

```
cliente ──POST /api/v1/tramites──▶ gateway ──▶ tramites_1 o tramites_2
          X-Identidad (firmada)                     │
                                          verifica la firma localmente
                                          (no llama a usuarios)
                                                    │
                     ciudadano ──▶ usuarioId = identidad.id
                     tesorería/admin ──▶ usuarioId del cuerpo
                                                    │
                                    GET gateway/api/v1/usuarios/:usuarioId
                                                    │
               ┌──────────────────────┬─────────────┴──────────────┐
               ▼                      ▼                            ▼
            200                404                     error/timeout
       el usuario existe    → 400                  → 503
                              "El usuario           "No se pudo
                               indicado no           verificar el
                               existe"               usuario"
               └──────────────────────┴──────────────────────────────┘
                                      ▼
                             INSERT en tramites
```

La identidad viaja en `X-Identidad`, firmada por `usuarios` con HMAC-SHA256. Trámites la
verifica **localmente**: no necesita llamar a `usuarios` para saber quién es el usuario, así
que un fallo de `usuarios` no bloquea la lectura ni la creación de trámites. La llamada a
`usuarios` del diagrama es solo para comprobar que el usuario referenciado existe.

### Rotación y revocación de identidades

La identidad firmada incluye un `jti` único y caduca a las 12 h. Eso permite dos operaciones
sin volver a llamar a usuarios en cada petición:

- **Rotación sin cortar sesiones.** Se configura el secreto nuevo en `AUTH_IDENTITY_SECRET`
  y el viejo en `AUTH_IDENTITY_SECRET_ANTERIOR`; los tres servicios se recrean. Se firma
  siempre con el actual y se aceptan ambos, así las identidades ya emitidas siguen valiendo.
  Cuando pase el TTL, se quita el anterior. Si se rota **sin** conservar el anterior, se
  revocan de golpe todas las identidades (revocación global).
- **Revocación individual.** El `jti` se anota en `identidades_revocadas`. `POST
  /account/logout` lo hace automáticamente con la identidad que manda el cliente, y un
  admin puede revocar un `jti` concreto con `POST /api/v1/auth/revocar`. Trámites y pagos
  descargan `GET /api/v1/identidades/revocadas` cada `REVOCACION_TTL_MS` (5 s por defecto)
  y la consultan en memoria: la revocación surte efecto en ese margen, sin añadir una
  llamada de red por petición. Si usuarios no responde, se conserva la última lista
  (fail-open, igual que la verificación local de la firma).

La comprobación **2.11** de `verificacion.sh` demuestra que una identidad revocada deja de
valer mientras las demás siguen funcionando; las pruebas unitarias cubren la rotación.

### 4.2 Solicitar y confirmar un pago

Registrar la solicitud y acreditar el dinero son dos responsabilidades distintas. Un
ciudadano puede **solicitar** un pago; solo tesorería o el administrador pueden
**confirmarlo**. El pago nace siempre en `pendiente`.

**Solicitud** — `POST /api/v1/pagos`

```
cliente ──POST /api/v1/pagos──▶ gateway ──▶ pagos_1 o pagos_2
                                         │
     1. verifica X-Identidad             │
                                         │
     2. GET gateway/tramites/:id_tramite ─┤ 404 → 400 "El trámite indicado no existe"
                                         │ error → 503
                                         │
     3. si es ciudadano, el trámite debe │
        pertenecerle                     ─┤ si no → 403
                                         │
     4. INSERT en pagos, estado='pendiente'
        (no toca el trámite todavía)
```

**Confirmación** — `POST /api/v1/pagos/:id/confirmar`

```
cliente ──POST /api/v1/pagos/:id/confirmar──▶ pagos
                                         │
     1. X-Identidad + rol                 │
        solo admin o tesorería           ─┤ si no → 403
                                         │
     2. GET trámites/:id_tramite           │ si ya está pagado → acredita y termina
                                         │
     3. INSERT pagos_intentos (pendiente)  │  ← registro de la intención
                                         │
     4. PATCH trámites/:id estado='pagado' │
                                         │
     5. intento='confirmado'               │
        pago.estado='pagado'              │
                                         │
         ┌───────────────────────────────┴──────────────┐
         ▼                                              ▼
     200 con el pago                    error/5xx → 503: el pago
                                        queda pendiente y el
                                        reconciliador reintenta
```

Ya **no** se borra el pago cuando falla el PATCH: la solicitud del ciudadano es un dato
legítimo. Se deja en `pendiente`, con la intención registrada, y el reconciliador termina
la operación cuando el otro servicio vuelve.

### 4.3 Qué datos necesita cada servicio

| Servicio | Necesita de sus clientes | Consulta a otros servicios |
|---|---|---|
| usuarios | `dni`, `email`, `password`, `fullName` (y `rol` en el alta de admin) | — |
| tramites | `X-Identidad`, `tipo`, `descripcion` (y `usuarioId` si quien llama es privilegiado). Si `tipo="Otro"`, además `tipoDetalle` y `monto` | `usuarios`: que el usuario exista. Catálogo local para los tipos fijos |
| pagos | `X-Identidad`, `id_tramite`, `monto`, `metodo_pago`, `fecha_pago` (y `usuario_id` si quien llama es privilegiado) | `tramites`: existencia, dueño y estado. `usuarios`: que el usuario exista |

El `estado` **no** lo elige el cliente: la solicitud siempre nace en `pendiente`.

Los identificadores son legibles y no numéricos internos: el **DNI** (8 dígitos) es la PK de
`users`; los trámites se llaman `T1`, `T13`, `T222` y los pagos `P1`, `P333` (`varchar(12)`, hasta `T`/`P` + 11 dígitos).
Los códigos se generan con las secuencias PostgreSQL `tramites_num_seq` y `pagos_num_seq`, así
que dos réplicas no pueden repetir uno aunque creen a la vez.

### 4.4 Las validaciones son reales, no confianza en el cliente

El `usuarioId` que envía un ciudadano se **ignora**: el controlador usa el DNI de la
identidad firmada. En los perfiles privilegiados se usa como parámetro de búsqueda, y la
autoridad sigue siendo la respuesta HTTP del servicio `usuarios`.

La identidad se obtiene al iniciar sesión:

```bash
IDENTIDAD=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@municipalidad.gob","password":"Municipal123"}' \
  | jq -r '.data.identidad')

docker compose stop usuarios_1 usuarios_2

# usuarioId=10000001 SÍ existe en la base, pero usuarios está caído:
curl -X POST http://localhost:8080/api/v1/tramites \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
  -d '{"usuarioId":"10000001","tipo":"Otro","tipoDetalle":"x","monto":1000,"descripcion":"y"}'
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
| `tramites` | `id` (`T1`…), `usuario_id` (DNI), `tipo`, `tipo_detalle`, `descripcion`, `monto`, `estado` (default `pendiente`), `version` (control de concurrencia, empieza en 1), `lamport`, `node_id`, `clave_idempotencia` (nullable; único por `usuario_id`), `creado_cliente_en` (fecha original del cliente), `origen` (`web`/`offline`), `created_at`, `updated_at` |
| `tipos_tramite` | `id`, `nombre` (único), `monto`, `activo`, `created_at`, `updated_at` |
| `tramites_eventos` | `id`, `tramite_id` (FK en cascada), `estado_anterior` (null al crear), `estado_nuevo`, `actor_id` (DNI o `servicio`), `lamport`, `node_id`, `created_at` |

### `usuarios_db` (servicio usuarios)

| Tabla | Columnas |
|---|---|
| `users` | `id` (DNI, `varchar(8)`), `full_name`, `email`, `password`, `rol`, `created_at`, `updated_at` |
| `auth_access_tokens` | `id`, `tokenable_id`, `type`, `name`, `hash`, `abilities`, `*_at` |
| `identidades_revocadas` | `jti` (PK), `exp`, `created_at` |

### `pagos_db` (servicio pagos)

| Tabla | Columnas |
|---|---|
| `pagos` | `id_pago` (`P1`…), `id_tramite` (`T1`…), `usuario_id` (DNI), `monto`, `metodo_pago`, `fecha_pago`, `estado` (default `pendiente`), `lamport`, `node_id`, `created_at`, `updated_at` |
| `pagos_intentos` | `id`, `id_tramite`, `usuario_id`, `pago_id`, `estado` (default `pendiente`), `intentos`, `ultimo_error`, `lamport`, `node_id`, `created_at`, `updated_at` |

> `usuario_id` se mantiene **nullable en la migración** por compatibilidad con el esquema
> anterior; el controlador rechaza cualquier pago nuevo sin `usuario_id`. El tipo de la
> columna es `varchar(8)` porque guarda el DNI.

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

### Traza de un pago

Con la solicitud ya creada, la **confirmación** es la que habla con trámites. Los números
exactos dependen del reparto del gateway; esta traza muestra la forma de la cadena causal.

| # | Evento | Proceso | reloj antes → después |
|---|---|---|---|
| 1 | envía `GET /tramites/T` con sello `1` | `pagos_1` | 0 → **1** |
| 2 | `show` no sella: no hay respuesta de reloj | `tramites_2` | 0 → **0** |
| 3 | evento local: inserta `pagos_intentos` con sello `2` | `pagos_1` | 1 → **2** |
| 4 | envía el `PATCH estado=pagado` con sello `3` | `pagos_1` | 2 → **3** |
| 5 | recibe el sello `3` | `tramites_1` | 0 → max(0,3)+1 = **4** |
| 6 | evento local: actualiza el trámite con sello `5` | `tramites_1` | 4 → **5** |
| 7 | recibe el sello `5` | `pagos_1` | 3 → max(3,5)+1 = **6** |
| 8 | evento local: confirma la intención y acredita el pago, sello `7` | `pagos_1` | 6 → **7** |

Resultado: la intención quedó en `lamport 2 / pagos_1`, el pago en `7 / pagos_1` y el
trámite en `5 / tramites_1`. La solicitud del pago, antes de esta traza, también consultó
el trámite y dejó su propio sello.

### Concurrencia: lo que el reloj sí y lo que no puede decir

```bash
# Ocho trámites en paralelo, que el gateway reparte entre las dos réplicas
LOGIN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@municipalidad.gob","password":"Municipal123"}')
IDENTIDAD=$(echo "$LOGIN" | jq -r '.data.identidad')
ADMIN_ID=$(echo "$LOGIN" | jq -r '.data.user.id')

for i in $(seq 1 8); do
  curl -s -X POST http://localhost:8080/api/v1/tramites \
    -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
    -d "{\"usuarioId\":\"$ADMIN_ID\",\"tipo\":\"Otro\",\"tipoDetalle\":\"conc\",\"monto\":1000,\"descripcion\":\"paralelo $i\"}" &
done; wait
```

```bash
docker compose exec postgres psql -U municipalidad -d municipalidad -c \
  "SELECT id, lamport, node_id FROM tramites WHERE tipo_detalle='conc' ORDER BY lamport, node_id"
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

En la corrida de ejemplo, los trámites **20 y 21 comparten `lamport: 20` en procesos
distintos**. Son eventos concurrentes: el reloj lógico **no puede** decidir cuál fue
primero, y no debe hacerlo, porque ninguno de los dos procesos se enteró del otro. Lo
mismo con 22 y 24. Como cada alta consulta a `usuarios` y eso hace avanzar los relojes,
los empates de esta ráfaga dependen del intercalado real: pueden no aparecer en todas
las corridas.

Para forzar un empate **garantizado**, manda dos `PATCH` simultáneos directos a cada
réplica (sin pasar por el gateway) con el mismo `X-Lamport` externo. Ambas réplicas parten
del mismo sello y calculan el mismo contador, sin hablarse:

```bash
curl -s -X PATCH localhost:3333/api/v1/tramites/T_a -H 'Content-Type: application/json' \
  -H "X-Identidad: $IDENTIDAD" -H 'X-Lamport: 900000' -d '{"estado":"en_revision"}' &
curl -s -X PATCH localhost:3334/api/v1/tramites/T_b -H 'Content-Type: application/json' \
  -H "X-Identidad: $IDENTIDAD" -H 'X-Lamport: 900000' -d '{"estado":"en_revision"}' &
wait
# → ambos responden {"lamport":900002,...} con nodeId tramites_1 y tramites_2
```

`./scripts/demostracion.sh reloj` incluye esta comprobación como paso 2.5 y siempre
muestra el empate.

Eso es justamente el límite honesto del método: da orden **donde hay causalidad**
(`pagos:11` → `tramites:10` → `usuarios:5`, es decir el pago ocurrió después del
sello de usuarios) y se declara indeterminate **donde no la hay**. Un `created_at`
con millisegundos no te da ninguna de las dos cosas.

### Control de concurrencia optimista

El reloj ordena los eventos, pero no decide quién gana una escritura simultánea. Para eso
`tramites` tiene una columna `version` que empieza en 1:

- Cada `PATCH` exitoso hace un `UPDATE ... WHERE id = ? AND version = ?` y sube la versión.
  Si otra petición ganó la carrera, el `UPDATE` afecta 0 filas y se responde **409**.
- El cuerpo puede incluir `"version": N` (la que leyó el cliente). Si no coincide con la
  actual, también es **409** con `{"message": "...", "version": N}`. Es opcional, pero la
  interfaz lo envía para no guardar cambios sobre datos viejos.
- No hay merge automático: el cliente debe releer y reintentar. El servidor nunca pisa una
  escritura ajena en silencio.

Así, dos `PATCH` simultáneos sobre el mismo trámite producen un `200` y un `409`, aunque
ninguno de los dos envíe `version` (el `UPDATE` condicional usa la versión que leyó cada
petición). La comprobación **2.10** de `verificacion.sh` lo demuestra.

### Limitaciones

- `lamport` y `node_id` en `tramites` guardan **el último evento que modificó la fila**,
  así que el `PATCH` de `pagos` sobrescribe el sello de creación. En `pagos`, que nunca se
  actualiza, el sello sí es siempre el de creación.
- Las columnas son `nullable`: las filas anteriores a esta etapa no tienen sello.
- El reloj es **en memoria**. Al reiniciar una réplica vuelve a 0, y los sellos antiguos
  quedan "en el futuro" respecto a los nuevos. Es inherente a los relojes lógicos, que
  solo razonan sobre una ejecución.
- La concurrencia se resuelve con **versión optimista**, no con el reloj: dos `PATCH`
  simultáneos sobre el mismo trámite producen un `200` y un `409`. El reloj dice en qué
  orden *ocurrieron*; la versión decide cuál se aplica. Si hay conflicto, el cliente debe
  releer y reintentar (no hay merge automático).

---

## 6. Variables de entorno

| Variable | Servicio | Valor en Docker | Para qué |
|---|---|---|---|
| `DB_HOST` | los 3 | `postgres` | Host de PostgreSQL |
| `DB_DATABASE` | tramites | `municipalidad` | Base del servicio |
| `DB_DATABASE` | usuarios | `usuarios_db` | Base del servicio |
| `DB_DATABASE` | pagos | `pagos_db` | Base del servicio |
| `APP_KEY` | los 3 | (secreto) | Cifrado y cookies de sesión |
| `USUARIOS_SERVICE_URL` | tramites, pagos | `http://gateway` | Validación de usuario y lista de identidades revocadas |
| `AUTH_IDENTITY_SECRET` | los 3 | secreto compartido | Firma actual de `X-Identidad` |
| `AUTH_IDENTITY_SECRET_ANTERIOR` | los 3 | (vacío) | Secreto anterior aceptado durante la rotación. Opcional |
| `REVOCACION_TTL_MS` | tramites, pagos | `5000` | Cada cuánto se refresca la caché de revocadas. Opcional |
| `TRAMITES_SERVICE_URL` | pagos | `http://gateway` | Validación y actualización del trámite |
| `NODE_ID` | los 3 | `tramites_1`, `pagos_2`, … | Identidad de la réplica en el reloj lógico. Opcional: si falta se usa el hostname. |
| `HTTP_TIMEOUT_MS` | tramites, pagos | `2000` | Timeout de cada llamada entre servicios. Opcional. |
| `HTTP_REINTENTOS` | tramites, pagos | `1` | Reintentos por llamada. Opcional. |
| `CIRCUIT_UMBRAL` | tramites, pagos | `3` | Fallos seguidos que abren el circuito. Opcional. |
| `CIRCUIT_ABIERTO_MS` | tramites, pagos | `10000` | Tiempo que el circuito queda abierto. Opcional. |
| `DB_CONNECTION_TIMEOUT_MS` | los 3 | `2000` | Tope de espera para **conseguir** una conexión del pool de PostgreSQL. Opcional. |
| `DB_POOL_TIMEOUT_MS` | los 3 | `4000` | Tope de espera por una conexión libre del pool. Opcional. |

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

# Empezar de cero: borra el volumen y vuelve a sembrar admin/tesorería
docker compose down -v && docker compose up -d

# Compartir por internet con una URL HTTPS temporal
./scripts/tunel.sh
./scripts/tunel.sh parar
```

El log del gateway incluye `upstream=`, `upstream_status=` y los tiempos, porque el log
por defecto de nginx no dice a qué réplica respondió.

`docker compose down -v` borra la base de datos y los respaldos del volumen; es la forma
limpia de dejar el sistema sin trámites ni pagos de prueba. Las identidades firmadas
emitidas antes del reset siguen siendo válidas hasta que caduquen (12 h); si hace falta
invalidarlas ya, rota `AUTH_IDENTITY_SECRET`.

### Acceso por internet con el túnel

`./scripts/tunel.sh` levanta `cloudflared` (perfil `tunel`) apuntando al gateway y publica
una URL `https://*.trycloudflare.com`. La interfaz y la API comparten origen, así que no
hay que tocar CORS. La URL es temporal y **cambia al reiniciar** el túnel; para una URL
fija hace falta un dominio y un túnel con nombre en Cloudflare. Es una herramienta de
demostración: no expongas PostgreSQL ni los microservicios.

---

## 8. Pruebas

### 8.1 Automatizadas (Japa)

```bash
cd usuarios && node ace test        # 8 pruebas: registro, login, perfil y permisos
cd tramites && node ace test        # 29 pruebas unitarias: estados, reloj, identidad (rotación/revocación), interruptor y cliente HTTP
cd pagos && node ace test           # 7 pruebas: cliente HTTP e identidad (rotación/revocación)
```

- `usuarios/tests/functional/auth.spec.ts`: signup con DNI, DNI inválido/repetido, login,
  perfil con token y listado solo para admin. Usa la base SQLite de `tmp/` y migra/revierte
  por prueba, sin tocar la base de Docker.
- `tramites/tests/unit/*.spec.ts`: catálogo y transiciones de estados, reglas de Lamport,
  firma/verificación/rotación/revocación de la identidad, apertura/cierre del interruptor y
  métricas/reintentos adaptativos del cliente HTTP.
- `pagos/tests/unit/*.spec.ts`: conteo de llamadas/éxitos/fallos, reintento ante 503 y
  corte de reintentos cuando la tasa de fallo supera el 50%; rotación y revocación de la
  identidad firmada.

No requieren el stack levantado. La verificación integral (`./scripts/verificacion.sh`)
recorre el stack real con **76 comprobaciones**, incluidas la rotación/revocación (2.11) y
la idempotencia de la cola offline (2.12).

### 8.2 Manuales de punta a punta

```bash
# 1. Entrar como administrador y obtener la identidad firmada
LOGIN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@municipalidad.gob","password":"Municipal123"}')
IDENTIDAD=$(echo "$LOGIN" | jq -r '.data.identidad')
ADMIN_ID=$(echo "$LOGIN" | jq -r '.data.user.id')

# 2. Crear un usuario (el registro público exige DNI)
curl -X POST http://localhost:8080/api/v1/usuarios \
  -H 'Content-Type: application/json' \
  -d '{"dni":"20000001","email":"ana@mun.test","password":"secreto123","fullName":"Ana Ruiz","passwordConfirmation":"secreto123"}'

# 2.b Alta de un trabajador municipal (solo admin)
curl -X POST http://localhost:8080/api/v1/admin/usuarios \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
  -d '{"dni":"20000002","email":"caja@mun.test","password":"secreto123","fullName":"Caja","passwordConfirmation":"secreto123","rol":"personal_muni_tesoreria"}'

# 3. Trámite con usuario inexistente -> 400
curl -X POST http://localhost:8080/api/v1/tramites \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
  -d '{"usuarioId":"99999999","tipo":"Otro","tipoDetalle":"licencia","monto":1000,"descripcion":"prueba"}'

# 4. Trámite con tipo del catálogo -> 201 (el monto lo fija el catálogo)
TRAMITE=$(curl -s -X POST http://localhost:8080/api/v1/tramites \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
  -d "{\"usuarioId\":\"$ADMIN_ID\",\"tipo\":\"Licencia de funcionamiento\",\"descripcion\":\"prueba\"}" \
  | jq -r '.id')

# 5. Pago con usuario inexistente -> 400
curl -X POST http://localhost:8080/api/v1/pagos \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
  -d "{\"id_tramite\":\"$TRAMITE\",\"usuario_id\":\"99999999\",\"monto\":15000,\"metodo_pago\":\"tarjeta\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}"

# 6. Solicitud de pago válida -> 201 con estado "pendiente"
PAGO=$(curl -s -X POST http://localhost:8080/api/v1/pagos \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
  -d "{\"id_tramite\":\"$TRAMITE\",\"usuario_id\":\"$ADMIN_ID\",\"monto\":15000,\"metodo_pago\":\"tarjeta\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}")
PAGO_ID=$(echo "$PAGO" | jq -r '.idPago')

# 7. Confirmar y acreditar -> 200; el trámite pasa a "pagado"
curl -X POST "http://localhost:8080/api/v1/pagos/$PAGO_ID/confirmar" \
  -H "X-Identidad: $IDENTIDAD"
curl -H "X-Identidad: $IDENTIDAD" "http://localhost:8080/api/v1/tramites/$TRAMITE"
# {"id":...,"estado":"pagado"}

# 8. Un ciudadano no puede confirmar el pago -> 403
CIUDADANO=$(curl -s -X POST http://localhost:8080/api/v1/usuarios \
  -H 'Content-Type: application/json' \
  -d '{"dni":"20000003","email":"ciudadano@mun.test","password":"secreto123","fullName":"Ciudadano","passwordConfirmation":"secreto123"}')
ID_CIUDADANO=$(echo "$CIUDADANO" | jq -r '.data.identidad')
curl -X POST "http://localhost:8080/api/v1/pagos/$PAGO_ID/confirmar" \
  -H "X-Identidad: $ID_CIUDADANO"
# 403
```

#### Catálogo de estados

Un trámite nace en `pendiente` y solo acepta estas transiciones. Cualquier otro texto
o salto devuelve `400`; repetir el estado actual es válido (idempotente), para que la
confirmación del pago pueda reintentarse.

| Desde | Hacia |
|---|---|
| `pendiente` | `en_revision`, `pagado`, `rechazado`, `anulado` |
| `en_revision` | `pendiente`, `pagado`, `rechazado`, `anulado` |
| `pagado` | `anulado` |
| `rechazado` | `pendiente`, `en_revision`, `anulado` |
| `anulado` | — (terminal) |

```bash
curl -X PATCH "http://localhost:8080/api/v1/tramites/$TRAMITE" \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
  -d '{"estado":"inventado"}'
# 400 {"message":"El estado no es válido","estados":["pendiente","en_revision","pagado","rechazado","anulado"]}
```

### 8.3 Integración del flujo de pago en dos pasos

Las Japa son unitarias y no tocan Docker; este script ejercita el camino completo con los
tres servicios reales a través del gateway (H-17):

```bash
./scripts/integracion_pagos.sh
```

Registra un ciudadano, le crea un trámite, **solicita** el pago (queda `pendiente` y el
trámite intacto), comprueba que el ciudadano no puede confirmarlo ni pagar un trámite ajeno,
confirma con **tesorería**, verifica que pago, trámite e intención de la saga quedan
coherentes y que reconfirmar es **idempotente**. Son 18 comprobaciones; crea y borra sus
propios datos. La ventana de la saga (proceso que muere entre la intención y el `PATCH`) se
demuestra aparte con `./scripts/recuperacion.sh saga`.

### 8.b Interfaz web

Abre **http://localhost:8080/ui/**. Es HTML, CSS y JavaScript sin dependencias ni paso de
build: la sirve el propio nginx desde `gateway/ui/` y consume la misma API que usarías
con `curl`, a través del gateway.

| Pantalla | Qué hace |
|---|---|
| Ingresar | `POST /api/v1/auth/login`. Guarda el token y la identidad firmada en `localStorage`. |
| Registrarme | `POST /api/v1/auth/signup`. Pide **DNI**, nombre, correo y contraseña; crea la cuenta y entra directamente. |
| Trámites | El ciudadano ve y crea solo los suyos (tipo del catálogo u **Otro** con monto libre); tesorería y admin ven todos. El admin puede **editar y eliminar** trámites. |
| Pagos | El ciudadano solicita pagos para sus trámites; quedan **pendientes**. Tesorería y admin ven todo y tienen el botón **Confirmar**, que llama a `POST /api/v1/pagos/:id/confirmar` y acredita el trámite. |
| Mi cuenta | Perfil de la sesión (`GET /api/v1/account/profile`), que renueva la identidad. |
| Usuarios | **Solo admin.** Lista todas las cuentas y permite **crear usuarios con rol** (ciudadano, tesorería o admin). La API también lo exige. |
| Administración | **Solo admin.** Totales y **catálogo de tipos de trámite con su monto**: crear, editar y eliminar (el tipo `Otro` no vive en el catálogo). El panel en vivo de circuitos, relojes e intenciones queda para la siguiente etapa. |

El **rol** vive en `users.rol`: `ciudadano` (por defecto), `personal_muni_tesoreria` y
`admin` (administrador general, el máximo). El registro público siempre crea `ciudadano`:
el controlador fija el rol y no acepta el del cliente, para que nadie pueda autoasignarse
administrador.

La interfaz guarda la **identidad firmada** que devuelve el login y la envía en
`X-Identidad` a trámites, pagos y usuarios. El token opaco de Adonis (`Authorization`) solo
se envía a `/api/v1/account/*`, que es donde se valida y se revoca.

> **Decisión de alcance.** Se definieron los roles ahora, junto con la autenticación,
> porque añadir permisos después obliga a migrar tokens y a tocar todos los servicios a la
> vez. El panel en vivo se deja fuera a propósito hasta que los permisos estén validados.

### 8.c Cola offline de trámites

La interfaz guarda en el navegador los trámites que no pudo enviar, para no perder lo que
el usuario ya redactó cuando el servicio está caído o la red falla. Aplica **solo a la
creación de trámites**: los pagos y el registro de cuenta siguen siendo estrictamente en
línea porque mueven dinero o crean credenciales.

- La cola vive en `localStorage` (`municipalidad.cola.tramites`), separada por usuario. No
  está en el servidor: si el equipo se apaga o se borran los datos del navegador, se pierde.
  El administrador **no ve** los pendientes de otros equipos hasta que se sincronizan.
- Al enviar el formulario se intenta primero en línea con una `Idempotency-Key`. Si falla
  por red, timeout, `408`, `425`, `429`, `500`, `502`, `503`, `504`, el trámite se encola
  con la misma clave. Un `400/403/404/409` se muestra como error para corregirlo, no se
  reintenta.
- La sincronización es automática cada 20 s mientras la pestaña está visible y hay sesión;
  también al volver a estar en línea, al mostrar la app y con el botón **Reintentar ahora**.
  Hay backoff de 5 s a 5 min; un `401` pausa los envíos 60 s. Se conservan los últimos 20
  envíos como historial.
- El servidor garantiza idempotencia con el unique `(usuario_id, clave_idempotencia)`:
  reintentar la misma clave devuelve `200` con el trámite ya creado (`Idempotent-Replay:
  true`) en vez de duplicarlo. Conserva `creado_cliente_en` y `origen='offline'`, y lista
  por la fecha original de la solicitud, no por la de sincronización.
- El trámite encolado muestra un aviso y aparece en **Pendientes de envío**; al pasar a
  enviado queda en el historial. En la tabla se ve la etiqueta `offline` y
  “Solicitado … · Registrado …”.
- Limitaciones: la cola es por navegador y por origen. Con el túnel, si la URL cambia se
  pierde el acceso a la cola guardada bajo la URL anterior. Si el navegador se cierra justo
  después de que el servidor creó el trámite pero antes de recibir la respuesta, el
  reintento manual puede crear otro: para cubrir ese caso haría falta un outbox persistido
  en el servidor.

---

## 9. Pendientes

- [x] Exigir identidad firmada en trámites y pagos (`X-Identidad`)
- [x] Proteger `GET /api/v1/usuarios` con rol `admin`
- [x] Validar que el ciudadano solo pague trámites propios
- [x] Separar la solicitud de pago (`pendiente`) de su confirmación por tesorería/admin
- [x] Exponer `/api/v1/auth/*` y `/api/v1/account/*` en el gateway (solo hacia usuarios)
- [x] Rotación del secreto compartido (actual + anterior) y revocación de identidades por `jti` antes de que caduquen
- [x] Tabla de eventos (`tramites_eventos`) que preserva el sello de creación
- [x] Control de concurrencia optimista con `version` (409 si la fila cambió)
- [x] Reintentos adaptativos por dependencia y métricas de tasa de fallo
- [x] Pruebas automatizadas (Japa): 8 en usuarios, 29 en trámites, 7 en pagos
- [x] Cola offline de trámites con reintento automático, idempotencia y fecha original
- [x] Acceso desde internet con túnel HTTPS temporal (`scripts/tunel.sh`)
- [x] Pruebas de integración del flujo de pago en dos pasos (`scripts/integracion_pagos.sh`, 18 comprobaciones)
- [x] `node ace build` multi-stage en los `Dockerfile`, con `NODE_ENV=production` en ejecución
- [x] Catálogo configurable de tipos de trámite con monto, gestionado por admin
- [x] DNI como identificador de usuario y códigos legibles `T…`/`P…`
- [x] Catálogo de estados válidos y transiciones permitidas para trámites
- [x] Quitar `users` y `auth_access_tokens` (y el andamiaje de auth) de trámites y pagos
- [x] Sacar `.adonisjs/` (generado por `node ace codegen`) del control de versiones

---

## 10. Tolerancia a fallos

### Qué hace cada pieza

| Pieza | Dónde | Para qué |
|---|---|---|
| Timeout por llamada | `app/services/cliente_http.ts` | Que una dependencia que acepta la conexión pero no responde no bloquee el servicio para siempre. |
| Reintentos con backoff creciente y adaptativos | idem | Reintenta fallos probablemente transitorios (réplica reiniciándose, red saturada). **No** reintenta ante un 4xx. Si la dependencia ya falla ≥50% de las llamadas, deja de reintentar para no amplificar la caída. |
| Métricas por dependencia | `cliente_http.ts` | Cuenta llamadas, éxitos, fallos, reintentos, latencia promedio y tasa de fallo. Se exponen en `/api/v1/circuitos/*`. |
| Interruptor de circuito | `app/services/interruptor.ts` | Tras varios fallos seguidos, deja de llamar a la dependencia y falla en milisegundos, en lugar de hacer que cada petición del cliente pague la espera completa. |
| Reparto y failover | `gateway/nginx.conf` | Round-robin entre las dos réplicas, con expulsión de las que fallan (`max_fails=1 fail_timeout=10s`). |
| Saga de confirmación | `pagos_controller.ts` y `reconciliador.ts` | La confirmación registra una intención, marca el trámite como pagado y acredita el pago. Si el proceso muere entre medias, el reconciliador termina el trabajo; el pago permanece pendiente mientras tanto. |

### El presupuesto de tiempo (la parte que más cuesta entender)

El peor caso de una llamada entre servicios **no** es un timeout, es un timeout
multiplicado por los reintentos:

```
peor caso = HTTP_TIMEOUT_MS × (HTTP_REINTENTOS + 1) + esperas de backoff
```

Ese total tiene que quedar **por debajo** de `proxy_read_timeout` del gateway. Si no,
nginx agota su tiempo de espera antes de que el servicio alcance a gestionar el fallo,
lo cuenta como error del upstream y, con `max_fails=1`, **expulsa a las dos réplicas a
la vez**. El efecto es el contrario del buscado: el gateway deja de poder llegar al
servicio que solo tardaba de más.

Values por defecto:

| Parámetro | Valor | Dónde |
|---|---|---|
| `HTTP_TIMEOUT_MS` | 2000 | `cliente_http.ts` (por proceso) |
| `HTTP_REINTENTOS` | 1 | `cliente_http.ts` (base para todas) |
| `HTTP_REINTENTOS_TRAMITES` | hereda | `cliente_http.ts` (override de pagos) |
| `HTTP_REINTENTOS_USUARIOS` | hereda | `cliente_http.ts` (override de trámites y pagos) |
| Peor caso calculado | **4.1s** | 2000 × 2 + 100ms de backoff |
| `proxy_connect_timeout` | 1s | `nginx.conf` |
| `proxy_read_timeout` | 8s | `nginx.conf` |
| Margen | ~3.9s | |

Si subes cualquiera de los tres primeros, sube también el `proxy_read_timeout`.

### Los tres estados del circuito

```
cerrado     normal. La llamada pasa y los fallos se cuentan.
abierto     la dependencia esta caída: se falla en ~1ms sin llamar a nadie.
            Tras CIRCUIT_ABIERTO_MS (10s) vuelve a estado "enPrueba".
enPrueba    pasa UNA sola llamada de comprobación. Si funciona, el circuito se
            cierra; si falla, vuelve a abrirse. Las demás siguen fallando rápido.
```

Cada réplica tiene su propio circuito, porque cada réplica es un proceso independiente:
con 2 réplicas hacen falta 2×`CIRCUIT_UMBRAL` (3) = **6 peticiones** para que las dos
dejen de golpear a un servicio caído.

### Comprobación con curl

```bash
# Ver el estado de los circuitos
curl -s http://localhost:8080/api/v1/circuitos/pagos
curl -s http://localhost:8080/api/v1/circuitos/tramites
```

```json
{"circuitos":[
  {"dependencia":"tramites","estado":"cerrado","fallosConsecutivos":0,
   "umbral":3,"seReabreEnMs":0},
  {"dependencia":"usuarios","estado":"cerrado","fallosConsecutivos":0,
   "umbral":3,"seReabreEnMs":0}],
 "metricas":[
  {"dependencia":"tramites","llamadas":12,"exitos":10,"fallos":2,
   "reintentos":2,"tasaFallo":0.167,"latenciaPromedioMs":41,"ultimoError":null}]}
```

Las métricas son **acumuladas en memoria desde el arranque de la réplica**: se pierden al
reiniciar y no se comparten entre réplicas. Sirven para observar una réplica concreta, no
como serie histórica (para eso haría falta Prometheus/OpenTelemetry).

Simular cada tipo de fallo:

```bash
# Caída total de una dependencia
docker compose stop tramites_1 tramites_2
for i in $(seq 1 8); do
  curl -s -o /dev/null -w "%{http_code} %{time_total}s  " \
    -X POST http://localhost:8080/api/v1/pagos \
    -H 'Content-Type: application/json' \
    -d '{"id_tramite":"T16","usuario_id":"10000001","monto":1,"metodo_pago":"x","fecha_pago":"2026-01-15T10:00:00Z"}'
done
docker compose start tramites_1 tramites_2

# Cuélgue: el servicio acepta la conexión pero no responde.
# Freeze es mejor que stop para simularlo, porque con stop la conexión se rechaza
# al instante y no hay nada que esperar.
docker compose pause tramites_1 tramites_2
# ...
docker compose unpause tramites_1 tramites_2

# Una sola réplica caída
docker compose stop tramites_2
# ...
docker compose start tramites_2
```

### Resultados medidos

Comparando la línea base (antes de esta etapa) con el resultado actual:

| Escenario | Antes | Ahora |
|---|---|---|
| Una réplica de tramites caída | 200, hasta **3.03s** | 200, p50 ~25ms, p95 **~1000ms** |
| Tramites completo caído | **504** en 6.0s | 503: 2s las primeras, **~20ms** con el circuito abierto |
| Tramites colgado (congelado) | **504 en 20.0s** | **503**: 2s al principio, 20ms después |
| Base de datos caída | **500 en 8.4s** | **503 en 0.3s**, con mensaje explicito |
| `GET /health` con todo caído | 200 | 200 |

Para ver la tabla completa con p50 / p95 / máximo, y el guion de la presentación:
[DEMOSTRACION.md](./DEMOSTRACION.md).

Observaciones de las pruebas:

- **El failover del gateway siempre funcionó**, incluso antes de esta etapa. Lo que
  costaba era la latencia: hasta 3s por réplica caída.
- **`/health` responde 200 aunque los tres servicios estén caídos.** Por eso está
  separado de los upstreams: sirve para distinguir "nginx cayó" de "los servicios
  cayeron", que es justo lo que un orquestador necesita saber para decidir.
- **Tras `stop`, la respuesta de nginx puede ser 502/504 o un 503 del servicio
  llamador**, según si las réplicas ya fueron expulsadas por `fail_timeout`. No es
  inconsistente: son dos capas distintas contestando.
- Cuando `tramites` está congelado, la respuesta es **503 con mensaje de pagos**, no 502
  de nginx. Ese es el comprobante de que el presupuesto de tiempo está bien: si saliera
  502, el gateway estaría agotando su espera antes de tiempo.

### Un detalle que muerde durante las pruebas

Si esperas a que un servicio levante **consultando a través del gateway**, nginx ve un
fallo de conexión mientras ese servicio reinicia y, con `max_fails=1`, lo expulsa durante
10 s. Después el gateway devuelve 502 aunque el servicio ya esté de vuelta. Para esperar
hay que consultar la réplica por su puerto de host (`localhost:3337`), no el 8080.
`scripts/demostracion.sh` lo hace así en `esperar_replica()`.

### La base de datos también tiene presupuesto de tiempo

Con `postgres` caído, `GET /tramites` se quedaba **8.4s** y devolvía un 500 con la traza
de conexión dentro, que no explicaba nada. Ahora:

| | Antes | Ahora |
|---|---|---|
| Respuesta | 500 con traza | **503** con `{"message":"La base de datos no está disponible"}` |
| Tiempo | 8.4s | **0.3s** |

Lo que se hizo:

- `connectionTimeoutMillis: 2000` en el pool de los tres servicios. Es el tope para
  **conseguir** una conexión; sin él, una petición se queda esperando a que el pool la dé.
- `acquireTimeoutMillis: 4000` para esperar una conexión libre. Va por encima del anterior
  a propósito, para que el error siga siendo "no hay PostgreSQL" y no "no hay conexiones
  libres en el pool".
- `app/exceptions/handler.ts` traduce los errores de conexión (`ECONNREFUSED`, `ETIMEDOUT`,
  `Unable to acquire a connection`, …) a un **503 con mensaje**, en vez de un 500 opaco.

El 2s tiene que quedar por debajo de `proxy_read_timeout` del gateway (8s) por el mismo
motivo que el presupuesto entre servicios: si el gateway agota su espera antes, expulsa a
los propios servicios en lugar de recibirlos.

> **Un detalle que salió de esta prueba:** nginx tiene `proxy_next_upstream ... http_503`, así
> que un 503 **legítimo de la aplicación** lo cuenta como fallo del upstream y expulsa esa
> réplica durante `fail_timeout` (10s). La petición siguiente recibe un 502 en vez de su 503.
> Es un comportamiento discutible y está documentado en el script de verificación, que
> captura código y cuerpo en la **misma** petición para no medir eso por error.

### Lo que esta etapa NO resuelve
- **La confirmación no es atómica entre servicios.** Si pagos muere entre marcar el
  trámite y acreditar el pago, la intención queda registrada y el reconciliador termina
  el trabajo; mientras tanto el pago sigue pendiente. Un *outbox* lo haría más directo,
  pero ya es otra arquitectura.
- **Los reintentos se adaptan a la tasa de fallo agregada**, no al motivo: no distinguen
  "réplica reiniciándose" de "servicio muerto" ni por código de error. Las métricas viven
  en memoria de cada réplica y no son una serie histórica.
- **`CIRCUIT_UMBRAL` y `CIRCUIT_ABIERTO_MS` son globales al proceso**, no por dependencia
  ni por código de error.