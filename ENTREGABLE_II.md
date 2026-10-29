# Entregable II — Servicio de nombres, sincronización, consistencia y tolerancia a fallos

**Proyecto:** Municipalidad — plataforma distribuida de trámites  
**Documento:** Informe técnico del Entregable II  
**Versión:** 1.0  
**Fecha:** Octubre de 2026  
**Integrante(s):** _Completar_  
**Repositorio:** `municipalidad`

---

## Índice

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Alcance, método y evidencia](#2-alcance-método-y-evidencia)
3. [Arquitectura y servicio de nombres](#3-arquitectura-y-servicio-de-nombres)
4. [Sincronización](#4-sincronización)
5. [Modelo de consistencia](#5-modelo-de-consistencia)
6. [Réplicas y escalabilidad](#6-réplicas-y-escalabilidad)
7. [Tolerancia a fallos](#7-tolerancia-a-fallos)
8. [Escenarios de falla](#8-escenarios-de-falla)
9. [Recuperación](#9-recuperación)
10. [Pruebas](#10-pruebas)
11. [Métricas](#11-métricas)
12. [Análisis de resultados](#12-análisis-de-resultados)
13. [Limitaciones y trabajo futuro](#13-limitaciones-y-trabajo-futuro)
14. [Conclusiones](#14-conclusiones)
15. [Anexo A — Guía de capturas](#anexo-a--guía-de-capturas)
16. [Anexo B — Comandos de reproducción](#anexo-b--comandos-de-reproducción)
17. [Referencias](#referencias)

---

## 1. Resumen ejecutivo

El proyecto implementa una plataforma distribuida de trámites municipales con tres
microservicios —`usuarios`, `tramites` y `pagos`—, dos réplicas por servicio, un gateway
Nginx y un PostgreSQL con tres bases separadas. La comunicación entre servicios pasa
siempre por el gateway; no hay llamadas directas entre microservicios.

La solución cubre los mecanismos centrales de un sistema distribuido académico:
resolución de nombres y direccionamiento estático, orden causal con relojes de Lamport,
consistencia local fuerte con convergencia entre servicios, replicación de procesos sin
estado, failover de gateway, timeouts y reintentos acotados, circuit breaker, saga con
registro de intenciones, idempotencia y una cola offline en el navegador.

La cobertura de los diez puntos solicitados es la siguiente:

| # | Punto | Estado | Evidencia principal |
|---|---|---|---|
| 1 | Servicio de nombres | **Parcial** | DNS embebido de Docker y direccionamiento estático. No hay registro dinámico dedicado. |
| 2 | Sincronización | **Parcial** | Lamport, control de concurrencia, idempotencia y saga. No hay replicación de estado entre réplicas. |
| 3 | Consistencia | **Cubierto** | ACID local por servicio; consistencia eventual entre servicios; no hay ACID distribuido. |
| 4 | Réplicas | **Parcial** | Dos réplicas stateless por servicio; PostgreSQL y gateway son puntos únicos de fallo. |
| 5 | Tolerancia a fallos | **Cubierto con brechas** | Failover, timeout, circuit breaker, saga y cola offline; no hay reinicio automático. |
| 6 | Escenarios de falla | **Cubierto parcial** | Réplica caída, servicio caído, servicio congelado, base caída, saga interrumpida, revocación y offline. |
| 7 | Recuperación | **Cubierto** | Saga, reconciliador, backup lógico y PITR; la recuperación de PostgreSQL es manual. |
| 8 | Pruebas | **Cubierto** | 44 pruebas Japa, 18 de integración, 76 de sistema y demostraciones de fallos. |
| 9 | Métricas | **Parcial** | Latencia, tasa de fallo, circuitos, relojes y logs; métricas en memoria, sin Prometheus/OTel. |
| 10 | Análisis de resultados | **Cubierto** | Tablas p50/p95/máx, comparación línea base vs. fallos y análisis de limitaciones. |

**Conclusión anticipada:** el proyecto demuestra correctamente los conceptos y cuenta con
evidencia reproducible. No debe presentarse como una solución de alta disponibilidad de
producción: el gateway y PostgreSQL son puntos únicos de fallo, no hay replicación de la
base, las réplicas no se reinician automáticamente y la observabilidad no es persistente.
El informe declara esas brechas de forma explícita.

---

## 2. Alcance, método y evidencia

### 2.1 Alcance

El análisis cubre los diez puntos del Entregable II: servicio de nombres, sincronización,
consistencia, réplicas, tolerancia a fallos, escenarios de falla, recuperación, pruebas,
métricas y análisis de resultados. Quedan fuera del alcance la operación en producción, la
seguridad perimetral, la gestión de secretos productivos, Kubernetes y la replicación
geográfica.

### 2.2 Método

Se revisaron la documentación, los scripts y el código de los tres servicios y del gateway.
La evidencia cuantitativa proviene de:

- `EVIDENCIAS.txt`: salida de `./scripts/verificacion.sh` con **76/76 comprobaciones**.
- `./scripts/integracion_pagos.sh`: **18/18 comprobaciones** del flujo de pago.
- Pruebas Japa: **44 pruebas** (8 de usuarios, 29 de trámites y 7 de pagos).
- `DEMOSTRACION.md`: corrida documentada con p50, p95 y máximo sobre muestras de 20 lecturas y 8/5 escrituras.
- `RECUPERACION.md`: evidencias de backup, PITR y saga.
- Observación directa del código y de la configuración de Nginx y Docker Compose.

### 2.3 Validez de los datos

Los valores de latencia son de una corrida académica con muestras de 20 lecturas y 8/5
escrituras, en un solo host y sin carga concurrente sostenida. No constituyen un SLA ni un benchmark de
producción. Se presentan como evidencia comparativa entre línea base y escenarios de falla.
Las credenciales sembradas son de desarrollo y no deben reutilizarse en un entorno real.

---

## 3. Arquitectura y servicio de nombres

### 3.1 Vista general

```
                      ┌──────────────┐
   cliente ─────────▶ │    gateway   │  nginx:alpine  (host :8080 → :80)
                      └──────┬───────┘
             ┌───────────────┼───────────────┐
             ▼               ▼               ▼
      ┌────────────┐  ┌────────────┐  ┌────────────┐
      │ usuarios_1 │  │ tramites_1 │  │  pagos_1   │   2 réplicas por servicio
      │ usuarios_2 │  │ tramites_2 │  │  pagos_2   │   round-robin en el gateway
      └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
            │               │               │
      ┌─────┴───────────────┴───────────────┴──────┐
      │                  postgres                   │   3 bases separadas:
      │        municipalidad / usuarios_db / pagos_db │   una por servicio
      └────────────────────────────────────────────┘
```

Regla arquitectónica: **toda llamada entre servicios pasa por el gateway**. Los servicios
usan `http://gateway` como URL base; no se llaman por IP directa entre sí. Esto centraliza
el enrutamiento, permite aplicar el mismo presupuesto de tiempo y hace observable el
failover en los logs.

### 3.2 Topología y direccionamiento

| Contenedor | IP | Puerto host | Puerto interno | Rol |
|---|---|---:|---:|---|
| `municipalidad_postgres` | 172.28.0.10 | — | 5432 | PostgreSQL 16 con tres bases |
| `usuarios_1` | 172.28.0.11 | 3335 | 3333 | Réplica de usuarios |
| `usuarios_2` | 172.28.0.12 | 3336 | 3333 | Réplica de usuarios |
| `tramites_1` | 172.28.0.13 | 3333 | 3333 | Réplica de trámites |
| `tramites_2` | 172.28.0.14 | 3334 | 3333 | Réplica de trámites |
| `pagos_1` | 172.28.0.15 | 3337 | 3333 | Réplica de pagos |
| `pagos_2` | 172.28.0.16 | 3338 | 3333 | Réplica de pagos |
| `municipalidad_gateway` | 172.28.0.20 | 8080 | 80 | Nginx, UI y API |

La red es un bridge `172.28.0.0/16` con IPAM estático. Los puertos de host de las réplicas
sirven para pruebas directas y para esperar el arranque sin pasar por el gateway.

### 3.3 ¿Qué se entiende por “servicio de nombres”?

El término admite dos interpretaciones:

1. **Resolución de nombres y direccionamiento:** traducir un nombre lógico a una dirección
   o a un conjunto de destinos.
2. **Descubrimiento dinámico:** un componente que registra instancias, detecta salud y
   actualiza el enrutamiento sin intervención manual.

El proyecto cubre la primera interpretación y **no implementa la segunda**. La distinción es
importante para no sobrevender el alcance.

### 3.4 Mecanismos de nombres implementados

| Nombre | Tipo | Resolución |
|---|---|---|
| `postgres` | Servicio de Compose | DNS embebido de Docker; es el `DB_HOST` de los tres servicios |
| `gateway` | Servicio de Compose | DNS embebido de Docker; es el host de `USUARIOS_SERVICE_URL` y `TRAMITES_SERVICE_URL` |
| `tramites_1`, `tramites_2`, etc. | Servicio y contenedor | Nombres de Compose; Nginx usa sus IP fijas en los `upstream` |
| `NODE_ID` | Nombre lógico de réplica | Variable de entorno; identifica al nodo en los sellos Lamport |
| `localhost:8080` / IP LAN | Nombre externo | Punto de entrada del gateway |
| URL `*.trycloudflare.com` | Nombre público temporal | Túnel HTTPS de demostración |

Los servicios se conectan a PostgreSQL mediante `DB_HOST=postgres`. Las llamadas entre
servicios usan `http://gateway`. Ambas resoluciones dependen del DNS interno de Docker.

Nginx, en cambio, **no usa los nombres de contenedor en sus `upstream`**. Usa las IP fijas
de la tabla anterior. La razón está documentada en `README.md` y en `gateway/nginx.conf`:
Nginx resuelve los `upstream` una sola vez al arrancar. Si una réplica está caída en ese
momento, con nombres puede abortar con `host not found in upstream`; si una réplica se
recrea y cambia de IP, Nginx seguiría apuntando a la IP antigua. Las IP fijas eliminan
esos dos problemas, a costa de requerir configuración manual.

### 3.5 Evaluación del punto

**Cubierto en el sentido de resolución y direccionamiento; parcial en el sentido de
descubrimiento dinámico.**

Fortalezas:

- Los nombres internos son estables y legibles.
- El direccionamiento es determinista y reproducible.
- `NODE_ID` separa la identidad lógica de la ubicación física.
- El gateway centraliza la topología y permite observar el destino real en los logs.

Limitaciones:

- No hay un registro de servicios dedicado (Consul, Eureka, CoreDNS, etc.).
- No hay registro automático de nuevas réplicas.
- No hay descubrimiento basado en salud: Nginx usa `max_fails` y `fail_timeout` como
  mecanismo pasivo, no un registro que reciba latidos.
- Añadir una réplica exige editar `docker-compose.yml`, asignarle IP y agregarla a
  `gateway/nginx.conf`.
- El gateway no re-resuelve nombres en caliente; las IP fijas son parte del contrato de
  despliegue.

**Redacción sugerida para el informe:**

> El sistema implementa un esquema de nombres estático y determinista sobre la red bridge de
> Docker. Los servicios se descubren por nombres de Compose para PostgreSQL y para el
> gateway, mientras que Nginx enruta hacia direcciones IP fijas para evitar los problemas de
> resolución en el arranque y la reasignación de direcciones. No se incorporó un servicio de
> descubrimiento dinámico; si el alcance lo exige, se reconoce como trabajo futuro.

> **Capturas sugeridas:** C01, C02, C03, C04 y C17. Ver [Anexo A](#anexo-a--guía-de-capturas).

---

## 4. Sincronización

### 4.1 Precisión conceptual

En este proyecto hay que separar tres cosas que suelen llamarse “sincronización”:

1. **Sincronización de estado entre réplicas:** no existe. Las réplicas son stateless y
   comparten la misma base de datos. No hay gossip, replicación de memoria ni consenso.
2. **Sincronización lógica y orden causal:** existe mediante relojes de Lamport y la
   cabecera `X-Lamport`.
3. **Sincronización de operaciones y escrituras:** existe mediante transacciones locales,
   control de concurrencia optimista, idempotencia y saga.

Por tanto, si el punto exige “replicación de estado”, la respuesta correcta es **no
cubierto**. Si exige “mecanismos de sincronización y orden en un sistema distribuido”, está
**cubierto parcialmente**, con las limitaciones que se describen abajo.

### 4.2 Relojes lógicos de Lamport

Cada réplica de `usuarios`, `tramites` y `pagos` mantiene su propio contador Lamport. El
contador vive en memoria y no se persiste entre reinicios; los eventos de negocio sí se
persisten con su sello.

Reglas implementadas:

- **L1:** todo evento local incrementa el contador.
- **L2:** al recibir un mensaje con sello `s`, el receptor hace `C := max(C, s) + 1`.
- El sello viaja en la cabecera `X-Lamport`.
- Cada réplica tiene su propio `NODE_ID`; si no se define, se usa el hostname.
- Los sellos se guardan en `tramites`, `tramites_eventos` y `pagos_intentos`.

La garantía es de **causalidad parcial**: si el sello de un evento es menor que el de otro,
el primero ocurrió antes. Si dos sellos son iguales en réplicas distintas, los eventos son
concurrentes y el reloj no puede ordenarlos. Eso no es un fallo: es la respuesta correcta
del modelo.

Limitaciones:

- No hay sincronización de relojes de pared ni NTP explícito; no se necesita para Lamport.
- Al reiniciar una réplica, su contador vuelve a cero y los sellos nuevos quedan por detrás
  de los antiguos. Los eventos ya persistidos conservan su sello; la comparación entre
  ejecuciones distintas no es significativa.
- El reloj no resuelve conflictos de escritura; para eso está la versión optimista.

### 4.3 Control de concurrencia optimista

La tabla `tramites` tiene una columna `version` que empieza en 1. Cada actualización exitosa
hace un `UPDATE ... WHERE id = ? AND version = ?` y sube la versión. Si la versión leída por
el cliente ya cambió, la respuesta es `409 Conflict` con la versión actual.

Esto evita la pérdida de actualizaciones: dos `PATCH` simultáneos sobre el mismo trámite
producen un `200` y un `409`, no dos `200` que se pisen. El reloj Lamport dice en qué orden
causal ocurrieron los eventos; la versión decide quién gana la escritura.

### 4.4 Idempotencia

La creación de trámites acepta una cabecera `Idempotency-Key` con el formato
`/^[A-Za-z0-9_-]{8,64}$/`. La base impone un unique sobre
`(usuario_id, clave_idempotencia)`.

Si se repite la misma clave:

- No se crea un duplicado.
- Se devuelve `200` con el trámite existente.
- Se agrega `Idempotent-Replay: true`.

Esto es clave para los reintentos de la cola offline y para cualquier cliente que no sepa
si el servidor recibió la solicitud antes de que se cortara la conexión.

### 4.5 Saga y sincronización entre servicios

La confirmación de un pago no es una transacción distribuida. El flujo es:

1. `pagos` registra una intención en `pagos_intentos` con estado `pendiente`.
2. `pagos` hace un `PATCH` a `tramites` para marcarlo como `pagado`.
3. `pagos` acredita el pago y marca la intención como `confirmado`.

Si el proceso muere entre los pasos, la intención queda registrada. El reconciliador:

- Corre al arrancar cada réplica y también por HTTP.
- Busca intenciones pendientes con antigüedad mayor a 5 segundos.
- Usa `FOR UPDATE SKIP LOCKED` para que dos réplicas no procesen la misma intención.
- Prefiere completar el trabajo antes que revertirlo.
- Deja la intención pendiente si `tramites` sigue caído.

La sincronización es, por tanto, **eventual y hacia adelante**: el sistema converge al estado
correcto sin fingir atomicidad.

### 4.6 Cola offline

La UI guarda en `localStorage` los trámites que no pudo enviar. La cola:

- Aplica solo a la creación de trámites; pagos y registro de cuenta siguen en línea.
- Se separa por usuario.
- Reintenta automáticamente cada 20 segundos mientras la pestaña está visible y hay sesión.
- Usa backoff de 5 segundos a 5 minutos.
- Pausa 60 segundos ante `401`.
- Conserva los últimos 20 envíos como historial.
- Reintenta con la misma `Idempotency-Key` para no duplicar.

Limitaciones:

- La cola vive en el navegador y en el origen actual; si se borran los datos del navegador o
  cambia la URL del túnel, se pierde.
- El administrador no ve los pendientes de otros equipos hasta que se sincronizan.
- Si el navegador se cierra justo después de que el servidor creó el trámite pero antes de
  recibir la respuesta, un reintento manual podría duplicar. Para cubrir ese caso haría
  falta un outbox persistido en el servidor.

### 4.7 Evaluación del punto

**Parcial.** Hay sincronización causal, control de concurrencia, idempotencia y
convergencia mediante saga, pero no hay replicación de estado entre réplicas ni consenso.
La redacción debe evitar frases como “las réplicas se sincronizan entre sí”: comparten la
base de datos y son stateless.

> **Capturas sugeridas:** C05, C06 y C20. Ver [Anexo A](#anexo-a--guía-de-capturas).

---

## 5. Modelo de consistencia

### 5.1 Consistencia por ámbito

| Ámbito | Modelo | Ventana | Evidencia |
|---|---|---|---|
| Dentro de un servicio | ACID local, consistencia fuerte, read-your-writes | Inmediata | Transacciones PostgreSQL y unique constraints |
| Entre servicios | Consistencia eventual mediante saga | ~5 s + arranque del servicio | `pagos_intentos`, reconciliador |
| Revocación de identidades | Consistencia eventual con caché local | Hasta `REVOCACION_TTL_MS` (5 s) | `revocaciones.ts` |
| Cola offline | Consistencia eventual e idempotente | Depende de la reconexión | `cola.js`, unique de idempotencia |
| Orden de eventos | Consistencia causal, no linealizable | — | Lamport y `tramites_eventos` |

### 5.2 Lo que sí garantiza

- **Atomicidad local:** cada operación dentro de una base es transaccional.
- **Unicidad:** claves de idempotencia y restricciones de base evitan duplicados.
- **Lectura de propias escrituras:** al compartir la misma base, cualquier réplica del mismo
  servicio ve lo recién escrito.
- **Convergencia de la saga:** una intención pendiente se completa o se deja pendiente para
  reintento; no se pierde el pago.
- **Revocación acotada:** una identidad revocada deja de aceptarse en un plazo máximo de 5
  segundos, sin consultar a `usuarios` en cada petición.
- **Orden causal:** los eventos guardados conservan `lamport` y `node_id`.

### 5.3 Lo que no garantiza

- **Atomicidad entre las tres bases:** no hay 2PC ni transacción distribuida.
- **Consistencia global fuerte:** no hay linealizabilidad entre servicios.
- **Serialización global:** dos operaciones en servicios distintos pueden intercalarse.
- **Exactamente una entrega:** hay efecto idempotente en la creación, no exactly-once en la
  red.
- **Revocación instantánea:** la caché de 5 segundos es una ventana de staleness.
- **Disponibilidad de la revocación si `usuarios` cae:** la caché conserva la última lista
  conocida (fail-open); la firma se sigue validando localmente. Es una decisión de
  disponibilidad con una ventana de riesgo acotada.

### 5.4 Decisión bajo fallo

La arquitectura no se declara formalmente AP ni CP. En la práctica:

- Si PostgreSQL no está disponible, el servicio responde `503` en lugar de devolver datos
  posiblemente inconsistentes. Prioriza no mentir sobre el estado.
- Si un servicio dependiente no está disponible, `pagos` puede dejar una intención pendiente
  y responder `503`; la saga converge después.
- Si la base de un servicio está sana pero otro servicio no, cada servicio mantiene su
  consistencia local.

### 5.5 Evaluación del punto

**Cubierto con alcance limitado.** La afirmación correcta es: consistencia fuerte local,
consistencia eventual entre servicios y orden causal; no hay consistencia global ni
transacciones distribuidas.

> **Capturas sugeridas:** C07 y C18. Ver [Anexo A](#anexo-a--guía-de-capturas).

---

## 6. Réplicas y escalabilidad

### 6.1 Réplicas implementadas

Hay dos réplicas por servicio:

| Servicio | Réplicas | Distribución |
|---|---|---|
| `usuarios` | `usuarios_1`, `usuarios_2` | Round-robin en Nginx |
| `tramites` | `tramites_1`, `tramites_2` | Round-robin en Nginx |
| `pagos` | `pagos_1`, `pagos_2` | Round-robin en Nginx |

Las réplicas son **stateless**: no guardan sesiones ni estado de negocio en memoria. El
estado persistente vive en PostgreSQL. Esto permite agregar una tercera réplica sin cambiar
el código ni el esquema, pero no sin cambiar la infraestructura.

### 6.2 Balanceo y failover

Nginx usa round-robin por defecto y configura:

- `max_fails=1`
- `fail_timeout=10s`
- `proxy_next_upstream error timeout http_502 http_503 http_504`
- `proxy_next_upstream_tries 2`

La primera petición que cae en una réplica muerta paga el timeout de conexión; después
Nginx la expulsa durante 10 segundos y las siguientes van a la réplica sana. Esto explica
el p95 alto con una réplica caída, aunque el código HTTP siga siendo `200`.

### 6.3 Puntos únicos de fallo

| Componente | ¿Réplica? | Consecuencia |
|---|---|---|
| Gateway Nginx | No | Si cae, no hay entrada a la API ni a la UI |
| PostgreSQL | No | Si cae, los tres servicios no pueden persistir |
| Red Docker / host | No | Si falla, todo el stack queda inaccesible |
| Contenedores de aplicación | Sí, 2 cada uno | Se tolera la caída de una réplica |

La tabla anterior es la razón por la que el sistema **no es de alta disponibilidad de
producción**. Es una demostración de tolerancia a fallos de procesos, no de infraestructura
completa.

### 6.4 Escalabilidad

Agregar una réplica requiere:

1. Duplicar el bloque del servicio en `docker-compose.yml`.
2. Asignar una IP fija y un puerto de host.
3. Definir `NODE_ID`.
4. Agregar la nueva IP a `gateway/nginx.conf`.
5. Reconstruir y levantar.

No se requiere cambio de código ni migración de esquema. La limitación es operativa: el
registro es manual.

### 6.5 Política de reinicio

Las réplicas no declaran una política `restart` en Docker Compose. Solo los contenedores de
un solo uso (`db_init`, migraciones) declaran `restart: "no"`. Por tanto, si un proceso de
aplicación muere, Docker no lo reinicia automáticamente. La recuperación depende de una
acción manual o de un orquestador externo.

### 6.6 Evaluación del punto

**Parcial.** Se cumple la replicación de procesos y el reparto de carga; no se cumple la
replicación de datos ni la alta disponibilidad del gateway o de PostgreSQL.

> **Capturas sugeridas:** C04, C08 y C19. Ver [Anexo A](#anexo-a--guía-de-capturas).

---

## 7. Tolerancia a fallos

### 7.1 Mecanismos implementados

| Mecanismo | Dónde | Qué resuelve |
|---|---|---|
| Timeout por llamada | `cliente_http.ts` | Evita bloqueos indefinidos |
| Reintentos con backoff | `cliente_http.ts` | Fallos transitorios y réplicas reiniciando |
| Reintentos adaptativos | `cliente_http.ts` | Deja de reintentar si la tasa de fallo es alta |
| Circuit breaker | `interruptor.ts` | Falla rápido cuando la dependencia está caída |
| Failover de gateway | `nginx.conf` | Expulsa réplicas que no responden |
| Saga | `pagos_controller.ts`, `reconciliador.ts` | Recupera pagos interrumpidos |
| Cola offline | `cola.js` | Conserva trámites cuando no hay red o servicio |
| Healthchecks | `docker-compose.yml` | Evita arrancar antes de PostgreSQL |
| Identidad local | `identidad.ts` | Evita depender de `usuarios` en cada petición |
| Revocación cacheada | `revocaciones.ts` | Invalida identidades sin llamada por petición |

### 7.2 Presupuesto de tiempo

El peor caso de una llamada entre servicios es:

```text
HTTP_TIMEOUT_MS × (HTTP_REINTENTOS + 1) + backoff
= 2000 ms × (1 + 1) + 100 ms
= 4100 ms
```

Nginx tiene `proxy_read_timeout 8s` y `proxy_connect_timeout 1s`. El margen evita que Nginx
agote su espera antes de que el servicio gestione el fallo. Si Nginx se adelantara, contaría
la respuesta como error del upstream y, con `max_fails=1`, expulsaría las dos réplicas a la
vez.

### 7.3 Circuit breaker

Estados:

- **Cerrado:** las llamadas pasan y los fallos se cuentan.
- **Abierto:** tras 3 fallos consecutivos, falla en milisegundos sin llamar a la dependencia.
  Se reabre a prueba después de 10 segundos.
- **En prueba:** pasa una sola llamada de comprobación. Si funciona, cierra; si falla, vuelve
  a abrir.

Cada réplica tiene su propio circuito. Con dos réplicas y umbral 3, hacen falta 6 peticiones
para que ambas dejen de golpear a un servicio caído. Esto es correcto: el circuito es estado
local del proceso, no un estado compartido.

### 7.4 Failover y códigos HTTP

Cuando `tramites` está completamente caído, el comportamiento depende de quién responda:

- Una petición directa del gateway a `tramites` puede devolver `504`, porque Nginx no
  encuentra un upstream sano.
- Una petición a `pagos` que depende de `tramites` puede devolver `503` desde `pagos`,
  porque el cliente HTTP interno agotó timeout o el circuito está abierto.
- `GET /health` sigue devolviendo `200`, porque no pasa por ningún upstream.

No es una inconsistencia: son capas distintas contestando. El informe debe explicarlo para
que un `504` y un `503` en la misma prueba no parezcan un error.

### 7.5 PostgreSQL caído

Los pools tienen:

- `connectionTimeoutMillis: 2000`
- `acquireTimeoutMillis: 4000`

El handler traduce errores de conexión a `503` con un mensaje explícito. La respuesta baja de
~8.4 segundos y un `500` opaco a ~0.3 segundos y un `503` comprensible. Esto evita que una
caída de base se convierta en una espera larga y en un error difícil de diagnosticar.

### 7.6 Lo que no resuelve

- No hay reinicio automático de las réplicas.
- No hay failover automático de PostgreSQL.
- No hay réplica del gateway.
- No hay presupuesto de tiempo para el gateway mismo; si cae, no hay entrada.
- No hay alertas ni dashboard persistente.
- El circuit breaker no distingue por código de error ni por tipo de fallo.
- La cola offline no cubre pagos ni creación de cuentas.

### 7.7 Evaluación del punto

**Cubierto con brechas.** Los mecanismos de aplicación están implementados y verificados;
la infraestructura no tiene alta disponibilidad completa.

> **Capturas sugeridas:** C09. Ver [Anexo A](#anexo-a--guía-de-capturas).

---

## 8. Escenarios de falla

### 8.1 Matriz de escenarios

| Escenario | Cómo se provoca | Resultado esperado | Evidencia |
|---|---|---|---|
| Una réplica de `tramites` caída | `docker compose stop tramites_2` | `200`; p95 ~1 s; el servicio sigue | `verificacion.sh` 1.2; demo 3.2 |
| Servicio `tramites` completo caído | `docker compose stop tramites_1 tramites_2` | `504` en GET directo; `503` en `POST /pagos`; health `200` | `verificacion.sh` 1.3; demo 3.3 |
| Servicio congelado | `docker compose pause tramites_1 tramites_2` | `503` desde `pagos`, no `502` de Nginx | demo 3.4 |
| PostgreSQL caído | `docker compose stop postgres` | `503` en ~0.3 s con mensaje explícito; health `200` | `verificacion.sh` 3.5; README §10 |
| Proceso muerto a mitad de saga | `PAGOS_FALLAR_ANTES_DE_PATCH=1` | Pago e intención pendientes; reconciliador completa | `recuperacion.sh saga` |
| Identidad revocada | Revocar `jti` y usarla | `401` en un plazo máximo de 5 s | `verificacion.sh` 2.11 |
| Cliente offline | Detener `tramites` y enviar desde la UI | Trámite en cola; luego se sincroniza sin duplicar | `verificacion.sh` 2.12; UI offline |
| Gateway caído | `docker compose stop gateway` | No hay API ni UI; no hay failover | No cubierto; SPOF |
| Partición de red real | `iptables`/`tc`/network partition | No evaluado | No cubierto |
| PostgreSQL sin disponibilidad | Caída prolongada o corrupción | Recuperación manual con backup/PITR | `RECUPERACION.md`; no hay standby |

### 8.2 Detalle de los escenarios cubiertos

**Réplica caída.** Nginx reparte entre dos réplicas. La primera petición que cae en la
réplica muerta espera el timeout de conexión; después la expulsa. El servicio sigue
disponible con `200`, pero el p95 sube. Es un failover con costo de latencia, no una
recuperación instantánea.

**Servicio completo caído.** Si se consulta `tramites` directamente por el gateway, Nginx
puede devolver `504`. Si se consulta `pagos`, este devuelve `503` tras agotar su presupuesto
interno. En ambos casos `health` sigue en `200`, lo que permite distinguir “Nginx vivo” de
“servicios caídos”. El circuito se abre después de 3 fallos por réplica; con dos réplicas,
tras 6 peticiones.

**Servicio congelado.** `pause` es peor que `stop`: la conexión se acepta pero no se
responde. El cliente interno agota timeout y `pagos` devuelve `503`. Que no sea `502` de
Nginx demuestra que el presupuesto de tiempo está bien configurado.

**PostgreSQL caído.** El pool falla rápido y el handler devuelve `503` con mensaje. Los
datos no se pierden; cuando PostgreSQL vuelve, los servicios se recuperan. La prueba
verifica que la respuesta sea menor a 3 segundos y que el gateway siga vivo.

**Saga interrumpida.** El proceso de `pagos` muere después de guardar el pago y antes del
`PATCH`. El pago queda pendiente, el trámite sigue pendiente y la intención queda
registrada. Al reiniciar, el reconciliador completa el trabajo. La recuperación es hacia
adelante: no se borra el pago.

**Identidad revocada.** La lista de `jti` revocados se cachea 5 segundos. Una identidad
revocada se rechaza con `401` como máximo tras ese TTL. Si `usuarios` no responde, se
conserva la última lista; la firma se valida localmente.

**Cliente offline.** La UI encola el trámite con una clave de idempotencia. Al volver el
servicio, el reintento devuelve `200` con `Idempotent-Replay` si ya existía, o `201` si es
nuevo. El trámite conserva `creado_cliente_en` y `origen='offline'`.

### 8.3 Escenarios no cubiertos

- Caída del gateway: no hay réplica ni VIP; es un punto único.
- Caída del host o de la red Docker: no hay redundancia.
- Partición de red entre servicios: no hay quórum ni consenso; no se probó.
- Failover automático de PostgreSQL: no hay streaming replication ni Patroni.
- Carga sostenida: las pruebas son de 20 lecturas y 5-8 escrituras, no un soak test.
- Corrupción de datos o pérdida del volumen: se mitiga con backup/PITR manual.

> **Capturas sugeridas:** C08, C09 y C10. Ver [Anexo A](#anexo-a--guía-de-capturas).

---

## 9. Recuperación

### 9.1 Recuperación automática y manual

| Tipo | Mecanismo | Alcance | Automático |
|---|---|---|---|
| Failover de réplica | Nginx `max_fails`/`fail_timeout` | Réplica de aplicación | Sí, pasivo |
| Reintentos | Cliente HTTP con backoff | Fallos transitorios | Sí |
| Circuit breaker | Apertura y prueba | Dependencia caída | Sí, local |
| Saga | Reconciliador | Pago interrumpido | Al arrancar o por HTTP |
| Cola offline | Reintento desde la UI | Trámite no enviado | Sí, mientras la pestaña esté abierta |
| Reinicio de réplica | Acción manual | Proceso muerto | No |
| PostgreSQL | Reinicio manual | Base caída | No |
| Backup/PITR | `pg_dump`/`pg_restore`, WAL | Pérdida de datos | Manual |
| Failover de base | No implementado | Alta disponibilidad de datos | No |

### 9.2 Saga con registro de recuperación

```
POST /pagos/:id/confirmar
        │
        ▼
INSERT pagos_intentos (estado='pendiente')
        │
        ▼
PATCH a tramites
        │
   ┌────┴─────────────────────┐
   ▼                          ▼
ok                     fallo / proceso muere
   │                          │
   ▼                          ▼
trámite='pagado'        queda 'pendiente'
pago='pagado'                 │
intención='confirmado'        ▼
                       reconciliador
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
        completa el PATCH          no se creó el pago
        pago='pagado'              intención='revertido'
        trámite='pagado'
        intención='confirmado'
```

Puntos clave:

- La información de recuperación vive en una tabla, no en variables de pila.
- El reconciliador corre al arrancar cada réplica y por HTTP.
- `FOR UPDATE SKIP LOCKED` permite que dos réplicas trabajen sin bloquearse.
- Se prefiere completar antes que revertir: borrar un pago sin poder confirmar dejaría al
  usuario pagando por nada.
- La ventana visible es de unos 5 segundos más el arranque del servicio.
- No hay límite de reintentos ni alerta si una intención queda pendiente mucho tiempo.

### 9.3 Backup lógico

`./scripts/recuperacion.sh demo-backup`:

1. Crea datos de prueba.
2. Ejecuta `pg_dump -Fc` de las tres bases.
3. Borra los datos.
4. Restaura el primario.
5. Verifica que los datos volvieron.

Es recuperación ante pérdida de datos, no alta disponibilidad. El respaldo se puede restaurar
en una instancia aparte (`./scripts/recuperacion.sh restaurar`) y comparar con la original.

### 9.4 PITR

El proyecto tiene `archive_mode=on`, `wal_level=replica` y archivado de WAL en un volumen.
La secuencia de PITR:

1. Se anota un instante con milisegundos.
2. Se crea una tabla de “desastre” después de ese instante.
3. Se prepara un base backup.
4. Se arranca una instancia de recuperación con
   `recovery_target_time=<instante>`, `recovery_target_inclusive=off` y
   `recovery_target_action=promote`.
5. El log de PostgreSQL indica dónde se detuvo y la nueva línea de tiempo.
6. La tabla del desastre no existe en la copia; los datos anteriores sí.

Esto demuestra **recuperación a un instante exacto**, no solo restauración del último
backup. La instancia recuperada es separada y el cambio a ella es manual.

### 9.5 Recuperación de la cola offline

La cola se recupera cuando el servicio vuelve:

- Reintenta cada 20 segundos.
- Usa backoff ante fallos.
- Reintenta con la misma clave de idempotencia.
- Conserva el historial de los últimos 20 envíos.
- Si el navegador se cierra, la cola sigue en `localStorage` mientras no se borre.

Limitación: si el navegador se cierra justo después de que el servidor creó el trámite pero
antes de recibir la respuesta, el reintento manual puede duplicar. Para cubrirlo haría falta
un outbox persistido en el servidor.

### 9.6 Evaluación del punto

**Cubierto.** Hay recuperación automática de procesos y de operaciones, y recuperación
manual de datos con backup/PITR. Lo que no hay es alta disponibilidad automática de
PostgreSQL ni del gateway.

> **Capturas sugeridas:** C12 y C13. Ver [Anexo A](#anexo-a--guía-de-capturas).

---

## 10. Pruebas

### 10.1 Tipos y resultados

| Tipo | Comando | Cantidad | Resultado | Qué cubre |
|---|---|---:|---|---|
| Japa usuarios | `cd usuarios && node ace test` | 8 | 8/8 | Registro, login, perfil y permisos |
| Japa trámites | `cd tramites && node ace test` | 29 | 29/29 | Estados, Lamport, identidad, interruptor, cliente HTTP |
| Japa pagos | `cd pagos && node ace test` | 7 | 7/7 | Cliente HTTP e identidad |
| Integración de pagos | `./scripts/integracion_pagos.sh` | 18 | 18/18 | Flujo completo solicitud/confirmación, permisos, saga |
| Verificación de sistema | `./scripts/verificacion.sh` | 76 | 76/76 | Fallos, consistencia, recuperación y UI |
| Demostración de fallos | `./scripts/demostracion.sh fallos` | 3 etapas | OK | p50/p95/máx, circuitos, pagos huérfanos |
| Recuperación | `./scripts/recuperacion.sh` | 3 demos | OK | Backup, PITR y saga |
| UI y offline | Manual en navegador | — | Verificado | Login, roles, cola, sincronización |

La salida consolidada de la verificación está en `EVIDENCIAS.txt`. El resumen es:

```text
Comprobaciones: 76
Superadas:      76
Fallidas:       0
LOS TRES PUNTOS DEL INFORME QUEDAN VERIFICADOS.
```

### 10.2 Cobertura de pruebas

**Pruebas unitarias.** No requieren Docker. Usan SQLite en usuarios y lógica pura en trámites
y pagos. Cubren transiciones de estado, Lamport, firma/rotación/revocación de identidad,
apertura/cierre del circuito, métricas, reintentos adaptativos e idempotencia básica.

**Integración.** Ejercita los tres servicios reales a través del gateway. Registra un
ciudadano, crea un trámite, solicita el pago, verifica que el ciudadano no puede confirmar
ni pagar un trámite ajeno, confirma con tesorería, comprueba coherencia y verifica que
reconfirmar es idempotente. Limpia sus propios datos.

**Sistema.** `verificacion.sh` apaga y levanta contenedores, pero no borra datos. Verifica
fallos, consistencia, recuperación, UI, revocación y cola offline. Es la evidencia principal
para los tres puntos clásicos del informe.

**Demostración.** Mide latencias reales y calcula p50, p95 y máximo. También muestra la
transición del circuito y cuenta pagos huérfanos.

**Recuperación.** `recuperacion.sh saga` inyecta una muerte real del proceso; `demo-backup`
prueba pérdida y restauración; `pitr-*` prueba recuperación a un instante.

### 10.3 Brechas de prueba

- No hay CI que ejecute las pruebas en cada cambio.
- No hay pruebas E2E de navegador automatizadas; la cola offline se verificó manualmente.
- No hay prueba de carga sostenida ni de soak.
- No hay prueba de partición de red real.
- No hay prueba de failover automático de PostgreSQL.
- No hay medición formal de cobertura de código.
- Las pruebas de rendimiento usan 20 lecturas y 8/5 escrituras, no un benchmark.

### 10.4 Evaluación del punto

**Cubierto.** La cantidad y variedad de pruebas es adecuada para el alcance académico. Las
brechas están identificadas y no se ocultan.

> **Capturas sugeridas:** C14, C15 y C16. Ver [Anexo A](#anexo-a--guía-de-capturas).

---

## 11. Métricas

### 11.1 Métricas disponibles

| Métrica | Fuente | Unidad | Alcance |
|---|---|---|---|
| Estado del circuito | `GET /api/v1/circuitos/{tramites,pagos}` | `cerrado`/`abierto`/`enPrueba` | Por réplica y dependencia |
| Fallos consecutivos | Idem | Conteo | Por réplica y dependencia |
| Umbral y tiempo de reapertura | Idem | Conteo / ms | Por proceso |
| Llamadas, éxitos, fallos | `cliente_http.ts` | Conteo | Desde el arranque de la réplica |
| Reintentos | `cliente_http.ts` | Conteo | Desde el arranque |
| Tasa de fallo | `cliente_http.ts` | Proporción | Desde el arranque |
| Latencia promedio | `cliente_http.ts` | ms | Desde el arranque |
| Reloj Lamport | `GET /api/v1/reloj` | Contador | Por réplica |
| Upstream y tiempos | Log de Nginx | IP, ms | Por petición |
| p50/p95/máx | `demostracion.sh` | ms | 20 lecturas; 8/5 escrituras |
| Intenciones pendientes | `pagos_intentos` | Conteo | Saga |
| Pagos huérfanos | Demo 3.6 | Conteo | Consistencia entre bases |

### 11.2 Valores documentados

La siguiente tabla reproduce la corrida documentada en `DEMOSTRACION.md`. Los valores pueden
variar entre ejecuciones; se usan para comparar escenarios, no como SLA.

| Escenario | Código | p50 (ms) | p95 (ms) | Máx (ms) | Lectura |
|---|---|---:|---:|---:|---|
| 20 × `GET /api/v1/tramites` | 200 | 26.5 | 39.5 | 45.1 | Línea base |
| 20 × `GET /tramites` con una réplica caída | 200 | 25.4 | 1021.0 | 1030.2 | Failover con costo de latencia |
| 8 × `POST /pagos` con `tramites` caído | 503 | 136.4 | 2082.6 | 2082.6 | Timeout inicial; luego circuito |
| 5 × `POST /pagos` con `tramites` congelado | 503 | 143.2 | 2071.3 | 2071.3 | Peor que `stop` |
| `GET /api/v1/tramites` con PostgreSQL caído | 503 | — | — | ~300 | Falla rápida y explícita |
| `GET /health` con servicios caídos | 200 | — | — | — | Gateway vivo |

### 11.3 Interpretación

- **p50** representa el caso normal; se mantiene bajo incluso con una réplica caída.
- **p95** expone la cola de latencia: la primera petición que cae en la réplica muerta paga
  el timeout de conexión.
- **Máx** coincide con el peor caso de failover.
- **Circuito abierto:** después de 3 fallos por réplica, las llamadas fallan en ~20 ms sin
  tocar la dependencia. Con dos réplicas, la transición completa requiere 6 peticiones.
- **Base caída:** el `503` en ~0.3 s demuestra que el pool y el handler están configurados
  para fallar rápido.
- **Pagos huérfanos:** la demostración reporta 0. Un pago pendiente no es huérfano; es una
  solicitud que espera confirmación.

### 11.4 Limitaciones de las métricas

- Son acumuladas en memoria y se pierden al reiniciar.
- No se comparten entre réplicas.
- No hay serie histórica ni dashboards.
- No hay Prometheus, OpenTelemetry ni trazas distribuidas (RNF-23 y RNF-24 pendientes).
- La latencia promedio no reemplaza percentiles; los percentiles vienen de la demo, no de un
  sistema de monitoreo.
- No hay alertas por circuitos abiertos, intenciones pendientes o errores 5xx.

### 11.5 Evaluación del punto

**Parcial.** Hay métricas útiles y evidencia de latencia, pero no un sistema de observabilidad
de producción. La redacción debe decir “observabilidad acotada”, no “monitoreo completo”.

> **Capturas sugeridas:** C11 y C21. Ver [Anexo A](#anexo-a--guía-de-capturas).

---

## 12. Análisis de resultados

### 12.1 Comparación línea base vs. fallos

| Escenario | Antes | Ahora | Conclusión |
|---|---|---|---|
| Una réplica de `tramites` caída | Hasta 3.03 s | 200; p95 ~1 s | El failover funciona; el costo es latencia |
| `tramites` completo caído | 504 en 6 s | 503 en ~2 s y luego ~20 ms | El circuito reduce el daño |
| `tramites` congelado | 504 en 20 s | 503 en ~2 s y luego ~20 ms | El presupuesto de tiempo evita el bloqueo largo |
| PostgreSQL caído | 500 en 8.4 s | 503 en ~0.3 s | Falla rápida y comprensible |
| `GET /health` con todo caído | 200 | 200 | Distingue gateway de servicios |

### 12.2 Lectura de los resultados

1. **El failover de Nginx funciona, pero no es gratis.** La disponibilidad se mantiene con
   `200`, pero el p95 sube a ~1 s porque la primera petición a la réplica muerta espera el
   timeout de conexión. Es un intercambio clásico entre disponibilidad y latencia.

2. **El circuit breaker cambia el régimen de fallo.** Las primeras peticiones pagan el
   timeout; después de abrirse, fallan en milisegundos. El sistema deja de amplificar la
   caída y protege al servicio llamador.

3. **Congelar es peor que detener.** Con `stop` la conexión se rechaza; con `pause` se acepta
   y no responde. El `503` de `pagos` ante un `tramites` congelado demuestra que el
   presupuesto de tiempo está bien calibrado; un `502` de Nginx habría indicado lo contrario.

4. **La base de datos también tiene presupuesto.** El `503` rápido evita que una caída de
   PostgreSQL se convierta en una espera de 8 segundos y en un `500` con traza.

5. **La salud del gateway está separada de la salud de los servicios.** `health` responde
   `200` aunque los tres servicios estén caídos. Eso permite a un orquestador distinguir
   “Nginx vivo” de “servicios caídos”.

6. **La saga evita pagos huérfanos.** La confirmación deja una intención; si el proceso
   muere, el reconciliador completa el trabajo. La demo reporta 0 pagos huérfanos.

7. **La cola offline evita pérdida de trabajo del usuario.** El trámite se conserva en el
   navegador y se sincroniza con idempotencia. El costo es que la cola es local al navegador
   y al origen.

### 12.3 Cumplimiento de requisitos

| Requisito | Resultado |
|---|---|
| RNF-01: p95 < 300 ms en carga normal | Se cumple en línea base (p95 39.5 ms). No se cumple bajo failover, donde el p95 sube a ~1 s; se reporta como costo del escenario. |
| RNF-02: agregar réplica sin cambios de código | Se cumple, pero requiere cambios de Compose y Nginx. |
| RNF-03: API stateless | Se cumple; el estado vive en PostgreSQL. |
| RNF-04: enrutar a réplica sana | Se cumple con `max_fails`/`fail_timeout`. |
| RNF-05: operar con una réplica caída | Se cumple; `200` y p95 ~1 s. |
| RNF-23/24: trazas y métricas | Pendientes; no hay OpenTelemetry ni Prometheus. |
| RNF-29/30/31: revocación, idempotencia y túnel | Implementados y verificados. |

### 12.4 Amenazas a la validez

- **Muestra pequeña:** 20 lecturas y 8/5 escrituras por escenario.
- **Un solo host:** no representa latencia de red real entre máquinas.
- **Sin carga concurrente sostenida:** no hay prueba de estrés ni de agotamiento de pools.
- **Sin particiones de red:** no se probó una red dividida ni pérdida de paquetes.
- **Sin fallo de gateway:** no hay evidencia de continuidad si cae Nginx.
- **Sin failover de PostgreSQL:** la base es un punto único.
- **Métricas en memoria:** no hay histórico ni agregación entre réplicas.
- **Datos de demostración:** los valores dependen del estado de la base y del host.

### 12.5 Conclusión del análisis

El proyecto cumple los objetivos académicos de un sistema distribuido: separa servicios,
replica procesos, ordena eventos, tolera fallos de aplicación, recupera operaciones
interrumpidas y ofrece evidencia reproducible. La arquitectura es coherente con las
decisiones que documenta: IP fija para estabilidad, gateway único para centralizar, saga en
lugar de 2PC, idempotencia en lugar de exactly-once y circuit breaker para no amplificar
caídas.

No es una arquitectura de alta disponibilidad de producción. Las brechas principales son los
puntos únicos de fallo (gateway y PostgreSQL), la ausencia de reinicio automático, la falta
de replicación de base y la observabilidad no persistente. Declararlas no debilita el
informe: demuestra criterio de ingeniería.

> **Capturas sugeridas:** C11. Ver [Anexo A](#anexo-a--guía-de-capturas).

---

## 13. Limitaciones y trabajo futuro

### 13.1 Limitaciones actuales

| Área | Limitación | Impacto |
|---|---|---|
| Nombres | Sin registro dinámico ni descubrimiento por salud | Agregar réplicas es manual |
| Sincronización | Sin replicación de estado ni consenso | No hay consistencia global fuerte |
| Base de datos | PostgreSQL único, sin standby | Punto único de fallo |
| Gateway | Nginx único | Punto único de fallo |
| Reinicio | Sin `restart` policy en réplicas | Un proceso muerto no vuelve solo |
| Saga | Reconciliador al arrancar o por HTTP | La recuperación puede tardar |
| Saga | Sin límite de reintentos ni alertas | Intenciones pueden quedar pendientes |
| Observabilidad | Métricas en memoria, sin Prometheus/OTel | No hay histórico ni dashboards |
| Pruebas | Sin CI, sin E2E de navegador automatizado | Regresiones pueden pasar |
| Carga | Sin pruebas de estrés/soak | No se conoce el límite operativo |
| Red | Sin pruebas de partición | No se evaluó el comportamiento bajo split-brain |

### 13.2 Trabajo futuro sugerido

1. **Servicio de nombres dinámico:** integrar Consul o CoreDNS con chequeos de salud y
   actualización automática de upstreams, o usar un service mesh.
2. **Alta disponibilidad de PostgreSQL:** streaming replication con Patroni o una solución
   equivalente, con promoción automática y respaldo continuo.
3. **Alta disponibilidad del gateway:** dos instancias de Nginx detrás de un VIP o un
   balanceador externo.
4. **Reinicio automático:** `restart: unless-stopped` en las réplicas y políticas de
   recuperación en el orquestador.
5. **Observabilidad:** Prometheus, OpenTelemetry, trazas distribuidas y dashboards con
   alertas por circuitos abiertos, 5xx e intenciones pendientes.
6. **Outbox en servidor:** persistir la cola offline para cubrir el cierre del navegador
   después del commit y antes de la respuesta.
7. **Pruebas:** CI, E2E de navegador, pruebas de carga, caos y particiones de red.
8. **Saga:** tarea programada, límite de reintentos, backoff y alertas.
9. **Seguridad:** rotación automatizada de secretos y revocación con menor TTL si el riesgo
   lo exige.
10. **Escalabilidad:** registro automático de réplicas y presupuesto de conexiones a la base.

---

## 14. Conclusiones

1. **La arquitectura es adecuada para el objetivo académico.** Tres servicios con bases
   separadas, réplicas stateless, gateway y PostgreSQL permiten demostrar conceptos de
   sistemas distribuidos con evidencia real.

2. **Los mecanismos de tolerancia están bien elegidos.** Timeouts, reintentos acotados,
   circuit breaker, failover pasivo, saga e idempotencia atacan problemas distintos y se
   complementan.

3. **La consistencia está bien delimitada.** No se afirma atomicidad global; se explica la
   consistencia local, la convergencia eventual y la ventana de la saga.

4. **La recuperación es verificable.** Backup, PITR y saga tienen demostraciones concretas,
   no solo diagramas.

5. **La deuda principal es de infraestructura.** Gateway y PostgreSQL únicos, ausencia de
   reinicio automático, falta de replicación de base y observabilidad no persistente impiden
   llamarlo “alta disponibilidad de producción”.

6. **La redacción debe ser honesta.** Si la consigna exige un servicio de nombres dinámico o
   replicación de estado, el proyecto está parcialmente cubierto. Declararlo con precisión
   vale más que sobrevenderlo.

---

## Anexo A — Guía de capturas

Las capturas todavía no están incorporadas al documento. Esta guía indica qué generar, con
qué comando o acción, qué debe verse y dónde insertarla. Guardar los archivos en
`capturas/` con el nombre sugerido.

### A.1 Preparación

Antes de capturar, verificar que el stack esté completo:

```bash
docker compose up -d --build
docker compose ps
```

Deben verse **8 contenedores en ejecución**: PostgreSQL, gateway y las 6 réplicas. Los
contenedores de un solo uso (`db_init` y los tres `*_migrate`) quedan `Exited (0)`. Si falta
alguna réplica, no tomar capturas que afirmen “dos réplicas por servicio”: primero
levantarla.

Para una base limpia (destructivo, borra datos y respaldos del volumen):

```bash
docker compose down -v
docker compose up -d --build
```

No usar `down -v` si se quieren conservar los datos de demostración.

### A.2 Variables de sesión

Definir las credenciales de desarrollo indicadas en `README.md` §2. No hace falta escribir
las contraseñas en el informe.

```bash
BASE=http://localhost:8080
# Completar con la cuenta sembrada de desarrollo:
ADMIN_EMAIL=...
ADMIN_PASSWORD=...

LOGIN=$(curl -s -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
IDENTIDAD=$(printf '%s' "$LOGIN" | jq -r '.data.identidad')
ADMIN_ID=$(printf '%s' "$LOGIN" | jq -r '.data.user.id')
```

### A.3 Capturas de terminal

| ID | Prioridad | Sección | Cómo generarla | Qué debe verse | Archivo sugerido |
|---|---|---|---|---|---|
| C01 | Obligatoria | §3 | `docker compose ps` | 8 contenedores activos; 6 réplicas, gateway y PostgreSQL; one-shots `Exited (0)` | `C01_stack.png` |
| C02 | Obligatoria | §3 | `docker network inspect municipalidad_municipalidad --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}'` | Nombres e IP fijas de la tabla | `C02_ips.png` |
| C03 | Obligatoria | §3 | `docker compose exec -T tramites_1 node -e "const d=require('node:dns'); for(const h of ['postgres','gateway']) d.lookup(h,(e,a)=>console.log(h,'->',e?e.code:a))"` | `postgres` y `gateway` resueltos por Docker DNS | `C03_dns.png` |
| C04 | Obligatoria | §3, §6 | `sed -n '1,30p' gateway/nginx.conf` y `docker compose logs --no-log-prefix --tail 20 gateway \| grep upstream=` | Upstreams con IP fija y log con `upstream=`/tiempos | `C04_nginx.png` |
| C05 | Obligatoria | §4 | Reiniciar réplicas y consultar relojes: `docker compose restart tramites_1 tramites_2 usuarios_1 usuarios_2 pagos_1 pagos_2`; esperar puertos 3333-3338; `for p in 3333 3334 3335 3336 3337 3338; do printf '%s ' "$p"; curl -s localhost:$p/api/v1/reloj; echo; done` | Los seis relojes en `lamport:0`; luego un alta y el reloj incrementado | `C05_relojes.png` |
| C06 | Recomendada | §4 | `docker compose exec -T postgres psql -U municipalidad -d municipalidad -c "SELECT id, lamport, node_id FROM tramites ORDER BY lamport;"` y consultar `tramites_eventos` | Sellos y nodos persistidos; historial de estados | `C06_lamport_db.png` |
| C07 | Obligatoria | §5 | `./scripts/integracion_pagos.sh` y consultar `pagos_intentos` | 18/18; intención `confirmado`; coherencia pago/trámite | `C07_consistencia.png` |
| C08 | Recomendada | §6, §8 | `docker compose stop tramites_2`; `curl` con identidad; `docker compose start tramites_2`; log del gateway | `200` con una réplica menos y reparto al cambiar de upstream | `C08_failover.png` |
| C09 | Obligatoria | §7, §8 | Crear un trámite válido y guardar su id; luego `docker compose stop tramites_1 tramites_2`; 8 `POST /pagos` con ese id; `curl -s $BASE/api/v1/circuitos/pagos \| jq`; `curl $BASE/health` | Transición de ~2 s a ~20 ms; circuito `abierto`; health `200` | `C09_circuito.png` |
| C10 | Obligatoria | §8 | `docker compose stop postgres`; `curl` a `/api/v1/tramites`; `curl $BASE/health`; `docker compose start postgres` | `503` en ~0.3 s con mensaje de base de datos; health `200` | `C10_db_caida.png` |
| C11 | Obligatoria | §11, §12 | `./scripts/demostracion.sh fallos` | Tabla p50/p95/máx y transición del circuito | `C11_demo_fallos.png` |
| C12 | Obligatoria | §9 | `./scripts/recuperacion.sh saga` | Pago/trámite pendientes, intención pendiente; luego `pagado`/`confirmado` | `C12_saga.png` |
| C13 | Recomendada | §9 | `./scripts/recuperacion.sh demo-backup` y, si el informe cubre PITR, `pitr-preparar`, `pitr-destruir`, `pitr-recuperar`, `pitr-verificar` | Datos restaurados y PITR detenido antes del desastre | `C13_backup_pitr.png` |
| C14 | Obligatoria | §10 | `cd usuarios && node ace test`; `cd tramites && node ace test`; `cd pagos && node ace test` | 8, 29 y 7 pruebas aprobadas | `C14_japa.png` |
| C15 | Obligatoria | §10 | `./scripts/verificacion.sh` | Resumen final `76/76` y “LOS TRES PUNTOS...” | `C15_verificacion.png` |
| C16 | Recomendada | §10 | `./scripts/integracion_pagos.sh` | Resumen `18/18` | `C16_integracion.png` |
| C21 | Obligatoria | §11 | `curl -s $BASE/api/v1/circuitos/pagos \| jq` y `curl -s $BASE/api/v1/circuitos/tramites \| jq` | JSON de circuitos y métricas de llamadas/fallos/latencia | `C21_metricas.png` |

### A.4 Capturas de interfaz

| ID | Prioridad | Sección | Cómo generarla | Qué debe verse | Archivo sugerido |
|---|---|---|---|---|---|
| C17 | Recomendada | §3, §10 | Abrir `http://localhost:8080/ui/` | Pantalla de login, marca y pestañas | `C17_login.png` |
| C18 | Recomendada | §5, §10 | Entrar como admin; crear un trámite; ir a Pagos; solicitar y confirmar | Trámite `pendiente`, pago `pendiente`, luego ambos `pagado` | `C18_pago_ui.png` |
| C19 | Recomendada | §6, §10 | Entrar como admin; abrir Administración y Usuarios | Totales, catálogo de tipos y roles | `C19_admin_ui.png` |
| C20 | Obligatoria | §4, §7, §10 | Detener `tramites`; crear un trámite desde la UI; capturar “Pendientes de envío”; levantar `tramites`; pulsar “Reintentar ahora”; capturar historial y tabla | Cola pendiente, luego enviado con etiqueta `offline` y fechas “Solicitado/Registrado” | `C20_offline.png` |

### A.5 Capturas opcionales

- **C22 — Diagrama de arquitectura:** si se prefiere una figura dibujada, usar el diagrama
  de §3.1 como base y exportarlo a PNG.
- **C23 — Logs de gateway:** captura adicional de `docker compose logs gateway | grep
  upstream=` con al menos 6 líneas alternando réplicas.
- **C24 — PITR:** captura del log de PostgreSQL con `recovery stopping before commit` y la
  nueva línea de tiempo.

### A.6 Dónde insertar cada captura

| Sección | Capturas |
|---|---|
| §3 Arquitectura y nombres | C01, C02, C03, C04, C17 |
| §4 Sincronización | C05, C06, C20 |
| §5 Consistencia | C07, C18 |
| §6 Réplicas | C04, C08, C19 |
| §7 Tolerancia | C09 |
| §8 Escenarios | C08, C09, C10 |
| §9 Recuperación | C12, C13 |
| §10 Pruebas | C14, C15, C16 |
| §11 Métricas | C11, C21 |
| §12 Análisis | C11 |

Al incorporar una captura, reemplazar la nota “Capturas sugeridas” por una figura:

```markdown
![Figura C05 — Relojes lógicos de las seis réplicas](capturas/C05_relojes.png)
```

### A.7 Recomendaciones para las capturas

- Usar una terminal con fuente legible y ancho suficiente para que no se corten las tablas.
- Incluir el comando y su salida en la misma captura.
- Ocultar tokens, `X-Identidad`, contraseñas y URLs de túnel que no aporten.
- No mostrar datos personales reales; usar las cuentas de desarrollo.
- Tomar las capturas de UI en 100 % de zoom y sin pestañas ajenas.
- Para las capturas de fallos, restaurar los servicios al terminar:
  `docker compose up -d`.
- Si una captura sale con una réplica menos, repetirla con el stack completo.
- Guardar las imágenes en `capturas/` y versionarlas junto con el informe si corresponde.

---

## Anexo B — Comandos de reproducción

> Ejecutar en entorno de desarrollo. Algunos comandos detienen contenedores o modifican
> datos. Si algo queda detenido, `docker compose up -d` lo restaura.

### B.1 Arranque y estado

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail 50 gateway
```

### B.2 Pruebas

```bash
(cd usuarios && node ace test)
(cd tramites && node ace test)
(cd pagos && node ace test)
./scripts/integracion_pagos.sh
./scripts/verificacion.sh
```

### B.3 Demostraciones

```bash
./scripts/demostracion.sh comunicacion
./scripts/demostracion.sh reloj
./scripts/demostracion.sh fallos
./scripts/recuperacion.sh saga
./scripts/recuperacion.sh demo-backup
```

### B.4 PITR (destructivo para la instancia de recuperación)

```bash
./scripts/recuperacion.sh pitr-preparar
./scripts/recuperacion.sh pitr-destruir
./scripts/recuperacion.sh pitr-recuperar
./scripts/recuperacion.sh pitr-verificar
./scripts/recuperacion.sh pitr-limpiar
```

### B.5 Consultas útiles

```bash
# Relojes de las seis réplicas
for p in 3333 3334 3335 3336 3337 3338; do
  printf '%s ' "$p"; curl -s "localhost:$p/api/v1/reloj"; echo
done

# Circuitos
curl -s http://localhost:8080/api/v1/circuitos/pagos | jq
curl -s http://localhost:8080/api/v1/circuitos/tramites | jq

# Upstreams reales
docker compose logs --no-log-prefix --tail 20 gateway | grep upstream=

# Intenciones de pago
docker compose exec -T postgres psql -U municipalidad -d pagos_db -c \
  "SELECT id, id_tramite, pago_id, estado, intentos FROM pagos_intentos ORDER BY id DESC LIMIT 10;"

# Sellos de trámites
docker compose exec -T postgres psql -U municipalidad -d municipalidad -c \
  "SELECT id, estado, lamport, node_id FROM tramites ORDER BY lamport;"
```

---

## Referencias

- [`README.md`](./README.md): arquitectura, endpoints, relojes, pruebas, tolerancia y
  resultados.
- [`spects.md`](./spects.md): especificación técnica, requisitos funcionales y no
  funcionales.
- [`DEMOSTRACION.md`](./DEMOSTRACION.md): guía de demostración y tablas de latencia.
- [`RECUPERACION.md`](./RECUPERACION.md): saga, backup, PITR y limitaciones.
- [`GUION.md`](./GUION.md): guion de exposición y pasos manuales.
- [`EVIDENCIAS.txt`](./EVIDENCIAS.txt): salida consolidada de la verificación.
- [`docker-compose.yml`](./docker-compose.yml): topología, IPs, réplicas y healthchecks.
- [`gateway/nginx.conf`](./gateway/nginx.conf): upstreams, failover, timeouts y logs.
- [`gateway/ui/cola.js`](./gateway/ui/cola.js): cola offline, backoff e idempotencia.
- [`tramites/app/services/reloj_logico.ts`](./tramites/app/services/reloj_logico.ts): reloj
  de Lamport.
- [`tramites/app/services/cliente_http.ts`](./tramites/app/services/cliente_http.ts):
  timeouts, reintentos y métricas.
- [`tramites/app/services/interruptor.ts`](./tramites/app/services/interruptor.ts): circuit
  breaker.
- [`pagos/app/services/reconciliador.ts`](./pagos/app/services/reconciliador.ts):
  recuperación de la saga.
- [`tramites/app/controllers/tramites_controller.ts`](./tramites/app/controllers/tramites_controller.ts):
  idempotencia, versión y campos offline.
- [`scripts/verificacion.sh`](./scripts/verificacion.sh), `scripts/integracion_pagos.sh`,
  `scripts/demostracion.sh`, `scripts/recuperacion.sh`: evidencia ejecutable.


