# GUION DE DEMOSTRACIÓN — ~15 minutos

Guion manual para presentar el proyecto: qué decir, qué comando ejecutar, qué se espera
que salga y qué demuestra cada paso.

> Los valores esperados son los verificados en el sistema real. Donde el número puede
> variar (latencias, qué réplica atiende) se indica explícitamente.

**Complementos:** [README.md](./README.md) tiene los endpoints, el esquema y las variables
de entorno. [DEMOSTRACION.md](./DEMOSTRACION.md) tiene el script automático que mide lo
mismo, y las limitaciones técnicas conocidas. [RECUPERACION.md](./RECUPERACION.md) explica
**por qué** el punto 5 usa Saga y no 2PC.

---

## §-1 · Comprobación rápida (2 min)

Si quieres dejar constancia rápida de los tres puntos antes de la exposición:

```bash
./scripts/verificacion.sh
```

Imprime `PASS`/`FAIL` en cada una de las **76 comprobaciones** y termina con un
resumen. Apaga y levanta contenedores, pero **no borra datos**, así que es seguro
en cualquier momento. La salida completa está en [EVIDENCIAS.txt](./EVIDENCIAS.txt).

```
   Comprobaciones: 76
   Superadas:  76
   Fallidas:   0

    LOS TRES PUNTOS DEL INFORME QUEDAN VERIFICADOS.
```

> Si una comprobación falla por culpa de un servicio que tardó en arrancar, repite el
> bloque: comprueba siempre por el puerto de la réplica, no por el 8080.

---

## §0 · Preparación — 5 min, ANTES del día

```bash
cd municipalidad
docker compose down -v          # borra el volumen: base de datos desde cero
docker compose up -d --build
docker compose ps               # esperar a que los 7 estén Up / healthy
```

**Esperado:** 7 contenedores. `municipalidad_postgres (healthy)`, `municipalidad_gateway`,
y las 6 réplicas en `(healthy)`. También 4 contenedores `Exited (0)`: `db_init` y los tres
`*_migrate`.

> **Digo:** "Empiezo con la base de datos vacía. Estos cuatro contenedores de un solo uso
> crean las bases y aplican las migraciones; no los quité porque las dos réplicas de un
> servicio migrarían a la vez sobre la misma base y una fallaría."

```bash
# El seeder deja dos cuentas listas: admin y tesorería.
curl -s -X POST localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@municipalidad.gob","password":"Municipal123"}'
```

**Esperado:** `{"data":{"user":{"id":"10000001",...},"token":"oat_...","identidad":"..."}}`

```bash
IDENTIDAD=$(curl -s -X POST localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@municipalidad.gob","password":"Municipal123"}' \
  | jq -r '.data.identidad')
ADMIN_ID=10000001
```

Las rutas de trámites, pagos y el listado de usuarios exigen la cabecera
`X-Identidad: $IDENTIDAD`. La cuenta `tesoreria@municipalidad.gob` / `Tesoreria123`
tiene rol `personal_muni_tesoreria` y sirve para mostrar quién puede confirmar pagos.

> **El id del administrador es su DNI: `10000001`.** En el resto del guion se usa ese valor.
> La tesorería sembrada tiene `10000002`. Los ids de trámites y pagos son códigos: `T1`,
> `P1`, etc.

---

## §1 · Arquitectura — 1 min

**Digo:** "Tres microservicios independientes, dos réplicas cada uno, un PostgreSQL con
tres bases separadas, y nginx como gateway único."

```bash
docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'
```

```bash
docker compose exec postgres psql -U municipalidad -d postgres -c "\l"
```

**Esperado:** `municipalidad`, `usuarios_db`, `pagos_db`.

```bash
docker compose exec postgres psql -U municipalidad -d municipalidad -c "\dt"
```

**Esperado:** `tramites`, `tipos_tramite`. (La identidad vive en `usuarios_db`.)

> **Digo:** "Una base por servicio. No hay foreign keys entre servicios: cada uno sólo
> conoce su esquema y las referencias se validan por HTTP. Eso lo vas a ver en un minuto."

**Prueba del reparto entre réplicas:**

```bash
for i in $(seq 1 6); do
  curl -s -o /dev/null -H "X-Identidad: $IDENTIDAD" http://localhost:8080/api/v1/tramites
done
docker compose logs --no-log-prefix --tail 6 gateway | grep upstream=
```

**Esperado:** alternan `upstream=172.28.0.13` y `upstream=172.28.0.14`.

> **Digo:** "Esas IP son `tramites_1` y `tramites_2`. El log del gateway está configurado
> para decir a qué réplica respondió, porque el de nginx por defecto no lo dice."

---

## §2 · Comunicación real entre servicios — 3 min

> **Digo:** "Ahora lo importante: el `usuarioId` que manda el cliente **no se confía**.
> `tramites` y `pagos` lo preguntan al servicio `usuarios`."

```bash
curl -s -X POST localhost:8080/api/v1/tramites \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
  -d '{"usuarioId":"99999999","tipo":"Otro","tipoDetalle":"licencia","monto":1000,"descripcion":"prueba"}'
```

**Esperado:** `{"message":"El usuario indicado no existe"}` → **400**

```bash
curl -s -X POST localhost:8080/api/v1/tramites \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
  -d '{"tipo":"Otro","tipoDetalle":"licencia","monto":1000,"descripcion":"prueba"}'
```

**Esperado:** `{"message":"El usuario indicado no es valido"}` → **400**

```bash
TRAMITE=$(curl -s -X POST localhost:8080/api/v1/tramites \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
  -d "{\"usuarioId\":\"$ADMIN_ID\",\"tipo\":\"Licencia de funcionamiento\",\"descripcion\":\"prueba\"}" \
  | jq -r '.id')
```

**Esperado:** **201**, con `"id":"T1"`, `"lamport":5`, `"nodeId":"tramites_1"` y el monto del
catálogo (`25000`). Si eliges `"tipo":"Otro"`, debes mandar `tipoDetalle` y `monto`.

Ahora el pago. La **solicitud** solo registra la intención; la **confirmación** es la que
cruza a `tramites`:

```bash
curl -s -X POST localhost:8080/api/v1/pagos \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
  -d '{"id_tramite":"T999","usuario_id":"10000001","monto":15000,"metodo_pago":"tarjeta","fecha_pago":"2026-01-15T10:00:00Z"}'
```

**Esperado:** `{"mensaje":"El trámite indicado no existe"}` → **400**

```bash
PAGO=$(curl -s -X POST localhost:8080/api/v1/pagos \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
  -d "{\"id_tramite\":\"$TRAMITE\",\"usuario_id\":\"$ADMIN_ID\",\"monto\":15000,\"metodo_pago\":\"tarjeta\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}")
PAGO_ID=$(echo "$PAGO" | jq -r '.idPago')
```

**Esperado:** **201**, con `"idPago":"P1"` y `"estado":"pendiente"`. El trámite sigue
`pendiente`: **solicitar no cobra**.

```bash
curl -s -X POST "localhost:8080/api/v1/pagos/$PAGO_ID/confirmar" \
  -H "X-Identidad: $IDENTIDAD"
```

**Esperado:** **200**, el pago pasa a `pagado`.

```bash
curl -s -H "X-Identidad: $IDENTIDAD" "http://localhost:8080/api/v1/tramites/$TRAMITE"
```

**Esperado:** `"estado":"pagado"`

> **Digo:** "Ese cambio de estado lo hizo la confirmación de `pagos` con un `PATCH` a otro
> servicio, cruzando el gateway. Antes de cruzar registra la intención en
> `pagos_intentos`; si el proceso muere en la ventana, el reconciliador termina el trabajo
> y el pago queda pagado. Ya no se borra el pago: se recupera hacia adelante."

### La prueba fuerte (el momento de la presentación)

```bash
docker compose stop usuarios_1 usuarios_2
```

```bash
curl -s -X POST localhost:8080/api/v1/tramites \
  -H 'Content-Type: application/json' \
  -d "{\"usuarioId\":\"$ADMIN_ID\",\"tipo\":\"Otro\",\"tipoDetalle\":\"x\",\"monto\":1000,\"descripcion\":\"y\"}"
```

**Esperado:** `{"message":"No se pudo verificar el usuario"}` → **503**

> **Digo:** "El usuario 10000001 **sí existe** en la base de datos. Pero sin el servicio
> `usuarios` no puedo confirmar nada, así que no creo el trámite. Si fuera confianza en el
> cliente, lo habría creado sin preguntar a nadie."

```bash
docker compose up -d usuarios_1 usuarios_2

# esperar por el PUERTO DE LA RÉPLICA, no por el gateway:
until curl -s -o /dev/null localhost:3335; do sleep 2; done
until curl -s -o /dev/null localhost:3336; do sleep 2; done

curl -s -X POST localhost:8080/api/v1/tramites \
  -H 'Content-Type: application/json' \
  -d "{\"usuarioId\":\"$ADMIN_ID\",\"tipo\":\"Otro\",\"tipoDetalle\":\"x\",\"monto\":1000,\"descripcion\":\"y\"}"
```

**Esperado:** **201**

> ⚠ **Por qué espero por 3335/3336 y no por 8080:** si esperas consultando el gateway
> mientras la réplica reinicia, nginx ve un fallo de conexión y con `max_fails=1` la
> expulsa durante 10 segundos. Después el gateway devuelve **502 aunque la réplica ya esté
> sana**. Me pasó escribiéndome las pruebas.

---

## §3 · Relojes lógicos de Lamport — 3 min

> **Digo:** "Cada réplica es un proceso distinto y tiene su propio reloj lógico. El sello
> viaja en una cabecera HTTP."

```bash
docker compose restart tramites_1 tramites_2 usuarios_1 usuarios_2 pagos_1 pagos_2

# esperar por puertos:
for p in 3333 3334 3335 3336 3337 3338; do
  until curl -s -o /dev/null localhost:$p; do sleep 2; done
done
```

```bash
for p in 3333 3334 3335 3336 3337 3338; do
  printf "%s: " "$p"; curl -s localhost:$p/api/v1/reloj; echo
done
```

**Esperado:** los seis en `"lamport":0`

```bash
curl -s -X POST localhost:8080/api/v1/tramites \
  -H 'Content-Type: application/json' \
  -d "{\"usuarioId\":\"$ADMIN_ID\",\"tipo\":\"Otro\",\"tipoDetalle\":\"sello\",\"monto\":1000,\"descripcion\":\"sello\"}"
```

**Esperado:** `"lamport":5, "nodeId":"tramites_1"` (o `tramites_2`, según el reparto)

```bash
for p in 3333 3334 3335 3336 3337 3338; do
  printf "%s: " "$p"; curl -s localhost:$p/api/v1/reloj; echo
done
```

**Esperado:** `usuarios_? = 3`, `tramites_? = 5`, y **los dos de `pagos` siguen en 0**.

> **Digo:** "La aritmética: `tramites` envió un `GET` a `usuarios` con sello **1**.
> `usuarios` lo recibió → `C := max(C,1)+1 = 2`, y respondió con sello **3**. `tramites`
> recibió el 3 → `C := max(C,3)+1 = 4`. Y el evento local de insertar el trámite →
> `C := C+1 = 5`. Los relojes de `pagos` siguen en 0 porque **no participaron**: son
> procesos que no se hablaron en esta operación."

Ahora el remate:

```bash
for i in $(seq 1 8); do
  curl -s -o /dev/null -X POST localhost:8080/api/v1/tramites \
    -H 'Content-Type: application/json' \
    -d "{\"usuarioId\":\"$ADMIN_ID\",\"tipo\":\"Otro\",\"tipoDetalle\":\"conc\",\"monto\":1000,\"descripcion\":\"p$i\"}" &
done; wait

docker compose exec postgres psql -U municipalidad -d municipalidad -c \
  "SELECT id, lamport, node_id FROM tramites WHERE tipo_detalle='conc' ORDER BY lamport"
```

**Esperado:** trámites con **sellos cercanos y repartidos entre las dos réplicas**. Si dos
salen con el mismo `lamport` en `node_id` distintos, son concurrentes. Salida real de una
corrida:

```
  id | lamport |  node_id
-----+---------+------------
 T20 |      11 | tramites_2
 T21 |      13 | tramites_2
 T24 |      19 | tramites_1
 T25 |      20 | tramites_1
```

> **Digo:** "Estos dos pasaron a la vez. Ningún proceso se enteró del otro, y el reloj
> **correctamente se niega a ordenarlos**. Eso es lo que aporta un reloj lógico: garantiza
> orden donde hay causalidad, y se declara indeterminate donde no la hay. Un `created_at`
> con milisegundos no te da ninguna de las dos cosas."

> Con el flujo actual cada alta consulta a `usuarios`, lo que hace avanzar los relojes. Los
> empates de la ráfaga dependen del intercalado real y pueden no aparecer en todas las
> corridas; el punto conceptual se mantiene: el reloj no ordena eventos sin causalidad.

Para que el empate salga **siempre** en la presentación, la etapa 2.5 del script manda dos
`PATCH` simultáneos directos a cada réplica con el mismo `X-Lamport` externo:

```bash
LOGIN=$(curl -s -X POST localhost:8080/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@municipalidad.gob","password":"Municipal123"}')
IDENTIDAD=$(echo "$LOGIN" | jq -r '.data.identidad')

# Dos trámites dedicados
A=$(curl -s -X POST localhost:8080/api/v1/tramites -H 'Content-Type: application/json' \
  -H "X-Identidad: $IDENTIDAD" \
  -d '{"usuarioId":"10000001","tipo":"Otro","tipoDetalle":"empate","monto":1000,"descripcion":"A"}' | jq -r .id)
B=$(curl -s -X POST localhost:8080/api/v1/tramites -H 'Content-Type: application/json' \
  -H "X-Identidad: $IDENTIDAD" \
  -d '{"usuarioId":"10000001","tipo":"Otro","tipoDetalle":"empate","monto":1000,"descripcion":"B"}' | jq -r .id)

# El mismo sello externo a cada réplica, a la vez
curl -s -X PATCH localhost:3333/api/v1/tramites/$A -H 'Content-Type: application/json' \
  -H "X-Identidad: $IDENTIDAD" -H 'X-Lamport: 900000' -d '{"estado":"en_revision"}' | jq '{lamport,nodeId}' &
curl -s -X PATCH localhost:3334/api/v1/tramites/$B -H 'Content-Type: application/json' \
  -H "X-Identidad: $IDENTIDAD" -H 'X-Lamport: 900000' -d '{"estado":"en_revision"}' | jq '{lamport,nodeId}' &
wait
```

Salida garantizada:

```
{"lamport":900002,"nodeId":"tramites_1"}
{"lamport":900002,"nodeId":"tramites_2"}
```

---

## §4 · Tolerancia a fallos — 5 min

### 4.1 Línea base

```bash
for i in $(seq 1 10); do
  curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' \
    -H "X-Identidad: $IDENTIDAD" http://localhost:8080/api/v1/tramites
done
```

**Esperado:** todas `200`, alrededor de **0.03 s**.

### 4.2 Una réplica cae — el failover funciona, pero cuesta

```bash
docker compose stop tramites_2
for i in $(seq 1 10); do
  curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' \
    -H "X-Identidad: $IDENTIDAD" http://localhost:8080/api/v1/tramites
done
docker compose start tramites_2
```

**Esperado:** todas `200`, pero **alguna tarda ~1 s**.

> **Digo:** "El sistema sobrevive: nginx reparte y salta a la réplica sana. Lo que cuesta es
> latencia, porque la petición que cae en la réplica muerta espera a que agote
> `proxy_connect_timeout`, un segundo."

### 4.3 El servicio entero cae — aquí se abre el circuito

```bash
docker compose stop tramites_1 tramites_2
docker compose restart pagos_1 pagos_2
until curl -s -o /dev/null localhost:3337; do sleep 2; done
until curl -s -o /dev/null localhost:3338; do sleep 2; done
docker compose restart gateway
```

```bash
for i in $(seq 1 6); do
  curl -s -o /dev/null -w 'petición %{http_code} en %{time_total}s\n' \
    -X POST http://localhost:8080/api/v1/pagos \
    -H 'Content-Type: application/json' \
    -d "{\"id_tramite\":\"$TRAMITE\",\"usuario_id\":\"$ADMIN_ID\",\"monto\":1,\"metodo_pago\":\"efectivo\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}"
done
```

**Esperado — salida real:**

```
petición 503 en 2.082623s     <- todavía llama a tramites y espera su timeout
petición 503 en 2.065635s
petición 503 en 1.138858s     <- el circuito se está abriendo
petición 503 en 0.148057s
petición 503 en 0.136376s
petición 503 en 0.018835s     <- circuito abierto: falla sin llamar a nadie
```

```bash
curl -s localhost:3337/api/v1/circuitos/pagos
curl -s localhost:3338/api/v1/circuitos/pagos
```

**Esperado:**

```json
{"circuitos":[{"dependencia":"tramites","estado":"abierto","fallosConsecutivos":3,"umbral":3,...},...]}
```

**en las dos réplicas.**

> **Digo:** "Fíjense en la transición: 2 segundos, 2 segundos, y de golpe 20 milisegundos.
> Eso es el interruptor de circuito. Y que salga `3/3` en **las dos** réplicas es
> intencionado: cada réplica es un proceso con su propio circuito, así que hacen falta 6
> peticiones para que las dos dejen de golpear a un servicio muerto. Antes de esto eran 20
> segundos por petición; ahora 20 milisegundos."

### 4.4 Servicio congelado — peor que "caído"

```bash
docker compose start tramites_1 tramites_2
docker compose restart pagos_1 pagos_2
until curl -s -o /dev/null localhost:3337; do sleep 2; done
until curl -s -o /dev/null localhost:3338; do sleep 2; done

docker compose pause tramites_1 tramites_2
docker compose restart gateway

curl -s -w '\n  -> %{http_code}\n' -X POST localhost:8080/api/v1/pagos \
  -H 'Content-Type: application/json' \
  -d "{\"id_tramite\":\"$TRAMITE\",\"usuario_id\":\"$ADMIN_ID\",\"monto\":1,\"metodo_pago\":\"efectivo\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}"

docker compose unpause tramites_1 tramites_2
```

**Esperado:** `{"mensaje":"No se pudo conectar con el servicio de trámites"}` → **503**

> **Digo:** "Usé `pause` y no `stop` a propósito. Con `stop` la conexión se rechaza al
> instante; con `pause` el servicio **acepta la conexión y no contesta**, que es lo que de
> verdad rompe a un cliente. Y noten que el 503 lo devuelve `pagos`, no nginx: si fuera un
> 502 significaría que el gateway agotó su espera primero y ya expulsó a `pagos`."

### 4.5 Recuperación

```bash
docker compose up -d
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/api/v1/pagos \
  -H 'Content-Type: application/json' \
  -d "{\"id_tramite\":\"$TRAMITE\",\"usuario_id\":\"$ADMIN_ID\",\"monto\":1,\"metodo_pago\":\"recuperacion\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}"
```

**Esperado:** **201**

### 4.6 Coherencia: no hay pagos acreditados sin trámite pagado

```bash
docker compose exec -T postgres psql -U municipalidad -d municipalidad -tAc \
  "SELECT id FROM tramites WHERE estado='pagado'" | sort > /tmp/pagados.txt

docker compose exec -T postgres psql -U municipalidad -d pagos_db -tAc \
  "SELECT DISTINCT id_tramite FROM pagos WHERE estado='pagado'" | sort > /tmp/pagos.txt

comm -23 /tmp/pagos.txt /tmp/pagados.txt
```

**Esperado:** **salida vacía**.

> **Digo:** "Vacío significa cero pagos huérfanos: todo pago **acreditado** tiene su trámite
> en estado pagado. Un pago pendiente no es un huérfano: es una solicitud esperando
> confirmación. Y noten que no hay JOIN posible: las tablas están en **bases de datos
> distintas**, así que la comparación es por lista. Si la confirmación falla, el pago queda
> pendiente y la intención permite que el reconciliador termine después."

> Ojo al leer el SQL: un pago nace `pendiente` y solo pasa a `pagado` cuando la
> confirmación termina. Filtrar por `estado='pagado'` distingue lo acreditado de lo que solo
> está solicitado.

### 4.7 La sonda de vida

```bash
curl -s -i localhost:8080/health | head -3
```

**Esperado:** `HTTP/1.1 200 OK` con `ok`.

> **Digo:** "Funciona aunque los tres servicios estén caídos, porque no pasa por ningún
> upstream. Distingue 'nginx cayó' de 'los servicios cayeron', que es lo que un orquestador
> necesita para decidir."

---

## §5 · Recuperación ante fallos — 3 min

> **Digo:** "Hasta aquí el sistema se comporta bien mientras nada falla. Ahora: ¿qué pasa
> cuando algo se rompe de verdad? Hay tres respuestas: hacer backup, volver en el tiempo, y
> que una operación a medias se recupere sola."

### 5.1 Backup: perder datos y recuperarlos

```bash
./scripts/recuperacion.sh demo-backup
```

El script crea 5 trámites, los borra, restaura el primario y lo comprueba. Salida real del
último paso:

```
5. Comprobación
   trámites de prueba en el primario: 5
   Los datos volvieron.
```

> **Digo:** "Los borré a propósito y volvieron. El backup no es solo un archivo: es un
> archivo del que se puede volver a construir el servicio."

Y el backup se puede restaurar **en una copia aparte** sin tocar el servicio, que es lo que
se hace en un entorno serio antes de confiar en él:

```bash
./scripts/recuperacion.sh restaurar
./scripts/recuperacion.sh comparar
```

### 5.2 PITR: volver a un instante exacto

Este es el más fuerte, porque **no devuelve el último backup: devuelve un momento concreto**.

```bash
./scripts/recuperacion.sh pitr-preparar
./scripts/recuperacion.sh pitr-destruir
```
**Esperado:**
```
Instante guardado: la recuperación volverá aquí
   2026-10-13T23:03:40.127

Ahora sí: se destruye información en el primario
   Tabla tabla_desastre creada con una fila.
```

```bash
docker compose --profile recuperacion logs postgres_recuperacion | grep "recovery stopping"
```
**Esperado (línea real del log de PostgreSQL):**
```
recovery stopping before commit of transaction 907, time 2026-10-13 23:03:40.654491+00
selected new timeline ID: 2
```

```bash
./scripts/recuperacion.sh pitr-recuperar
./scripts/recuperacion.sh pitr-verificar
```
**Esperado:**
```
Instancia recuperada (localhost:55433)
   trámites:              5
   usuarios:              2
   pagos:                 0

¿Existe la tabla creada DESPUÉS del instante de recuperación?
   NO existe.  El estado vuelve al instante pedido.

Instancia original (el primario sigue vivo y tiene el desastre)
   tabla_desastre existe: 1
```

> **Digo:** "PostgreSQL no devolvió un backup: reprodujo los archivos de WAL desde el backup
> hacia adelante y **se paró en el instante que le pedí**. Por eso el log dice
> `stopping before commit of transaction 907`. Y fíjense en las dos últimas líneas: el
> primario tiene la tabla del desastre y la copia recuperada no la tiene. Son dos estados
> distintos del mismo sistema, uno congelado en el pasado."

Limpieza:

```bash
./scripts/recuperacion.sh pitr-limpiar
```

### 5.3 Saga: una operación interrumpida se recupera sola

Esta es la parte que explica **por qué** no se usaron savepoints ni 2PC. El detalle
completo está en [RECUPERACION.md](./RECUPERACION.md).

```bash
./scripts/recuperacion.sh saga
```

**Esperado (salida real):**
```
4. Se confirma el pago: el proceso muere en mitad de la operación
   HTTP 502   (000 = el proceso murió en mitad de la operación)

5. ESTADO TRAS LA INTERRUPCIÓN
   pago guardado:        1
   estado del pago:      pendiente
   estado del trámite:   pendiente
   intención registrada: pendiente
   El pago está guardado pero el trámite no está pagado: el sistema quedó
   a medio camino. La intención quedó registrada, y eso es lo que permite
   que otro proceso sepa qué hacer.

6. Se reinicia pagos sin el fallo: arranca el reconciliador
   El reconciliador espera 5 segundos antes de actuar, por si el proceso
   anterior solo estaba lento y no muerto.

7. ESTADO TRAS LA RECUPERACIÓN
   pago guardado:        1
   estado del pago:      pagado
   estado del trámite:   pagado
   intención:            confirmado

   RECUPERACIÓN COMPLETA: el otro proceso terminó el trabajo.

Historial de intenciones
   #N  confirmado  pago=N  el reconciliador completó el PATCH del trámite
```

> Los números exactos dependen de cuántos trámites y pagos hayas creado antes.

> **Digo:** "Esto no es una simulación: el proceso **se muere** con `process.exit`, deja el
> pago guardado y el trámite sin pagar. El sistema queda a medio camino, que es
> exactamente lo que pasaba antes y no se arreglaba.
>
> La diferencia es que ahora, antes de hacer nada, `pagos` deja escrita la **intención** en
> una tabla. Cuando el proceso muere, esa fila se queda en `pendiente`, y el reconciliador
> que arranca con el servicio la retoma.
>
> Noten que la recuperación fue **hacia adelante**: en vez de borrar el pago, el otro proceso
> **terminó el trabajo**. El usuario no pierde su pago. Solo borra cuando no hay manera de
> confirmar, y aunque en ese caso tampoco: prefiere dejarlo pendiente y reintentar."

Y el detalle técnico que más gusta a los profesores de sistemas:

```bash
grep -A6 "SKIP LOCKED" pagos/app/services/reconciliador.ts
```
```
  FOR UPDATE SKIP LOCKED
```

> **Digo:** "Las dos réplicas ejecutan el reconciliador al arrancar. Sin esto las dos
> procesarían la misma operación. `FOR UPDATE SKIP LOCKED` deja la fila bloqueada para la
> primera y le dice a la segunda que se la salte en vez de esperar. Es el mismo idioma que
> usan las colas de trabajo de PostgreSQL."

### 5.4 El registro de intenciones, en crudo

```bash
curl -s http://localhost:8080/api/v1/intentos | jq
```

**Esperado:**
```json
{
  "porEstado": { "confirmado": 3 },
  "ultimos": [
    { "id": 3, "estado": "confirmado", "pagoId": "P3",
      "ultimoError": "el reconciliador completó el PATCH del trámite" }
  ]
}
```

---

## §6 · Cola offline y acceso por internet (opcional, 2 min)

> Si sobra tiempo, esta es la parte nueva que más se acerca al uso real: el ciudadano
> escribe el trámite aunque el servicio esté caído y no pierde lo que ya redactó.

1. Entra como admin en **http://localhost:8080/ui/** y abre **Nuevo trámite**.
2. Baja el servicio de trámites:

```bash
docker compose stop tramites_1 tramites_2
```

3. Llena el formulario y pulsa **Registrar trámite**.

**Esperado:** un aviso de que quedó pendiente y la tarjeta **Pendientes de envío** con
`1 pendiente(s) de envío`. El trámite no está en la tabla todavía.

4. Levanta el servicio y espera unos segundos:

```bash
docker compose start tramites_1 tramites_2
```

5. Pulsa **Reintentar ahora** en la tarjeta de pendientes.

**Esperado:** pasa al historial como **enviado**, con el ID `T…`, y aparece en la tabla con
la etiqueta `offline` y **dos fechas**: “Solicitado … · Registrado …”. La segunda es la de
sincronización.

6. Comprueba que no se duplicó y que la fecha original se conservó:

```bash
docker compose exec postgres psql -U municipalidad -d municipalidad -c \
  "SELECT id, origen, creado_cliente_en, created_at FROM tramites ORDER BY id DESC LIMIT 1"
```

> **Digo:** "El formulario se envió con una clave de idempotencia. Si el servidor llegó a
> crearlo pero la respuesta se perdió, el reintento devuelve el mismo trámite en vez de
> crear otro. La cola vive en el navegador, no en el servidor: si se cierra el equipo o se
> borran los datos del navegador, se pierde. El administrador no ve lo que otro equipo aún
> no ha sincronizado."

7. Para enseñar acceso desde un teléfono por internet:

```bash
./scripts/tunel.sh
```

**Esperado:** una URL `https://…trycloudflare.com/ui/`. Ábrela desde el teléfono. Al
terminar, `./scripts/tunel.sh parar`.

> La URL cambia al reiniciar el túnel y el `localStorage` está atado al origen, así que una
> cola guardada bajo una URL vieja no aparece en la nueva. Para la demo basta con no
> reiniciar el túnel a mitad de la presentación.

---

## Anexo · Si algo falla

| Síntoma | Qué hacer |
|---|---|
| Todo da **502** | `docker compose restart gateway` (alguna réplica quedó expulsada) |
| Un `POST` da **503** y debería dar 201 | esperaste por el gateway; usa el puerto de la réplica (3333-3338) |
| El gateway no arranca | `docker compose logs gateway \| tail -5` |
| Empezar de cero | `docker compose down -v && docker compose up -d --build` |
| El gateway da 502 tras reiniciar algo | reinicia el gateway **después** de que la réplica esté sana |
| La demo del §5 se queda colgada | `./scripts/recuperacion.sh pitr-limpiar` y `docker compose up -d` |

### Comandos que quedaron sueltos

```bash
docker compose unpause tramites_1 tramites_2 usuarios_1 usuarios_2 pagos_1 pagos_2
docker compose up -d          # levanta todo lo que esté parado
```

### Si no tienes `jq`

`jq` se usa en §0 para extraer `IDENTIDAD` de la respuesta del login. Si no lo tienes,
instálalo (`sudo apt install jq`) o copia el valor a mano en la variable. El chequeo de
pagos huérfanos usa `psql` + `sort` + `comm`, sin `jq`.