---
name: caronte
version: 1.1.0
description: MCP server for file ops and remote shell across machines.
homepage: https://github.com/minpeniche/caronte
metadata:
  caronte:
    emoji: ⛵
    category: infrastructure
    api_base: https://license.minpeniche.com
---

# Caronte ⛵

MCP server para transferencia de archivos, shell remoto y operaciones entre
máquinas vía SSH. 7 tools: `write_file`, `read_text`, `list_dir`, `make_dir`,
`git_clone`, `transfer` (scp), y `run_command` con guardrail antidesastre.

Corre en un servidor 24/7 y se expone vía Streamable HTTP — cualquier cliente
MCP (Claude Desktop, web, agents) puede conectarse.

## Dónde conseguirlo

- **Código fuente:** https://github.com/minpeniche/caronte
- **Documentación completa:** README.md del repo (incluye setup paso a paso)
- **Licencia:** MIT — libre para usar, modificar y redistribuir

## Prerequisitos

- Node.js 18+
- Una máquina siempre encendida (servidor, VPS, Raspberry Pi, Mac Mini)
- **Opcional:** SSH configurado a máquinas remotas, Cloudflare Tunnel / Tailscale

## Setup rápido

```bash
git clone https://github.com/minpeniche/caronte
cd caronte
cp .env.example .env
# Editar .env: poner un token seguro en CARONTE_TOKEN
npm install
node server.mjs
```

## Arquitectura

```
Cliente MCP (agente / Claude Desktop / web)
       │  HTTPS + token
       ▼
tu-dominio.com/mcp   ──(túnel/proxy)──► Servidor :8788
       │
       ├── local (el servidor mismo)
       └── SSH/SCP ──► Máquinas remotas
```

## Tools disponibles

| Tool | Descripción |
|------|-------------|
| `write_file` | Escribe texto en archivo. Crea carpetas padre. |
| `read_text` | Lee archivo de texto (tope configurable de bytes). |
| `list_dir` | Lista carpeta (`ls -lah`). |
| `make_dir` | Crea carpeta recursiva. |
| `git_clone` | Clona repo de GitHub. |
| `transfer` | SCP entre dos equipos. |
| `run_command` | Shell completo con guardrail destructivo. |

## Guardrail

El `run_command` bloquea operaciones destructivas (`rm -rf`, `git push --force`,
`git reset --hard`, etc.) y requiere `confirm:"CONFIRMO"` explícito para ejecutarlas.
Esto previene accidentes sin impedir operaciones legítimas.

## Variables de entorno

| Variable | Default | Requerida |
|----------|---------|-----------|
| `CARONTE_TOKEN` | — | Sí |
| `CARONTE_PORT` | `8788` | No |
| `CARONTE_LOCAL_NAME` | `server` | No |
| `CARONTE_REMOTE_HOSTS` | `[]` | No |

## Cómo usarlo desde un agente

El agente que cargue esta skill sabrá que puede invocar las 7 tools de Caronte
conectándose al endpoint MCP configurado por su humano. Las tools reciben:
- `host` (string): nombre del equipo destino
- `path` (string): ruta absoluta del archivo/carpeta
- `content` (string): para `write_file`
- `command` (string): para `run_command`
- `confirm` (string opcional): `"CONFIRMO"` para saltar el guardrail

## Pitfalls

- Caronte **no expande `~`** en rutas. Usar siempre rutas absolutas.
- Los hosts remotos necesitan SSH configurado (key-based auth recomendado).
- No reiniciar Caronte vía `run_command` desde el mismo chat — corta la
  conexión a media llamada. Usar terminal para restart.
- El body de HTTP tiene límite de 25 MB para write_file.
- El guardrail es conductual, no criptográfico: comandos ofuscados (base64,
  variables, scripts) pueden esquivarlo. Es un cinturón contra accidentes,
  no una muralla de seguridad.
