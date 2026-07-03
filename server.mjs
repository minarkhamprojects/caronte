// server.mjs — Caronte: MCP para transferencia de archivos y operación remota
// Versión template lista para publicar.
//
// Tools: write_file, read_text, list_dir, make_dir, git_clone, transfer, run_command
// Guardrail: run_command bloquea comandos destructivos salvo confirm:"CONFIRMO".
//
// Toda la configuración vía variables de entorno — cero secretos en el código.

import express from "express";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile as _execFile, exec as _exec } from "node:child_process";
import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const execFile = promisify(_execFile);
const exec = promisify(_exec);

// ─────────────────────────── CONFIG (todo desde env) ───────────────────────────
const PORT = parseInt(process.env.CARONTE_PORT || "8788", 10);
const TOKEN = process.env.CARONTE_TOKEN;
if (!TOKEN) {
  console.error("Falta CARONTE_TOKEN en el entorno (.env). Aborto.");
  process.exit(1);
}

// Construye HOSTS desde variables de entorno.
// CARONTE_LOCAL_NAME — nombre del host local (default: "server")
// CARONTE_REMOTE_HOSTS — JSON array: [{"name":"laptop","ssh":"user@host"}]
const LOCAL_NAME = process.env.CARONTE_LOCAL_NAME || "server";
const HOSTS = {};
HOSTS[LOCAL_NAME] = { ssh: null, local: true };

const rawRemote = process.env.CARONTE_REMOTE_HOSTS || "[]";
let remoteHosts = [];
try { remoteHosts = JSON.parse(rawRemote); } catch { /* empty */ }
for (const r of remoteHosts) {
  if (r.name && r.ssh) {
    HOSTS[r.name] = { ssh: r.ssh, local: false };
  }
}

function ssh(host) {
  const h = HOSTS[host];
  if (!h) throw new Error(`host desconocido: ${host}. Válidos: ${Object.keys(HOSTS).join(", ")}`);
  return h.ssh;
}

const TIMEOUT = 600_000;
const MAXBUF = 16 * 1024 * 1024;

// ─────────────────── guardrail de comandos destructivos ───────────────────
// Cinturón de seguridad contra ACCIDENTES (borrados a ciegas, encadenados),
// aplica a TODOS los hosts. NO es una cárcel: un comando ofuscado a propósito
// (variables, base64, un script que por dentro borra) puede esquivarlo.
// Si matchea, run_command NO ejecuta salvo que la llamada traiga confirm:"CONFIRMO".
const DESTRUCTIVE = [
  /\brm\s+(-\w*\s+)*-\w*[rf]/i,                              // rm -rf, rm -fr, rm -r -f
  /\brm\s+--(recursive|force)\b/i,                          // rm --recursive / --force
  /\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)/i, // push forzado
  /\bgit\s+branch\s+-D\b/i,                                 // borrar rama forzado
  /\bgit\s+reset\s+--hard\b/i,                              // descarta cambios
  /\bgit\s+clean\b[^|;&]*-\w*[fd]/i,                        // borra untracked
  /\bfind\b[^|;&]*-delete\b/i,                              // find ... -delete
  /\bmkfs\b/i,                                              // formatear
  /\bdd\b[^|;&]*\bof=/i,                                    // dd of=...
  /\bshred\b/i,                                             // shred
];
function isDestructive(cmd) {
  return DESTRUCTIVE.some((re) => re.test(cmd));
}

// ─────────────────────────── helpers ───────────────────────────
async function runFixed(file, args) {
  const { stdout, stderr } = await execFile(file, args, { timeout: TIMEOUT, maxBuffer: MAXBUF });
  return (stdout || stderr || "").trim();
}
async function onHost(host, argv) {
  return HOSTS[host].local ? runFixed(argv[0], argv.slice(1)) : runFixed("ssh", [ssh(host), ...argv]);
}
const ok = (text) => ({ content: [{ type: "text", text }] });
const wrap = (fn) => async (a) => {
  try { return await fn(a); }
  catch (e) { return { content: [{ type: "text", text: "ERROR: " + (e.stderr || e.message || String(e)).toString().trim() }], isError: true }; }
};

// ─────────────────────────── server ───────────────────────────
function buildServer() {
  const s = new McpServer({ name: "caronte", version: "1.1.0" });

  s.tool("write_file",
    "Escribe contenido de texto en un archivo del equipo remoto. Crea carpetas padre si faltan.",
    { host: z.string(), path: z.string(), content: z.string() },
    wrap(async ({ host, path, content }) => {
      if (HOSTS[host]?.local) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, "utf8");
      } else {
        const tmp = join(tmpdir(), `ft-${randomUUID()}`);
        await writeFile(tmp, content, "utf8");
        try {
          await runFixed("ssh", [ssh(host), "mkdir", "-p", dirname(path)]);
          await runFixed("scp", ["-p", tmp, `${ssh(host)}:${path}`]);
        } finally { await rm(tmp, { force: true }); }
      }
      return ok(`OK escrito: ${host}:${path} (${Buffer.byteLength(content, "utf8")} bytes)`);
    }));

  s.tool("read_text",
    "Devuelve el contenido de un archivo de texto (con tope de bytes).",
    { host: z.string(), path: z.string(), max_bytes: z.number().int().positive().default(100_000) },
    wrap(async ({ host, path, max_bytes }) => {
      if (HOSTS[host]?.local) {
        const buf = await readFile(path);
        return ok(buf.subarray(0, max_bytes).toString("utf8"));
      }
      return ok(await runFixed("ssh", [ssh(host), "head", "-c", String(max_bytes), "--", path]));
    }));

  s.tool("list_dir",
    "Lista archivos en una ruta del equipo.",
    { host: z.string(), path: z.string() },
    wrap(async ({ host, path }) => ok(await onHost(host, ["ls", "-lah", path]))));

  s.tool("make_dir",
    "Crea una carpeta (recursivo, mkdir -p) en el equipo remoto.",
    { host: z.string(), path: z.string() },
    wrap(async ({ host, path }) => {
      await onHost(host, ["mkdir", "-p", path]);
      return ok(`OK carpeta: ${host}:${path}`);
    }));

  s.tool("git_clone",
    "Clona un repositorio de GitHub en el equipo remoto. dest = ruta absoluta.",
    { host: z.string(), repo_url: z.string(), dest: z.string().optional() },
    wrap(async ({ host, repo_url, dest }) => {
      const args = ["git", "clone", repo_url, ...(dest ? [dest] : [])];
      const out = await onHost(host, args);
      return ok(`OK clonado en ${host}.\n${out}`);
    }));

  s.tool("transfer",
    "Copia un archivo entre dos equipos vía scp (orquestado desde el servidor). Cualquier tipo de archivo.",
    { from_host: z.string(), from_path: z.string(), to_host: z.string(), to_path: z.string() },
    wrap(async ({ from_host, from_path, to_host, to_path }) => {
      const src = HOSTS[from_host]?.local ? from_path : `${ssh(from_host)}:${from_path}`;
      const dst = HOSTS[to_host]?.local ? to_path : `${ssh(to_host)}:${to_path}`;
      await runFixed("scp", ["-3", "-p", src, dst]);
      return ok(`OK: ${from_host}:${from_path} → ${to_host}:${to_path}`);
    }));

  s.tool("run_command",
    "Ejecuta un comando de shell completo en el equipo remoto (npm install, git pull, etc.). " +
    "Comandos destructivos (rm -rf, git push --force, git reset --hard, etc.) se RECHAZAN " +
    "salvo que se reenvíe la MISMA llamada con confirm:\"CONFIRMO\".",
    { host: z.string(), command: z.string(), confirm: z.string().optional() },
    wrap(async ({ host, command, confirm }) => {
      if (isDestructive(command) && confirm !== "CONFIRMO") {
        return ok(
          `⛔ COMANDO DESTRUCTIVO BLOQUEADO en "${host}":\n\n  ${command}\n\n` +
          `No se ejecutó. Verifica el comando y, si es correcto, reenvía la MISMA llamada ` +
          `agregando confirm:"CONFIRMO".`
        );
      }
      if (HOSTS[host]?.local) {
        const { stdout, stderr } = await exec(command, { timeout: TIMEOUT, maxBuffer: MAXBUF });
        return ok((stdout || stderr || "").trim() || "(sin salida)");
      }
      return ok(await runFixed("ssh", [ssh(host), command]) || "(sin salida)");
    }));

  return s;
}

// ─────────────────────────── HTTP ───────────────────────────
const app = express();
app.use(express.json({ limit: "25mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, name: "caronte" }));

function getToken(req) {
  const auth = req.headers.authorization || "";
  const headerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  return headerToken || req.query.key || req.query.token || null;
}

app.post("/mcp", async (req, res) => {
  if (getToken(req) !== TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e) });
  }
});
app.get("/mcp", (_req, res) => res.status(405).end());
app.delete("/mcp", (_req, res) => res.status(405).end());

app.listen(PORT, "127.0.0.1", () => console.log(`caronte en http://127.0.0.1:${PORT}/mcp`));
