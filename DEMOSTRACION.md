# Demostración del proyecto

Guía para presentar el sistema y ver **medidas reales** de su comportamiento. Todo lo que
se muestra aquí se obtiene ejecutando peticiones de verdad contra los contenedores: no
hay números escritos a mano ni simulaciones.

Si lo que quieres es la referencia técnica (endpoints, variables, esquema), está en
[README.md](./README.md). Si vas a presentar el proyecto a mano, paso a paso y con lo que
decir en cada momento, está en [GUION.md](./GUION.md).

---

## 1. Cómo ejecutarla

```bash
# El stack tiene que estar arriba
docker compose up -d --build

# La demostración completa (tarda unos 4 minutos)
./scripts/demostracion.sh

# O una parte concreta
./scripts/demostracion.sh comunicacion   # etapa 1, ~40 s
./scripts/demostracion.sh reloj          # etapa 2, ~1 min
./scripts/demostracion.sh fallos         # etapa 3, ~2 min
./scripts/demostracion.sh resumen        # solo el guion de la presentación
```

**Requisitos:** `docker`, `docker compose`, `curl`, `jq` y `psql` (este último solo se usa
dentro del contenedor de PostgreSQL, así que basta con tener Docker).

```bash
sudo apt install jq     # si falta
```

El script **detiene y congela contenedores**. Al terminar, y también si se interrumpe con
`Ctrl-C`, los levanta todos de nuevo (hay un `trap` para eso).

> Si lo interrumpes y algo queda parado: `docker compose up -d`

---

## 2. Qué demuestra cada parte

### Etapa 1 — Comunicación real entre servicios

**Lo que afirma:** que `pagos` y `tramites` no confían en el `usuarioId` que envía el
cliente, sino que lo preguntan al servicio `usuarios`. Además, la identidad de quien llama
viaja firmada y cada servicio la verifica localmente, sin depender de `usuarios`.

```
usuario inexistente (99999999)           El usuario indicado no existe  400
sin usuarioId                            El usuario indicado no es valido  400
usuario válido                            201 (id=T16)

trámite inexistente                      El trámite indicado no existe  400
usuario inexistente                      El usuario indicado no existe  400
solicitud de pago                        201 (idPago=P5, pendiente)
confirmación (tesorería/admin)          200
estado del trámite tras confirmar       pagado  <- lo cambió pagos con un PATCH
```

**La prueba que importa** es la última, la 1.3:

```
Se apaga usuarios por completo. El usuario SÍ existe en la base de datos.
crear trámite con usuarios caído         No se pudo verificar el usuario  503
```

Responde 503 y **no crea el trámite**. Si fuera confianza en el cliente, lo habría creado
sin preguntar a nadie.

**Cómo repetirla a mano:**

```bash
IDENTIDAD=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@municipalidad.gob","password":"Municipal123"}' \
  | jq -r '.data.identidad')

docker compose stop usuarios_1 usuarios_2

curl -X POST http://localhost:8080/api/v1/tramites \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
  -d '{"usuarioId":"10000001","tipo":"Otro","tipoDetalle":"x","monto":1000,"descripcion":"y"}'
# {"message":"No se pudo verificar el usuario"}

docker compose up -d usuarios_1 usuarios_2
```

### Etapa 2 — Relojes lógicos de Lamport

**Lo que afirma:** que cada réplica lleva su propio reloj, que el sello viaja entre
procesos y que se puede reconstruir el orden causal.

La parte 2.2 y 2.3 restart los relojes a cero y muestran el antes y el después, con la
aritmética calculada sobre los valores reales:

```
Traza de tramites_2 (reloj: 0 → 5):
  · envió GET /usuarios/<dni> con sello 1                    → 1
  · usuarios le respondió con sello 3                        → 3
  · recibió el sello 3:  C := max(C, 3) + 1               → 4
  · evento local de insertar el trámite: C := C + 1       → 5
```

La parte 2.4 manda **8 trámites en paralelo de verdad** y es la que más rinde:

```
id T20   lamport=11   tramites_2
id T21   lamport=13   tramites_2
id T24   lamport=19   tramites_1
id T25   lamport=20   tramites_1
```

Cuando dos eventos salen con el **mismo sello en réplicas distintas** son concurrentes:
ninguno se enteró del otro, y el reloj no puede ordenarlos. No es un fallo del método, es
su respuesta correcta. Lo que sí garantiza es que si un sello es menor que otro, el primero
ocurrió antes. Como cada alta consulta a `usuarios`, los empates de la ráfaga real dependen
del intercalado y pueden no aparecer siempre.

La parte 2.5 **sí garantiza un empate** en cada corrida: manda dos `PATCH` simultáneos, uno
directo a cada réplica (sin pasar por el gateway) y con el mismo `X-Lamport` externo, de
forma que ambas calculan el mismo contador sin hablarse:

```
trámite T49   → lamport=900002  node=tramites_1
trámite T50   → lamport=900002  node=tramites_2
Ambos sellos son 900002 en réplicas distintas: concurrentes.
```

**Cómo repetirla a mano:**

```bash
# Los relojes de cada réplica, por su puerto de host
curl -s localhost:3333/api/v1/reloj   # tramites_1
curl -s localhost:3334/api/v1/reloj   # tramites_2

# Por el gateway (devuelve una réplica al azar, porque hay round-robin)
curl -s localhost:8080/api/v1/reloj/tramites

# Los sellos guardados en la base, ordenados
docker compose exec postgres psql -U municipalidad -d municipalidad -c \
  "SELECT id, lamport, node_id FROM tramites WHERE lamport IS NOT NULL ORDER BY lamport"
```

### Etapa 3 — Tolerancia a fallos

Aquí es donde están las métricas de tiempo. Mide cuatro escenarios y calcula
**p50, p95 y máximo** de 20 peticiones reales cada uno.

Una salida típica:

```
escenario                          código    p50 ms    p95 ms    max ms
20 x GET /api/v1/tramites          200      26.5      39.5      45.1
20 x GET /tramites (sobrevive)     200      25.4    1021.0    1030.2
8 x POST /pagos (mediana)          503     136.4    2082.6    2082.6
5 x POST /pagos (colgado)          503     143.2    2071.3    2071.3
```

Qué significa cada columna:

| Columna | Qué es | Por qué importa |
|---|---|---|
| **p50** | La mitad de las peticiones tardaron menos de esto | El caso normal. |
| **p95** | El 95 % tardaron menos de esto | Empieza a verse el efecto del failover. |
| **max** | La más lenta | El peor caso: la que cae en la réplica muerta. |
| **código** | El código HTTP de todas | Si sobrevive con 200 o 503, el sistema no se rompe. |

**Cómo leerlo, escenario por escenario:**

1. **3.1 Línea base.** Todo en pie: ~25 ms de mediana. Referencia contra la que comparar.

2. **3.2 Una réplica caída.** Sigue devolviendo 200 (el gateway reparte), pero el p95 salta
   a ~1000 ms. Son las peticiones que cayeron en la réplica muerta y esperaron a que nginx
   agotara `proxy_connect_timeout` (1 s) antes de reintentar con la sana. **El failover
   funciona, pero se paga en latencia.**

3. **3.3 Servicio completo caído.** Esta es la parte más interesante, porque se ve la
   transición en la propia salida:

   ```
   petición 1 -> 503 en 2.08s      <- aún llama a tramites y espera su timeout
   petición 2 -> 503 en 2.06s
   petición 3 -> 503 en 1.13s
   petición 4 -> 503 en 0.14s      <- el circuito ya está abriendo
   petición 7 -> 503 en 0.02s      <- circuito abierto: falla sin llamar a nadie
   ```

   Y el estado de los circuitos lo confirma:

   ```
   pagos_1  tramites: abierto (fallos 3/3)
   pagos_2  tramites: abierto (fallos 3/3)
   ```

   Que sean **3/3 en las dos réplicas** es el punto: cada réplica es un proceso y tiene su
   propio circuito, así que hacen falta 2 × 3 = 6 peticiones para que las dos dejen de
   golpear a un servicio caído.

4. **3.4 Servicio congelado.** Peor que "caído": con `docker compose stop` la conexión se
   rechaza al instante; con `pause` el servicio acepta la conexión y no contesta, que es lo
   que de verdad rompe a un cliente.

   El detalle importante: responde **503 desde `pagos`**, no 502 desde nginx. Si saliera
   502 significaría que nginx agotó su espera antes que el cliente y expulsó a `pagos`
   entero; el 503 demuestra que el presupuesto de tiempo se respeta.

5. **3.5 Recuperación.** Pasado el tiempo de espera del circuito, una sola llamada de
   prueba reabre el camino y el siguiente pago vuelve a dar 201.

6. **3.6 Coherencia entre las dos bases.** Cuenta los **pagos huérfanos**: pagos ya
   acreditados (`estado='pagado'`) cuyo trámite no llegó a marcarse como pagado. Sale 0.

   Un pago **pendiente** no es un huérfano: es una solicitud que espera la confirmación de
   tesorería. La confirmación hace dos cosas (PATCH al trámite y acreditación del pago) y,
   si el proceso muere entre ambas, el reconciliador termina el trabajo con la intención
   registrada. Por eso el chequeo filtra por `estado='pagado'`.

7. **3.7 `/health`.** Responde 200 aunque los tres servicios estén caídos, porque no pasa
   por ningún upstream. Distingue "nginx cayó" de "los servicios cayeron", que es
   exactamente lo que un orquestador necesita para decidir.

**Cómo repetir cada fallo a mano:**

```bash
# Identidad de administrador: las rutas de trámites y pagos la exigen
IDENTIDAD=$(curl -s -X POST localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@municipalidad.gob","password":"Municipal123"}' \
  | jq -r '.data.identidad')

# Una sola réplica caída
docker compose stop tramites_2
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' \
  -H "X-Identidad: $IDENTIDAD" localhost:8080/api/v1/tramites
docker compose start tramites_2

# Servicio completo caído
docker compose stop tramites_1 tramites_2
docker compose restart pagos_1 pagos_2
docker compose restart gateway
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' \
  -X POST localhost:8080/api/v1/pagos -H 'Content-Type: application/json' \
  -H "X-Identidad: $IDENTIDAD" \
  -d '{"id_tramite":"T1","usuario_id":"10000001","monto":1,"metodo_pago":"x","fecha_pago":"2026-01-15T10:00:00Z"}'

# Servicio congelado: acepta la conexión pero no responde
docker compose pause tramites_1 tramites_2
# ...
docker compose unpause tramites_1 tramites_2
```

> **Cuidado al esperar a que algo levante.** Si esperas consultando *a través del gateway*
> mientras la réplica reinicia, nginx ve un fallo y con `max_fails=1` la expulsa durante
> 10 s. Después el gateway devuelve 502 aunque la réplica ya esté de vuelta. Por eso el
> script espera contra el puerto de la réplica (`localhost:3337`) y no por el 8080.

---

## 3. Medir sin el script

El script no guarda histórico: cada ejecución empieza de cero. Para medir en cualquier
momento:

```bash
# Latencia de un endpoint, con el código y el tiempo
IDENTIDAD=$(curl -s -X POST localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@municipalidad.gob","password":"Municipal123"}' \
  | jq -r '.data.identidad')
for i in $(seq 1 20); do
  curl -s -o /dev/null -w '%{http_code} %{time_total}\n' \
    -H "X-Identidad: $IDENTIDAD" http://localhost:8080/api/v1/tramites
done | sort -k2 -g | tail -3      # las 3 más lentas

# A qué réplica respondió el gateway, y cuánto tardó cada upstream
docker compose logs gateway | grep upstream= | tail -10

# Estado de los circuitos
curl -s localhost:8080/api/v1/circuitos/pagos | jq
curl -s localhost:8080/api/v1/circuitos/tramites | jq

# Relojes lógicos de las seis réplicas
for p in 3333 3334 3335 3336 3337 3338; do
  echo -n "$p: "; curl -s "localhost:$p/api/v1/reloj"; echo
done
```

El log del gateway incluye `upstream=`, `upstream_status=` y los tiempos, porque el log
por defecto de nginx no dice a qué réplica respondió:

```
172.28.0.1 "GET /api/v1/tramites HTTP/1.1" 200
  upstream=172.28.0.14:3333 upstream_status=200 upstream_time=0.021 total_time=0.022
```

Con eso se ve el reparto real: `172.28.0.13` y `172.28.0.14` son `tramites_1` y
`tramites_2`.

---

## 4. Guion de la presentación (5 minutos)

1. **Qué es.** Tres microservicios independientes con dos réplicas cada uno, un PostgreSQL
   con tres bases separadas, y nginx como gateway único. Toda llamada entre servicios pasa
   por el gateway, nunca directa de un servicio a otro. (`./scripts/demostracion.sh resumen`)

2. **Comunicación real** (etapa 1). Crear un trámite con un usuario que no existe. Para
   explicar que no es confianza en el cliente: apago `usuarios` y muestro que tampoco crea
   nada, aunque el usuario sí exista en la base.

3. **Relojes lógicos** (etapa 2). Los 8 trámites en paralelo y, sobre todo, el empate
   garantizado del paso 2.5: dos `PATCH` a la vez, uno por réplica, con el mismo sello
   externo. Lo importante es señalar los pares con el mismo `lamport` en réplicas distintas:
   son concurrentes, y el reloj dice correctamente que no puede ordenarlos.

4. **Tolerancia a fallos** (etapa 3). La tabla de tiempos. El momento fuerte es ver cómo
   las peticiones pasan de 2 s a 20 ms en la misma salida, y ver el circuito abrirse. Luego
   el servicio congelado, que es el caso que de verdad rompe a los clientes.

5. **Lo que falta, en voz alta.** Decirlo suma credibilidad:
   - La confirmación no es transaccional: si `pagos` muere entre marcar el trámite y
     acreditar el pago, el reconciliador lo termina después. El pago queda pendiente
     mientras tanto.
   - La identidad se firma con un secreto compartido: no hay rotación de claves ni
     revocación individual antes de que caduque el token.
   - Las pruebas Japa cubren auth y lógica pura, pero no el flujo de pago completo.
   - Los `Dockerfile` ya compilan con `node ace build`; no hay orquestador (Kubernetes).

---

## 5. Si algo falla durante la presentación

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `no live upstreams` en el log de nginx | Se reinició un servicio esperándolo por el gateway, y nginx lo expulsó | `docker compose restart gateway` |
| El gateway no arranca: `host not found in upstream` | Ya no debería pasar: los upstreams usan IP fijas | Revisar que las IP de `nginx.conf` coincidan con las de `docker-compose.yml` |
| `jq: command not found` | Falta la dependencia | `sudo apt install jq` |
| Todo devuelve 502 tras un rato | Alguna réplica quedó expulsada | `docker compose restart gateway` |
| Un puerto ocupado (3306, 8080) | Otro programa lo usa | `ss -tlnp \| grep 8080` |

Restablecer a un estado limpio:

```bash
docker compose unpause tramites_1 tramites_2 usuarios_1 usuarios_2 pagos_1 pagos_2
docker compose up -d
docker compose restart gateway
```

Y para empezar de cero, borrando la base de datos:

```bash
docker compose down -v
docker compose up -d --build
```