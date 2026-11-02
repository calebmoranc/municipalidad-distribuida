# Prompt para IA: instalar y ejecutar el proyecto

Copia el prompt completo, reemplaza los datos entre `[...]` y pégalo en la IA que uses. No borres las reglas: están para evitar que la IA cambie cosas que no debe.

## Prompt completo

```text
Actúa como ingeniero DevOps y guíame paso a paso para dejar corriendo un proyecto con Docker Compose en mi laptop.

DATOS DEL EQUIPO
- Sistema operativo: [Windows 10 / Windows 11 / Ubuntu 26.04]
- Shell que voy a usar: [PowerShell / WSL Ubuntu / Ubuntu]
- RAM: [8 GB / 16 GB / otro]
- Disco libre: [20 GB / otro]
- ¿Tengo permisos de administrador?: [sí / no]
- ¿La laptop está en la misma Wi-Fi/hotspot que las otras laptops?: [sí / no / no lo sé]
- IP de esta laptop en esa red: [ej. 192.168.43.11]
- IP del gateway/hotspot: [ej. 192.168.43.1]
- Repositorio: [URL_DEL_REPOSITORIO]

OBJETIVO
Dejar el proyecto corriendo en esta laptop con `docker compose up -d --build`, validar que los contenedores estén sanos y que la interfaz abra en `http://localhost:8080/ui/`.

CONTEXTO DEL PROYECTO
- Es una plataforma con tres microservicios: usuarios, trámites y pagos.
- Usa Docker Compose, PostgreSQL, Nginx como gateway y Cloudflare Tunnel opcional.
- El proyecto ya trae `docker-compose.yml`, `gateway/nginx.conf`, scripts y archivos `.env.example`.
- El repositorio NO incluye los `.env` reales.
- Esta fase es para ejecutar el proyecto en UNA laptop. El clúster de 3 laptops con etcd/Patroni es una fase posterior y NO debe implementarse aquí.
- No se debe modificar la lógica de negocio ni la arquitectura para esta instalación.

REGLAS OBLIGATORIAS
1. Primero diagnostica el sistema; no asumas que los comandos existen.
2. No uses `docker-compose` versión 1. Usa `docker compose` (plugin v2).
3. En Windows, usa WSL2 + Docker Desktop. No instales Docker Engine dentro de WSL si ya usas Docker Desktop.
4. No propongas una VM Linux con red NAT. Si propones una VM, debe ser con red bridged y debes justificarlo.
5. No uses `network_mode: host` en Windows.
6. No expongas PostgreSQL, etcd ni los microservicios directamente a internet.
7. No subas `.env`, contraseñas ni secretos a Git.
8. No ejecutes `docker compose down -v` sin advertir que borra la base de datos.
9. No cambies IPs de `gateway/nginx.conf` ni la topología del compose para esta fase.
10. Si necesitas modificar un archivo, muestra primero el diff propuesto y espera mi confirmación.
11. Si un comando falla, pide la salida exacta; no inventes resultados.
12. Al final, valida con los scripts del proyecto.

PASOS QUE DEBES GUIAR
1. Verificar sistema operativo, arquitectura, RAM y disco.
2. Instalar los requisitos:
   - Windows: WSL2, Ubuntu en WSL, Docker Desktop con integración WSL, git, curl, jq, iputils-ping, openssl.
   - Ubuntu: Docker Engine, Compose plugin, git, curl, jq, iputils-ping, openssl.
3. Verificar `docker --version`, `docker compose version` y `docker run --rm hello-world`.
4. Clonar el repositorio dentro del sistema Linux o WSL, no en `/mnt/c`.
5. Configurar Git con `core.autocrlf false`.
6. Crear los `.env` con `./scripts/preparar_entorno.sh` o usar los `.env` que comparte el líder del equipo.
7. Ejecutar `./scripts/verificar_entorno.sh` y corregir lo que falle.
8. Ejecutar `docker compose up -d --build`.
9. Revisar `docker compose ps -a`.
10. Abrir `http://localhost:8080/ui/` y probar el login de administrador.
11. Ejecutar `./scripts/verificacion.sh`.
12. Probar acceso desde otra laptop o celular:
    - Misma red: `curl http://IP_DE_ESTA_LAPTOP:8080/health`.
    - Otra red: `./scripts/tunel.sh` y abrir la URL desde un celular con datos móviles.
13. Si `ping` funciona pero `curl` falla, revisar firewall y perfil de red.
14. Entregar un resumen con:
    - Qué se instaló.
    - Qué archivos se modificaron.
    - Comandos ejecutados.
    - Resultado de `docker compose ps -a`.
    - Resultado de `./scripts/verificacion.sh`.
    - Problemas pendientes.

NO HAGAS
- No instales Node, PostgreSQL ni Nginx en el host: el proyecto ya los usa en contenedores.
- No cambies `docker-compose.yml`, `gateway/nginx.conf` ni el código de los servicios para esta fase.
- No uses `sudo docker compose` si el usuario ya está en el grupo Docker.
- No clones el repo en `/mnt/c` si estás en WSL.
- No mezcles una laptop en el hotspot del celular y otra en el hotspot de la PC; todas deben estar en la misma red.
- No uses VIP/Keepalived sobre Wi-Fi.
- No inicies tres copias del stack pensando que ya hay alta disponibilidad.
```

## Prompt corto

Si la IA no acepta un prompt largo, usa este:

```text
Voy a ejecutar un proyecto Docker Compose en [Windows 11 con WSL2 / Ubuntu 26.04]. Ayúdame a dejarlo corriendo sin cambiar la lógica ni la arquitectura.

Requisitos: Docker + Compose v2, git, curl, jq, iputils-ping y openssl. En Windows usaré WSL2 + Docker Desktop, no una VM con NAT. Clonaré el repo dentro de WSL/Ubuntu y usaré `./scripts/preparar_entorno.sh` para crear los `.env`. Luego ejecutaré `./scripts/verificar_entorno.sh`, `docker compose up -d --build`, `docker compose ps -a` y `./scripts/verificacion.sh`.

Diagnostica primero, no asumas comandos, no expongas PostgreSQL ni subas secretos a Git, no uses `docker-compose` v1 ni `network_mode: host` en Windows. Si algo falla, pídeme la salida exacta. Al final, dame un resumen de instalación, cambios y resultados.
```

## Qué debe revisar la IA antes de responder

- ¿Está en Windows o Linux?
- ¿Está usando PowerShell, WSL o Ubuntu?
- ¿Docker Desktop o Docker Engine?
- ¿Tiene permisos de administrador?
- ¿El repo está dentro de WSL/Ubuntu?
- ¿Existen los `.env`?
- ¿El demonio de Docker responde?
- ¿El puerto `8080` está libre?
- ¿La red es la misma que la de las otras laptops?
- ¿El firewall permite conexiones entrantes al `8080`?
