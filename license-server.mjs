// license-server.mjs — Valida pagos en Solana y genera license keys para Caronte.
// Corre en la Mini como pm2, expuesto vía license.minpeniche.com.
//
// Endpoints:
//   GET  /pricing        — Precios + wallet
//   POST /register       — Registra pago, devuelve license key
//   POST /validate       — setup.sh valida license key
//   GET  /admin/stats    — Estadísticas (?secret=...)

import http from "node:http";
import { randomUUID, createHmac } from "node:crypto";

// ─── CONFIG ───
const PORT = 8789;
const RECEIVER_WALLET = "CkCpT39KtrSYs4bZcnM2NQFtucodnh8ynV4UuPWCJDw";
const LICENSE_SECRET=process.env.LICENSE_SECRET || randomUUID().replace(/-/g, "");
const ADMIN_SECRET=process.env.ADMIN_SECRET || null;
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

const PRICING = {
  one_time: { label: "Pago único — licencia perpetua",    sol: 0.1,  usdc: 19 },
  monthly:  { label: "Suscripción mensual",               sol: 0.03, usdc: 5  },
};

// ─── Almacén en memoria (se pierde al reiniciar, pero es para empezar) ───
const licenseStore = new Map();  // licenseKey → {plan, issued, exp, wallet}
const usedTx = new Set();       // tx signatures ya usadas

// ─── HELPERS ───
function b64url(s) { return Buffer.from(s).toString("base64url"); }
function b64urlDecode(s) { return Buffer.from(s, "base64url").toString(); }

function signLicense(data) {
  const hmac = createHmac("sha256", LICENSE_SECRET);
  hmac.update(JSON.stringify(data));
  return hmac.digest("base64url");
}

function generateLicenseKey(data) {
  const payload = b64url(JSON.stringify(data));
  const sig = signLicense(data);
  return `${payload}.${sig}`;
}

function parseLicenseKey(key) {
  try {
    const parts = key.split(".");
    if (parts.length !== 2) return null;
    const data = JSON.parse(b64urlDecode(parts[0]));
    return { data, sig: parts[1] };
  } catch {
    return null;
  }
}

function verifyLicenseKey(key) {
  const parsed = parseLicenseKey(key);
  if (!parsed) return null;
  const expectedSig = signLicense(parsed.data);
  if (parsed.sig !== expectedSig) return null;
  if (parsed.data.exp && Date.now() > parsed.data.exp) return null;
  return parsed.data;
}

// ─── SOLANA TX VERIFICATION ───
async function verifySolanaTx(signature, expectedLamports) {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1,
    method: "getTransaction",
    params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]
  });
  const resp = await fetch(SOLANA_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  const json = await resp.json();
  if (!json.result) return { ok: false, error: "Transacción no encontrada o no confirmada" };

  const tx = json.result;
  const accountKeys = tx.transaction?.message?.accountKeys || [];
  const postBalances = tx.meta?.postBalances || [];
  const preBalances = tx.meta?.preBalances || [];

  const receiverIdx = accountKeys.findIndex(k => k === RECEIVER_WALLET);
  if (receiverIdx === -1) return { ok: false, error: "Wallet destino no coincide" };

  const amount = postBalances[receiverIdx] - preBalances[receiverIdx];
  // Por ahora solo verificamos que haya recibido ALGO (no el monto exacto)
  // porque el pago puede ser de SOL o USDC, y las cuentas de token son diferentes.
  // Para producción: verificar transferencia de token USDC o usar método más preciso.
  if (amount <= 0) return { ok: false, error: "Monto inválido o no detectado" };

  return { ok: true, amount, slot: tx.slot, signature };
}

// ─── HTTP SERVER ───
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const method = req.method;
  const path = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") return res.writeHead(204).end();

  const json = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  };

  // Leer body para POST
  const readBody = () => new Promise((resolve) => {
    if (method !== "POST") return resolve(null);
    let b = "";
    req.on("data", c => b += c);
    req.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  });

  // ── GET /pricing ──
  if (method === "GET" && path === "/pricing") {
    return json({
      product: "caronte",
      wallet: RECEIVER_WALLET,
      chain: "solana",
      plans: PRICING,
      instructions: "Envía SOL a la wallet, luego POST /register con tx_signature y plan (one_time|monthly)."
    });
  }

  // ── POST /register ──
  if (method === "POST" && path === "/register") {
    const body = await readBody();
    if (!body) return json({ error: "JSON inválido" }, 400);
    const { tx_signature, plan } = body;
    if (!tx_signature) return json({ error: "Falta tx_signature" }, 400);
    if (!plan || !PRICING[plan]) return json({ error: "Plan inválido: " + Object.keys(PRICING).join(", ") }, 400);

    if (usedTx.has(tx_signature)) return json({ error: "Transacción ya usada" }, 409);
    usedTx.add(tx_signature);

    const expectedLamports = Math.floor(PRICING[plan].sol * 1_000_000_000);
    const verification = await verifySolanaTx(tx_signature, expectedLamports);
    if (!verification.ok) return json({ error: verification.error, tx: tx_signature }, 400);

    const licenseData = {
      wallet: RECEIVER_WALLET,
      plan,
      issued: Date.now(),
      exp: plan === "monthly" ? Date.now() + 30 * 86400 * 1000 : null,
      tx: tx_signature,
    };
    const licenseKey = generateLicenseKey(licenseData);
    licenseStore.set(licenseKey, licenseData);

    return json({ ok: true, license_key: licenseKey, plan, expires: licenseData.exp });
  }

  // ── POST /validate ──
  if (method === "POST" && path === "/validate") {
    const body = await readBody();
    if (!body) return json({ error: "JSON inválido" }, 400);
    const { license_key } = body;
    if (!license_key) return json({ error: "Falta license_key" }, 400);

    // Revisar store primero
    if (licenseStore.has(license_key)) {
      const data = licenseStore.get(license_key);
      if (data.exp && Date.now() > data.exp) return json({ ok: false, error: "Licencia expirada" }, 403);
      return json({ ok: true, plan: data.plan, issued: data.issued, exp: data.exp });
    }

    // Fallback: verificar firma
    const data = verifyLicenseKey(license_key);
    if (!data) return json({ ok: false, error: "License key inválida" }, 403);
    licenseStore.set(license_key, data);
    return json({ ok: true, plan: data.plan, issued: data.issued, exp: data.exp });
  }

  // ── GET /admin/stats ──
  if (method === "GET" && path === "/admin/stats") {
    const secret = url.searchParams.get("secret");
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) return json({ error: "No autorizado" }, 401);
    const active = [...licenseStore.values()].filter(d => !d.exp || d.exp > Date.now());
    return json({ total: licenseStore.size, active: active.length });
  }

  return json({ error: "Not found" }, 404);
}

const server = http.createServer(handleRequest);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`license-server en http://127.0.0.1:${PORT}`);
  console.log(`Wallet: ${RECEIVER_WALLET}`);
  console.log(`ADMIN_SECRET: ${ADMIN_SECRET ? "configurado" : "NO configurado — /admin/stats deshabilitado"}`);
});
