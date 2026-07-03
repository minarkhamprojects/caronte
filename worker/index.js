// Caronte License Server — Cloudflare Worker
// Valida pagos en Solana y genera license keys.
//
// Endpoints:
//   GET  /pricing        — Precios actuales
//   POST /register       — Registra pago y obtiene license key
//   POST /validate       — Valida license key (setup.sh)
//   GET  /admin/stats    — Estadísticas (protegido por ADMIN_SECRET)

// ─── CONFIG ───
const RECEIVER_WALLET = "CkCpT39KtrSYs4bZcnM2NQFtucodnh8ynV4UuPWCJDw";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

const PRICING = {
  one_time: { label: "Pago único — licencia perpetua",    sol: 0.1, usdc: 19 },
  monthly:  { label: "Suscripción mensual",               sol: 0.03, usdc: 5 },
};

// License signing secret (debe configurarse como secreto en Cloudflare)
// wrangler secret put LICENSE_SECRET
const LICENSE_SECRET = process.env.LICENSE_SECRET || 'dev-secret-change-me';

// ─── HELPERS ───
function hexToBase64(h) {
  return btoa(String.fromCharCode(...h.match(/.{1,2}/g).map(b => parseInt(b, 16))));
}

function signLicense(data) {
  // Simple HMAC-based license signing
  const encoder = new TextEncoder();
  const keyData = encoder.encode(LICENSE_SECRET);
  const msg = encoder.encode(JSON.stringify(data));
  // Use Web Crypto API
  return crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    .then(key => crypto.subtle.sign('HMAC', key, msg))
    .then(sig => hexToBase64(Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('')));
}

function generateLicenseKey(data, signature) {
  const payload = btoa(JSON.stringify(data));
  return `${payload}.${signature}`;
}

function parseLicenseKey(key) {
  try {
    const [payload, sig] = key.split('.');
    const data = JSON.parse(atob(payload));
    return { data, sig, raw: key };
  } catch {
    return null;
  }
}

async function verifyLicenseKey(key) {
  const parsed = parseLicenseKey(key);
  if (!parsed) return null;
  const expectedSig = await signLicense(parsed.data);
  if (parsed.sig !== expectedSig) return null;
  // Verificar expiración
  if (parsed.data.exp && Date.now() > parsed.data.exp) return null;
  return parsed.data;
}

// ─── SOLANA TX VERIFICATION ───
async function verifySolanaTx(signature, expectedAmountLamports) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getTransaction",
    params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]
  });
  const resp = await fetch(SOLANA_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const json = await resp.json();
  if (!json.result) return { ok: false, error: "Transacción no encontrada o no confirmada" };

  const tx = json.result;
  // Verificar que la wallet destino sea la correcta
  const postBalances = tx.meta?.postBalances || [];
  const preBalances = tx.meta?.preBalances || [];
  const accountKeys = tx.transaction?.message?.accountKeys || [];

  const receiverIndex = accountKeys.findIndex(k => k === RECEIVER_WALLET);
  if (receiverIndex === -1) return { ok: false, error: "Wallet destino no coincide" };

  const amount = postBalances[receiverIndex] - preBalances[receiverIndex];
  if (amount < expectedAmountLamports) return { ok: false, error: `Monto insuficiente: esperado ${expectedAmountLamports}, recibido ${amount}` };

  return { ok: true, amount, slot: tx.slot, signature };
}

// ─── REQUEST HANDLER ───
async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
    status, headers: { "Content-Type": "application/json", ...corsHeaders }
  });

  // ── GET /pricing ──
  if (method === "GET" && path === "/pricing") {
    return json({
      product: "caronte",
      wallet: RECEIVER_WALLET,
      chain: "solana",
      plans: PRICING,
      instructions: "Envía SOL a la wallet indicada, luego POST /register con tx_signature y plan (one_time|monthly). Recibirás una license key."
    });
  }

  // ── POST /register ──
  if (method === "POST" && path === "/register") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON inválido" }, 400); }
    const { tx_signature, plan } = body;
    if (!tx_signature) return json({ error: "Falta tx_signature" }, 400);
    if (!plan || !PRICING[plan]) return json({ error: "Plan inválido. Opciones: " + Object.keys(PRICING).join(", ") }, 400);

    // Calcular monto esperado en lamports (1 SOL = 1_000_000_000 lamports)
    const expectedSol = PRICING[plan].sol;
    const expectedLamports = Math.floor(expectedSol * 1_000_000_000);

    // Verificar transacción en Solana
    const verification = await verifySolanaTx(tx_signature, expectedLamports);
    if (!verification.ok) return json({ error: verification.error, tx: tx_signature }, 400);

    // Verificar que esta tx no se haya usado antes
    const usedKey = `used:${tx_signature}`;
    const alreadyUsed = await LICENSES.get(usedKey);
    if (alreadyUsed) return json({ error: "Esta transacción ya fue registrada" }, 409);

    // Marcar como usada
    await LICENSES.put(usedKey, "1", { expirationTtl: 86400 * 365 });

    // Generar license key
    const licenseData = {
      wallet: RECEIVER_WALLET,
      plan,
      issued: Date.now(),
      exp: plan === "monthly" ? Date.now() + 30 * 86400 * 1000 : null,
      tx: tx_signature,
    };
    const sig = await signLicense(licenseData);
    const licenseKey = generateLicenseKey(licenseData, sig);

    // Guardar en KV
    await LICENSES.put(`license:${licenseKey}`, JSON.stringify(licenseData), {
      expirationTtl: plan === "monthly" ? 32 * 86400 : 365 * 86400 * 5
    });

    return json({ ok: true, license_key: licenseKey, plan, expires: licenseData.exp });
  }

  // ── POST /validate ──
  if (method === "POST" && path === "/validate") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON inválido" }, 400); }
    const { license_key } = body;
    if (!license_key) return json({ error: "Falta license_key" }, 400);

    // Verificar en KV primero (más rápido)
    const stored = await LICENSES.get(`license:${license_key}`);
    if (stored) {
      const data = JSON.parse(stored);
      if (data.exp && Date.now() > data.exp) return json({ ok: false, error: "Licencia expirada" }, 403);
      return json({ ok: true, plan: data.plan, issued: data.issued, exp: data.exp });
    }

    // Fallback: verificar firma directamente
    const data = await verifyLicenseKey(license_key);
    if (!data) return json({ ok: false, error: "License key inválida" }, 403);

    // Cachear en KV
    await LICENSES.put(`license:${license_key}`, JSON.stringify(data), {
      expirationTtl: data.exp ? Math.floor((data.exp - Date.now()) / 1000) + 86400 : 365 * 86400 * 5
    });

    return json({ ok: true, plan: data.plan, issued: data.issued, exp: data.exp });
  }

  // ── GET /admin/stats ──
  if (method === "GET" && path === "/admin/stats") {
    const adminSecret = url.searchParams.get("secret");
    const expectedSecret = process.env.ADMIN_SECRET ? process.env.ADMIN_SECRET : null;
    if (!expectedSecret || adminSecret !== expectedSecret) return json({ error: "No autorizado" }, 401);

    // Listar licenses activas (limitado a lo que KV permite listar)
    const list = await LICENSES.list({ prefix: "license:" });
    const active = [];
    for (const key of list.keys) {
      const val = JSON.parse(await LICENSES.get(key.name));
      if (!val.exp || val.exp > Date.now()) active.push(val);
    }
    return json({ total_licenses: list.keys.length, active_licenses: active.length });
  }

  return json({ error: "Not found" }, 404);
}

export default { fetch: handleRequest };
