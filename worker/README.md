# Caronte License Server

Valida pagos en Solana y genera license keys para Caronte.

## Deploy

```bash
cd worker
npm install -g wrangler  # si no lo tienes

# Crear KV namespace
wrangler kv:namespace create "LICENSES"
# → copia el ID que devuelve a wrangler.toml

# Configurar secrets
wrangler secret put LICENSE_SECRET
# → pega un string aleatorio (ej: openssl rand -hex 32)

# Opcional: admin secret para stats
wrangler secret put ADMIN_SECRET

# Deploy
wrangler deploy
```

## Endpoints

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/pricing` | GET | Precios actuales y dirección de wallet |
| `/register` | POST | Registra pago, recibe license key |
| `/validate` | POST | Valida license key (usa setup.sh) |
| `/admin/stats` | GET | Estadísticas (requiere `?secret=...`) |

## Uso

```bash
# 1. Ver precios
curl https://caronte-license.tu-domain.workers.dev/pricing

# 2. Enviar SOL a CkCpT39KtrSYs4bZcnM2NQFtucodnh8ynV4UuPWCJDw

# 3. Registrar pago (reemplaza tx_signature)
curl -X POST https://caronte-license.tu-domain.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{"tx_signature":"...","plan":"one_time"}'

# 4. Validar license
curl -X POST https://caronte-license.tu-domain.workers.dev/validate \
  -H "Content-Type: application/json" \
  -d '{"license_key":"..."}'
```
