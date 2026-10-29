# Recuperación ante fallos

Este documento es la justificación técnica de la tercera parte del informe. Explica qué
problema hay, por qué las soluciones obvias (savepoints y 2PC) no lo resuelven, y qué se
implementó en su lugar.

Para ejecutarlo está `scripts/recuperacion.sh`. Para el guion de presentación,
[GUION.md](./GUION.md) §5.

---

## 1. El problema: doble escritura

`POST /api/v1/pagos/:id/confirmar` toca **dos recursos que no comparten transacción**:

```
   pagos_db                             municipalidad          (otro servicio)
┌──────────────────────────┐         ┌──────────────┐
│ INSERT pagos_intentos    │         │  UPDATE      │
│ UPDATE pagos.estado      │         │  tramites    │
└──────────────────────────┘         │  estado      │
                                     └──────────────┘
        │                                    ▲
        │  PATCH /api/v1/tramites/:id        │
        └───────────────────────────────────┘
                (otro servicio, otra base, por HTTP)
```

La **solicitud** (`POST /api/v1/pagos`) solo escribe en `pagos` y deja el pago en
`pendiente`; es la **confirmación** la que cruza la frontera. Los servicios son
independientes y cada uno tiene su base. `pagos` **no puede** abrir una transacción que
abarque a `tramites`. Esto se llama **problema de doble escritura** y es la raíz de todo lo
que sigue.

Hay una ventana, entre los dos pasos, en la que el sistema está a medio camino:

- Si el proceso muere en la ventana: el trámite sigue `pendiente` y el pago ya está
  registrado. Nadie se entera. **Ese es el fallo que había antes y el que ahora se
  recupera.**
- Si la llamada al otro servicio falla: hay que decidir si deshacer o completar después.

La primera versión hacía todo en un solo paso y, si el PATCH fallaba, **borraba el pago**
en el propio proceso (clawback):

```ts
if (!actualizado) {
  await pago.delete()          // deshace a mano
  return response.serviceUnavailable(...)
}
```

Funciona mientras el proceso siga vivo y no deja rastro del intento. **No sirve si el
proceso está muerto**, que es justo el caso interesante. La versión actual conserva el pago
`pendiente`, registra la intención antes de cruzar y deja que el reconciliador termine.

---

## 2. Por qué un savepoint no lo resuelve

Es la primera idea que surge, y es la que el enunciado menciona ("rollback a puntos de
salvados"). No sirve aquí, por una razón concreta:

> Un `SAVEPOINT` pertenece a **una sola sesión de PostgreSQL en una sola base de datos**.

```sql
BEGIN;
  INSERT INTO pagos ...;
  SAVEPOINT tras_insertar;
  -- hacer el PATCH por HTTP al otro servicio  <-- otra base de datos
COMMIT;
```

Ese `COMMIT` no puede deshacer lo que hizo el `PATCH`. Peor aún: **empeora el problema**.
Al mantener la transacción abierta mientras se espera una llamada HTTP:

- se **bloquean filas** de `pagos` durante toda la espera, con el riesgo de bloqueos
  muertos si el otro servicio responde tarde;
- el `pago.delete()` manual sigue siendo necesario, porque la transacción solo protege la
  parte local;
- y si el proceso muere, la transacción local sí se revierte, pero el `tramites` ya quedó
  modificado. La inconsistencia sigue existiendo, y ahora además con bloqueos.

> **Conclusión: un savepoint protege los pasos locales de una operación. No puede cubrir una
> llamada a otro servicio.** Es una herramienta útil, pero para otro problema.

Dónde sí es pertinente: si un mismo servicio tuviera que escribir en **varias tablas de su
propia base** y做为 dejar el primero de los dos escrito, el savepoint resolvería el
"deshacer solo la parte que me interesa". En este proyecto `pagos` escribe una sola fila por
operación, así que no hay nada que agrupar.

---

## 3. Por qué 2PC tampoco es la respuesta

PostgreSQL sí soporta dos fases de commit de verdad (`PREPARE TRANSACTION` al estilo XA), así
que la pregunta legítima es por qué no se usa. Hay cuatro razones, y ninguna de ellas es "no sé hacerlo":

**a) El coordinador es el punto único de fallo que se quiere eliminar.** El 2PC necesita un
coordinador que sepa qué participantes confirmaron la fase `prepare`. Si ese coordinador
muere con participantes ya preparados, alguien tiene que reconstruir su estado y
bloquear al resto. Es un punto único de fallo nuevo, no una solución.

**b) Genera bloqueo.** Un participante que hizo `prepare` y luego murió **bloquea** la
decisión final hasta que alguien lo recupere. Con dos réplicas de `pagos` y dos de
`tramites` hablando a través del gateway, un solo proceso muerto convierte el
sistema en algo que espera, no en algo que falla rápido.

**c) Acopla la disponibilidad.** Hoy el sistema registra pagos aunque `tramites` esté caído:
guarda el pago y devuelve 503, y el otro proceso termina el trabajo después. Con 2PC, **si
`tramites` no está disponible, `pagos` no puede confirmar** el pago. Se pierde la propiedad
que hace útil al sistema durante una caída.

**d) No es negocio razonable a esta escala.** XA obliga a que todas las bases implicadas
entiendan el protocolo y a que nadie más escriba en esas tablas por su cuenta. Rompe la
independencia de los servicios, que es justo lo que hace manejable el proyecto.

> **Conclusión: el 2PC daría atomicidad real, pero a un precio que aquí no compensa. Se
> declina de forma consciente, no por desconocimiento.**

---

## 4. Lo que se implementó: Saga con registro de recuperación

Es el patrón correcto para microservicios con bases separadas. No finge atomicidad: **la
asume que no la hay y hace que esa ventana se cierre sola**.

### La tabla `pagos_intentos`

```
                    ┌──────────────────────────────────────┐
  POST /pagos/:id/ ─▶│ INSERT pagos_intentos                │
  confirmar          │ estado='pendiente'                   │
                    │ id_tramite, usuario_id, pago_id      │
                    └────────────────┬─────────────────────┘
                                     ▼ pago ya existe (pendiente)
                                     ▼
                              PATCH a tramites
                                     │
                ┌────────────────────┴────────────────────┐
                ▼                                         ▼
         ok                              fallo / el proceso muere
                │                                         │
                ▼                                         ▼
     trámite='pagado' +                     queda en 'pendiente'
     pago='pagado' +                                  │
     estado='confirmado'                  lo recoge el reconciliador
                                                     │
                                    ┌────────────────┴────────────────┐
                                    ▼                                 ▼
                          completa el PATCH                  el pago no llegó
                          trámite='pagado'                   a crearse
                          pago='pagado'                      estado='revertido'
                          estado='confirmado'
```

La diferencia con el clawback antiguo es **dónde vive la información**. Antes estaba en las
variables de pila de un proceso que puede morir; ahora está en una tabla.

### El reconciliador

`pagos/app/services/reconciliador.ts` se ejecuta **al arrancar cada réplica**. Busca
intenciones `pendiente` que llevan más de `PAGOS_INTENTOS_ANTIGUEDAD_SEG` segundos (5 por
defecto) y, para cada una, decide mirando el estado **real**:

| Estado real | Acción |
|---|---|
| Hay pago y el trámite está `pagado` | `confirmado` (ya se había completado) |
| No llegó a crearse el pago | `revertido` |
| Hay pago y el trámite no está pagado | **intenta completar el PATCH** |
| El PATCH sigue fallando | deja `pendiente`, suma `intentos`, reintenta más tarde |

Se prefiere **intentar completar antes de deshacer**. Si `tramites` sigue caído, se deja la
intención pendiente en lugar de borrar el pago: borrar sin poder confirmar dejaría al usuario
pagando por nada, que es peor que tardar.

### Cómo se coordinan las dos réplicas

Las dos ejecutan el reconciliador al arrancar. El idioma de PostgreSQL que lo resuelve:

```sql
SELECT id, id_tramite, usuario_id, pago_id
FROM pagos_intentos
WHERE estado = 'pendiente'
  AND updated_at < now() - make_interval(secs => ?)
ORDER BY id
LIMIT 20
FOR UPDATE SKIP LOCKED
```

- `FOR UPDATE` deja la fila bloqueada para la primera transacción que la toque.
- `SKIP LOCKED` hace que la segunda réplica **se la salte** en lugar de esperar.

Así cada intención la atiende exactamente una réplica, sin bloqueos entre ellas. Es el mismo
idioma que usan las colas de trabajo de PostgreSQL.

### El fallo inyectado

Para poder demostrar la recuperación sin rezar para que el proceso muera en el milisegundo
exacto, existe un interruptor:

```bash
PAGOS_FALLAR_ANTES_DE_PATCH=1 docker compose up -d pagos_1
```

Con esa variable el proceso **se muere** (`process.exit(70)`) después de guardar el pago y
antes del `PATCH`. Es un fallo **real**, no una simulación: el proceso deja de existir.

---

## 5. Las tres demostraciones

### 5.1 Backup lógico y restauración

```bash
./scripts/recuperacion.sh demo-backup
```

Crea 5 trámites, hace backup, los borra, restaura el primario y verifica que volvieron.
Es **recuperación ante pérdida de datos**.

También se puede restaurar en una instancia aparte, sin tocar el servicio, para comprobar
que el archivo sirve de verdad:

```bash
./scripts/recuperacion.sh restaurar   # instancia en localhost:55432
./scripts/recuperacion.sh comparar    # original vs restaurado
```

### 5.2 PITR: recuperar a un instante exacto

```bash
./scripts/recuperacion.sh pitr-preparar    # base backup + archivado de WAL
./scripts/recuperacion.sh pitr-destruir    # anota el instante y destruye datos
./scripts/recuperacion.sh pitr-recuperar   # arranca otra instancia y vuelve atrás
./scripts/recuperacion.sh pitr-verificar   # qué se recuperó y qué no
./scripts/recuperacion.sh pitr-limpiar
```

La secuencia real es:

1. Se anota el instante con milisegundos: `2026-10-13T23:03:40.127`.
2. Se crea una tabla `tabla_desastre` **después** de ese instante.
3. La instancia de recuperación arranca con:
   ```
   recovery_target_time='2026-10-13T23:03:40.127'
   recovery_target_inclusive=off
   recovery_target_action=promote
   ```
4. El log de PostgreSQL dice exactamente dónde paró:
   ```
   recovery stopping before commit of transaction 907, time 2026-10-13 23:03:40.654491+00
   selected new timeline ID: 2
   ```
5. La tabla del desastre **no existe** en la copia; los datos anteriores **sí**.

> **No se restauró "el último backup": se reprodujo el WAL hasta un instante y se paró ahí.**
> Eso es lo que hace el PITR y lo que ningún `pg_dump` puede dar.

Dos detalles que costaron encontrar, y que están comentados en el código:

- **Milisegundos importan.** Con el instante truncado al segundo, la transacción del
  desastre cae dentro del mismo segundo y **sí** acaba en la copia.
- **`recovery_target_inclusive=off`.** Con el valor por defecto (`on`) PostgreSQL aplica la
  primera transacción igual o posterior al objetivo, y vuelve a meter el desastre.

### 5.3 Saga: una operación interrumpida se recupera sola

```bash
./scripts/recuperacion.sh saga
```

Salida real:

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
```

Nótese que la recuperación fue **hacia adelante**: el reconciliador terminó el trabajo que
el proceso muerto había empezado, en lugar de tirar el pago. El usuario no pierde su
pago y el sistema queda consistente.

---

## 6. Lo que esto NO da

Conviene decirlo con precisión:

- **No hay atomicidad entre las tres bases.** Existe una ventana en la que el sistema está
  a medio camino. Lo que se ha conseguido es que esa ventana **se cierra sola** y que
  **siempre queda registro** (`pagos_intentos`) de qué pasó y por qué.
- **La ventana sigue siendo visible** entre que el proceso muere y que el reconciliador
  actúa. Con los valores por defecto son unos 5 segundos más el arranque del servicio.
- **Si `pagos` y `tramites` caen a la vez y vuelven después**, las intenciones se quedan en
  `pendiente` sumando `intentos` en cada pasada. No hay límite de reintentos ni alerta: es la
  deuda que quedaría abierta.
- **El reconciliador solo corre al arrancar** y cuando se llama a mano por HTTP. No hay
  tarea programada: si se pierde una réplica y vuelve a los cinco minutos, la recuperación
  se retrase esos cinco minutos.
- ~~La base de datos no tiene timeout.~~ **Resuelto.** Con `postgres` caído la petición se
  quedaba 8.4s y devolvía 500; ahora responde 503 en 0.3s. Ver la sección "El presupuesto
  de tiempo" del README.
- **No hay réplica de PostgreSQL en streaming.** El PITR recupera en una instancia aparte y
  hay que cambiarla a mano. Un standby que se pueda promover automáticamente daría un
  failover de datos real; no está implementado.