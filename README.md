# Caronte ⛵

MCP server que mueve archivos y ejecuta operaciones entre máquinas vía SSH, accesible desde cualquier cliente MCP (Claude Desktop, web, Cursor, etc.).

El barquero que cruza cosas de un lado a otro.

## Qué resuelve

Los agents de IA no pueden tocar archivos locales de tus máquinas. Caronte es el puente:
corre en un servidor 24/7 (o cualquier máquina siempre encendida) y expone herramientas
vía HTTPS alcanzables desde cualquier cliente MCP.

- **Chat → servidor**: guardar texto/código generado directo en disco
- **Chat → remoto**: escribir en cualquier máquina vía SSH
- **Servidor ↔ remoto**: copiar archivos en ambos sentidos con SCP
- **Inspección remota**: listar carpetas, leer archivos de texto
- **Operación**: clonar repos, ejecutar shell, npm install, git pull, etc.

## Herramientas (7)

| Tool | Qué hace | Args clave |
|------|----------|------------|
| `write_file` | Escribe texto en archivo. Crea carpetas padre. | `host`, `path`, `content` |
| `read_text` | Devuelve contenido de archivo (tope configurable). | `host`, `path`, `max_bytes?` |
| `list_dir` | Lista carpeta (`ls -lah`). | `host`, `path` |
| `make_dir` | Crea carpeta recursiva. | `host`, `path` |
| `git_clone` | Clona un repo de GitHub. | `host`, `repo_url`, `dest?` |
| `transfer` | Copia archivo entre dos equipos (`scp -3`). | `from_host`, `from_path`, `to_host`, `to_path` |
| `run_command` | Ejecuta shell completo. | `host`, `command` |

## Guardrail de seguridad 🔒

`run_command` bloquea automáticamente **comandos destructivos** — `rm -rf`, `git push --force`,
`git reset --hard`, `git clean -fd`, `find -delete`, `mkfs`, `dd of=`, `shred`.

Si el comando matchea, NO se ejecuta a menos que la llamada incluya `confirm:"CONFIRMO"`.
Es un cinturón de seguridad contra accidentes, no una cárcel criptográfica.

## Stack

- **Runtime:** Node.js (ESM)
- **HTTP:** Express (body limit 25 MB)
- **MCP:** `@modelcontextprotocol/sdk` — Streamable HTTP
- **Validación:** zod
- **Proceso:** pm2
- **Exposición sugerida:** Cloudflare Tunnel, Tailscale Funnel, o proxy reverso

## Rápido

```bash
git clone <tu-repo>
cd caronte
cp .env.example .env
# editar .env: CARONTE_TOKEN, CARONTE_REMOTE_HOSTS (opcional)
npm install
node server.mjs
```

O con pm2:

```bash
pm2 start ecosystem.config.cjs
```

## Conectar desde Claude

1. Claude Desktop → Settings → Developer → MCP Servers → Add custom
2. URL: `https://tu-dominio.com/mcp?key=<CARONTE_TOKEN>`
3. Nombre: `Caronte`

O cualquier cliente MCP compatible con Streamable HTTP.

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `CARONTE_TOKEN` | — | Token de autenticación (requerido) |
| `CARONTE_PORT` | `8788` | Puerto local |
| `CARONTE_LOCAL_NAME` | `server` | Nombre del host local |
| `CARONTE_REMOTE_HOSTS` | `[]` | JSON array de hosts SSH: `[{"name":"laptop","ssh":"user@host"}]` |

## Licencia

MIT
