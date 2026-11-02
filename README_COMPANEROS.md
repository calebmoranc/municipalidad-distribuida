# Guía para compañeros: instalar y ejecutar el proyecto

Esta guía es para clonar el repositorio en otra laptop y dejar el proyecto corriendo con Docker Compose.

> **Alcance de esta guía:** cada laptop ejecuta el proyecto de forma independiente.
> El clúster de 3 laptops con etcd/Patroni, Nginx por host y varios conectores de túnel
> es una fase posterior. No inicien el mismo stack en tres laptops esperando alta
> disponibilidad: esta versión todavía usa un solo PostgreSQL y una sola red Docker local.

## 1. Qué se necesita

- Laptop con Windows 10/11 o Ubuntu 24.04/26.04.
- 8 GB de RAM mínimo; 16 GB recomendado.
- 20 GB de disco libre.
- Virtualización activada en el BIOS/UEFI si usan Windows.
- Permisos de administrador para instalar WSL2 y Docker Desktop en Windows.
- Conexión a internet para el primer `docker compose up --build`.
- La misma red Wi-Fi/hotspot que las otras laptops, si van a probar acceso entre equipos.

No hace falta instalar Node, PostgreSQL ni Nginx en el host. Todo corre en contenedores.

## 2. Windows 10/11: WSL2 + Docker Desktop

Esta es la ruta recomendada para Windows. **No instalen Docker Engine dentro de WSL si usan Docker Desktop.**

### 2.1 Instalar WSL2

Abrir PowerShell como administrador:

```powershell
wsl --install -d Ubuntu-24.04
wsl --update
```

Si Ubuntu 26.04 aparece en su equipo, pueden usarla. Si no, Ubuntu 24.04 sirve igual porque los contenedores son Linux.

Reiniciar si Windows lo pide. Después abrir la aplicación **Ubuntu** y crear el usuario Linux.

### 2.2 Instalar Docker Desktop

1. Descargar e instalar **Docker Desktop** para Windows.
2. Abrir Docker Desktop.
3. En Settings → General, usar el backend **WSL 2**.
4. En Settings → Resources → WSL Integration, activar la distribución Ubuntu.
5. En Settings → General, activar “Start Docker Desktop when you sign in”.
6. Aplicar y reiniciar Docker Desktop.

Verificar dentro de la terminal Ubuntu:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

### 2.3 Instalar herramientas dentro de WSL

```bash
sudo apt update
sudo apt install -y git curl jq iputils-ping openssl
```

### 2.4 Clonar dentro de WSL, no en `/mnt/c`

```bash
cd ~
git clone <URL_DEL_REPOSITORIO> municipalidad
cd municipalidad
```

Si clonan en `/mnt/c/Users/...`, el proyecto funciona pero es más lento y puede fallar por permisos o finales de línea.

Configurar Git para no convertir scripts a CRLF:

```bash
git config --global core.autocrlf false
```

Si el repo ya se clonó con CRLF y aparecen errores como `bad interpreter: /bin/bash^M`, volver a clonar dentro de WSL o convertir los `.sh` a LF.

### 2.5 Firewall de Windows

Docker Desktop publica el puerto `8080` en el host Windows. Para que otra laptop o un celular puedan entrar:

- Permitir Docker Desktop en el firewall cuando Windows lo pregunte.
- Si la red del hotspot aparece como **Pública**, cambiarla a **Privada** o permitir el puerto.
- Probar desde otra laptop:

```bash
curl http://IP_DE_LA_LAPTOP_WINDOWS:8080/health
```

Si el ping funciona pero `curl` no, casi siempre es firewall o perfil de red.

## 3. Ubuntu 26.04 nativo

### 3.1 Instalar Docker Engine y Compose plugin

Instalar Docker Engine desde la guía oficial de Docker para Ubuntu. Al final deben funcionar:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

No usar `docker-compose` versión 1. El proyecto usa `docker compose`, el plugin v2.

Añadir el usuario al grupo Docker:

```bash
sudo usermod -aG docker "$USER"
```

Cerrar sesión y volver a entrar, o ejecutar `newgrp docker`. Luego:

```bash
sudo systemctl enable --now docker
```

### 3.2 Instalar herramientas

```bash
sudo apt update
sudo apt install -y git curl jq iputils-ping openssl ca-certificates
```

### 3.3 Clonar el repositorio

```bash
cd ~
git clone <URL_DEL_REPOSITORIO> municipalidad
cd municipalidad
```

## 4. Configurar secretos y archivos `.env`

El repositorio **no incluye** los `.env` reales; están ignorados por Git. Cada servicio tiene un `.env.example`.

Si el líder del equipo ya compartió los `.env`, usen esos archivos y **no ejecuten** el script de preparación. Es importante que en el clúster todos usen el mismo `AUTH_IDENTITY_SECRET` y el mismo `APP_KEY` por servicio.

Si cada uno va a probar su laptop por separado, pueden generarlos con:

```bash
cd ~/municipalidad
./scripts/preparar_entorno.sh
```

El script:

- Copia `usuarios/.env.example`, `tramites/.env.example` y `pagos/.env.example`.
- Genera un `APP_KEY` para cada servicio.
- Añade `AUTH_IDENTITY_SECRET`.
- No sobrescribe `.env` existentes salvo que se use `--force`.

Para usar un secreto compartido distinto:

```bash
AUTH_IDENTITY_SECRET="el-secreto-del-equipo" ./scripts/preparar_entorno.sh
```

No suban los `.env` a GitHub ni los compartan por canales públicos.

## 5. Verificar el entorno

Antes de levantar el proyecto:

```bash
./scripts/verificar_entorno.sh
```

Debe comprobar:

- `docker`
- `docker compose`
- demonio de Docker
- `git`, `curl`, `jq`, `openssl`
- `.env` de los tres servicios con `APP_KEY` y `AUTH_IDENTITY_SECRET`
- sintaxis de `docker-compose.yml`

Si falla algo, corregirlo antes de continuar.

## 6. Levantar el proyecto

```bash
docker compose up -d --build
```

La primera vez tarda porque descarga imágenes, instala dependencias y compila los servicios. Necesita internet.

Verificar:

```bash
docker compose ps -a
```

Resultado esperado:

- `municipalidad_postgres` en `healthy`.
- `tramites_1`, `tramites_2`, `usuarios_1`, `usuarios_2`, `pagos_1`, `pagos_2` en `healthy`.
- `municipalidad_gateway` en `running`.
- `db_init`, `tramites_migrate`, `usuarios_migrate`, `pagos_migrate` en `Exited (0)`.

Abrir la interfaz:

```text
http://localhost:8080/ui/
```

Credenciales de demostración:

| Correo | Contraseña | Rol |
|---|---|---|
| `admin@municipalidad.gob` | `Municipal123` | admin |
| `tesoreria@municipalidad.gob` | `Tesoreria123` | tesorería |

Si algo falla:

```bash
docker compose ps
docker compose logs --tail 100
```

## 7. Ejecutar la verificación automática

```bash
./scripts/verificacion.sh
```

Requiere `curl` y `jq`. Debe terminar sin `FAIL`. La salida de referencia está en `EVIDENCIAS.txt`.

## 8. Acceso desde otra laptop o celular

### 8.1 Misma red Wi-Fi

Cada laptop debe estar en el mismo hotspot/red, no una en el hotspot del celular y otra en el de la PC.

Ejemplo de IPs fijas:

| Equipo | IP |
|---|---|
| Gateway del hotspot | `192.168.43.1` |
| Laptop A | `192.168.43.11` |
| Laptop B | `192.168.43.12` |
| Laptop C | `192.168.43.13` |

Ajustar según la red real: Android suele usar `192.168.43.x`, iPhone `172.20.10.x` y Windows ICS `192.168.137.x`.

Probar desde otra laptop:

```bash
ping -c 3 192.168.43.11
curl http://192.168.43.11:8080/health
```

Si `ping` funciona pero `curl` no, revisar firewall.

### 8.2 Acceso desde otra red o datos móviles

Usar el túnel:

```bash
./scripts/tunel.sh
```

Muestra una URL `https://...trycloudflare.com/ui/`. Esa URL cambia cada vez que se reinicia el túnel. Para una URL fija hace falta un túnel con nombre de Cloudflare.

Detener el túnel:

```bash
./scripts/tunel.sh parar
```

El túnel solo expone el gateway; no expongan PostgreSQL ni los microservicios directamente.

## 9. Red Wi-Fi y clúster

Para esta fase:

- Todos los equipos en el mismo hotspot.
- Sin aislamiento de clientes.
- IPs fijas o reservas DHCP.
- Firewall permitiendo el puerto `8080`.
- Sin VIP/Keepalived sobre Wi-Fi.
- No usar una laptop como router/NAT del clúster.

Para la fase de clúster harán falta cambios adicionales: etcd, Patroni/PostgreSQL replicado, un `db-proxy` local, Nginx con upstreams a las tres laptops y varios conectores de Cloudflare Tunnel. Eso no está implementado en esta versión.

## 10. Problemas comunes

| Síntoma | Causa probable | Solución |
|---|---|---|
| `docker: command not found` | Docker no instalado o WSL sin integración | Instalar Docker Desktop y activar WSL Integration |
| `permission denied /var/run/docker.sock` | Usuario sin grupo Docker | `sudo usermod -aG docker $USER`, cerrar sesión |
| `Cannot connect to the Docker daemon` | Docker Desktop apagado o servicio detenido | Abrir Docker Desktop o `sudo systemctl start docker` |
| `env file ... not found` | Faltan los `.env` | `./scripts/preparar_entorno.sh` |
| `APP_KEY` vacío | `.env` incompleto | Regenerar con el script o pedir los `.env` al líder |
| `jq: command not found` | Falta `jq` | `sudo apt install jq` |
| `port is already allocated` | Otro stack usa el `8080` | `docker compose down` o detener el otro servicio |
| `502` o `504` | Réplicas aún arrancando o caídas | `docker compose ps`, esperar, revisar logs |
| `bad interpreter: /bin/bash^M` | Scripts con CRLF | Clonar en WSL, `core.autocrlf=false`, convertir a LF |
| `curl` falla pero `ping` funciona | Firewall | Permitir Docker Desktop/puerto en Windows; revisar red privada |
| El túnel no abre | Sin internet o contenedor caído | `docker compose logs tunel`, revisar salida a internet |
| Windows se suspende | Ahorro de energía | Desactivar suspensión e hibernación |
| WSL con hora incorrecta | Deriva tras suspensión | `wsl --shutdown` y abrir de nuevo |

## 11. Comandos útiles

```bash
# Levantar
docker compose up -d --build

# Estado
docker compose ps -a

# Logs
docker compose logs -f gateway
docker compose logs -f tramites_1

# Detener sin borrar datos
docker compose down

# Borrar datos y empezar de cero
docker compose down -v

# Verificación
./scripts/verificacion.sh

# Túnel
./scripts/tunel.sh
./scripts/tunel.sh parar
```

## 12. Prompt para IA

Si prefieren que una IA les guíe la instalación, usar el prompt de [PROMPT_IA.md](./PROMPT_IA.md). Está pensado para que la IA diagnostique primero, no invente comandos y valide al final.

## 13. Reglas para no romper el proyecto

- No subir `.env` ni secretos a GitHub.
- No usar `docker-compose` v1; usar `docker compose`.
- No instalar Docker Engine dentro de WSL si usan Docker Desktop.
- No usar `network_mode: host` en Windows.
- No instalar una VM Linux con NAT para el clúster; si usan VM, debe ser bridged.
- No exponer PostgreSQL ni etcd a internet.
- No ejecutar `docker compose down -v` sin confirmar: borra la base de datos.
- No iniciar tres copias del stack y asumir que ya hay alta disponibilidad.
- No cambiar IPs de `gateway/nginx.conf` sin cambiar también `docker-compose.yml`.
