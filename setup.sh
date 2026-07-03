#!/usr/bin/env bash
set -e

LICENSE_URL="https://license.minpeniche.com"

echo "========================================"
echo "   Caronte -- Setup interactivo"
echo "========================================"
echo ""

# 0. Validar license key
echo "Licencia"
echo "  Tienes una license key? (s/N): "
read -r HAS_KEY

if [[ "$HAS_KEY" =~ ^[sSyY] ]]; then
  echo "  Pega tu license key: "
  read -r LICENSE_KEY
  echo "  Validando..."
  VALIDATION=$(curl -s -X POST "${LICENSE_URL}/validate" \
    -H "Content-Type: application/json" \
    -d "{\"license_key\": \"${LICENSE_KEY}\"}")
  if echo "$VALIDATION" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.exit(j.ok?0:1)})" 2>/dev/null; then
    PLAN=$(echo "$VALIDATION" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).plan))")
    echo "  License valida -- Plan: ${PLAN}"
  else
    ERROR=$(echo "$VALIDATION" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).error||'desconocido'))")
    echo "  License invalida: ${ERROR}"
    echo ""
    echo "  Para comprar una licencia:"
    echo "  1. Envia SOL a: CkCpT39KtrSYs4bZcnM2NQFtucodnh8ynV4UuPWCJDw"
    echo "     0.1 SOL = licencia perpetua"
    echo "     0.03 SOL = 1 mes"
    echo "  2. POST a ${LICENSE_URL}/register con tx_signature y plan"
    echo "  3. Vuelve a ejecutar este setup con tu license key"
    exit 1
  fi
else
  echo ""
  echo "  +------------------------------------------+"
  echo "  | Caronte cuesta 0.1 SOL (unico)           |"
  echo "  | o 0.03 SOL/mes                           |"
  echo "  |                                          |"
  echo "  | Envia SOL a esta direccion:              |"
  echo "  | CkCpT39KtrSYs4bZcnM2NQFtucodnh8yn       |"
  echo "  |        V4UuPWCJDw                        |"
  echo "  |                                          |"
  echo "  | Luego POST a /register con:              |"
  echo "  | {tx_signature, plan: one_time}           |"
  echo "  | o {tx_signature, plan: monthly}          |"
  echo "  +------------------------------------------+"
  echo ""
  echo "  Visita ${LICENSE_URL}/pricing"
  exit 1
fi

# 1. Verificar dependencias
echo ""
echo "Verificando dependencias..."
if ! command -v node &>/dev/null; then
  echo "Node.js no encontrado. Instalalo: https://nodejs.org"
  exit 1
fi
echo "  Node.js $(node -v)"

if ! command -v npm &>/dev/null; then
  echo "npm no encontrado."
  exit 1
fi
echo "  npm $(npm -v)"

# 2. npm install
echo ""
echo "Instalando dependencias..."
npm install

# 3. Generar .env
echo ""
if [ -f .env ]; then
  echo "Ya existe .env -- se conserva."
else
  echo "Generando .env..."
  TOKEN=$(node -e "console.log(require('crypto').randomUUID().replace(/-/g,''))")
  cat > .env << ENVEOF
# Caronte - Configuracion
CARONTE_TOKEN=${TOKEN}
CARONTE_PORT=8788
CARONTE_LOCAL_NAME=server
CARONTE_REMOTE_HOSTS=[]
ENVEOF
  echo "  Token generado: ${TOKEN:0:16}... (guardado en .env)"
fi

# 4. Configurar hosts remotos
echo ""
echo "Configuracion de hosts remotos"
echo "  El servidor local ya esta configurado como 'server'."
echo "  Quieres anadir un host remoto via SSH? (s/N): "
read -r ADD_REMOTE
if [[ "$ADD_REMOTE" =~ ^[sSyY] ]]; then
  echo "  Nombre del host (ej: laptop): "
  read -r REMOTE_NAME
  echo "  SSH target (ej: usuario@ip): "
  read -r REMOTE_SSH
  echo "  Probando conexion SSH..."
  if ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "$REMOTE_SSH" "echo OK" 2>/dev/null; then
    echo "  Conexion SSH exitosa"
    EXISTING=$(grep CARONTE_REMOTE_HOSTS .env | cut -d= -f2-)
    if [ "$EXISTING" = "[]" ] || [ -z "$EXISTING" ]; then
      NEW_JSON="[{\"name\":\"${REMOTE_NAME}\",\"ssh\":\"${REMOTE_SSH}\"}]"
    else
      NEW_JSON=$(echo "$EXISTING" | node -e "
        let hosts = [];
        try { hosts = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); } catch {}
        hosts.push({name: '${REMOTE_NAME}', ssh: '${REMOTE_SSH}'});
        console.log(JSON.stringify(hosts));
      ")
    fi
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|CARONTE_REMOTE_HOSTS=.*|CARONTE_REMOTE_HOSTS=${NEW_JSON}|" .env
    else
      sed -i "s|CARONTE_REMOTE_HOSTS=.*|CARONTE_REMOTE_HOSTS=${NEW_JSON}|" .env
    fi
    echo "  Host '${REMOTE_NAME}' agregado a .env"
  else
    echo "  No se pudo conectar. Revisa el target SSH. Edita .env manualmente."
  fi
fi

# 5. Resumen
echo ""
echo "========================================"
echo "   Caronte listo"
echo "========================================"
echo ""
echo "  Iniciar:         node server.mjs"
echo "  Con pm2:         pm2 start ecosystem.config.cjs"
echo "  Health check:    curl http://127.0.0.1:8788/health"
echo "  Logs (pm2):      pm2 logs caronte"
echo "  Editar .env:     $PWD/.env"
echo ""
