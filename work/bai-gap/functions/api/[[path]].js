const ROLES = ["Admin", "Assessor", "Viewer"];
const SESSION_SECONDS = 28800;
const enc = new TextEncoder();

function reply(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}
function getCookie(request, name) {
  const pair = (request.headers.get("Cookie") || "").split(";").map(v => v.trim()).find(v => v.startsWith(name + "="));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}
function hex(buffer) { return [...new Uint8Array(buffer)].map(v => v.toString(16).padStart(2, "0")).join(""); }
function randomToken() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
async function sha256(value) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(value))); }
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 310000, hash: "SHA-256" }, key, 256));
}
async function audit(db, actor, action, entity, entityId = null, details = null) {
  // Public workspace has no corresponding users row; keep audit history without a user FK.
  const userId = actor && actor.id !== "public-workspace" ? actor.id : null;
  await db.prepare("INSERT INTO audit_logs (user_id,username,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)")
    .bind(userId, actor ? actor.username : "system", action, entity, entityId, details ? JSON.stringify(details) : null).run();
}
async function getUser(request, env) {
  const token = getCookie(request, "bai_gap_session");
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.GAP_ANALYSIS_DB.prepare("SELECT u.id,u.username,u.display_name,u.role,u.active,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?").bind(tokenHash).first();
  if (!row || !row.active || row.expires_at < Math.floor(Date.now() / 1000)) {
    await env.GAP_ANALYSIS_DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(tokenHash).run();
    return null;
  }
  return row;
}
async function body(request) { try { return await request.json(); } catch { return null; } }
function validText(v, max) { return typeof v === "string" && v.trim().length > 0 && v.length <= max; }
function validGap(b) {
  return b && validText(b.title,150) && validText(b.actual_condition,1000) && validText(b.ideal_condition,1000) && validText(b.domain,80) && validText(b.owner,120) && validText(b.due,20) && validText(b.action,2000) &&
    ["Kritis","Tinggi","Sedang","Rendah"].includes(b.priority) &&
    ["Belum dimulai","Dalam proses","Selesai"].includes(b.status) &&
    Number.isFinite(Number(b.actual)) && Number.isFinite(Number(b.target)) &&
    Number(b.actual) >= 1 && Number(b.actual) <= 5 && Number(b.target) >= 1 && Number(b.target) <= 5 && Number(b.actual) <= Number(b.target);
}
function setCookie(token, age = SESSION_SECONDS) {
  return "bai_gap_session=" + encodeURIComponent(token) + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + age;
}

async function handleRequest({ request, env }) {
  if (!env.GAP_ANALYSIS_DB) return reply({ error: "Binding D1 GAP_ANALYSIS_DB belum dikonfigurasi." }, 503);

  // Safely bootstrap missing tables without dropping or overwriting existing production data.
  // This also recovers installations where the Worker was deployed before D1 migrations ran.
  const db = env.GAP_ANALYSIS_DB;
  await db.prepare(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('Admin','Assessor','Viewer')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS gaps (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, domain TEXT NOT NULL,
    actual REAL NOT NULL CHECK(actual>=1 AND actual<=5), target REAL NOT NULL CHECK(target>=1 AND target<=5),
    priority TEXT NOT NULL CHECK(priority IN ('Kritis','Tinggi','Sedang','Rendah')),
    owner TEXT NOT NULL, due TEXT NOT NULL, action TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('Belum dimulai','Dalam proses','Selesai')),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now')),
    actual_condition TEXT NOT NULL DEFAULT '', ideal_condition TEXT NOT NULL DEFAULT ''
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES users(id), username TEXT NOT NULL,
    action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, details TEXT,
    created_at TEXT NOT NULL DEFAULT(datetime('now'))
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_gaps_status ON gaps(status)").run();

  // Add fields to older installations while preserving all existing assessments.
  const gapColumns = await db.prepare("PRAGMA table_info(gaps)").all();
  const existingColumns = new Set((gapColumns.results || []).map(column => column.name));
  if (!existingColumns.has("actual_condition")) {
    try {
      await env.GAP_ANALYSIS_DB.prepare("ALTER TABLE gaps ADD COLUMN actual_condition TEXT NOT NULL DEFAULT ''").run();
    } catch (error) {
      const check = await env.GAP_ANALYSIS_DB.prepare("PRAGMA table_info(gaps)").all();
      if (!(check.results || []).some(column => column.name === "actual_condition")) throw error;
    }
  }
  if (!existingColumns.has("ideal_condition")) {
    try {
      await env.GAP_ANALYSIS_DB.prepare("ALTER TABLE gaps ADD COLUMN ideal_condition TEXT NOT NULL DEFAULT ''").run();
    } catch (error) {
      const check = await env.GAP_ANALYSIS_DB.prepare("PRAGMA table_info(gaps)").all();
      if (!(check.results || []).some(column => column.name === "ideal_condition")) throw error;
    }
  }

  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "") || "/", method = request.method.toUpperCase();

  if (!["GET","HEAD","OPTIONS"].includes(method)) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return reply({ error: "Origin tidak diizinkan." }, 403);
  }
  if (path === "/api/health" && method === "GET") return reply({ status: "ok", service: "bai-gap-api" });

  if (path === "/api/setup/status" && method === "GET") {
    const count = await env.GAP_ANALYSIS_DB.prepare("SELECT COUNT(*) AS total FROM users").first();
    return reply({ needsSetup: Number(count.total) === 0 });
  }

  if (path === "/api/setup/admin" && method === "POST") {
    const count = await env.GAP_ANALYSIS_DB.prepare("SELECT COUNT(*) AS total FROM users").first();
    if (count.total > 0) return reply({ error: "Admin awal sudah dibuat." }, 409);
    const b = await body(request);
    if (!env.BOOTSTRAP_SECRET || !b || b.bootstrapSecret !== env.BOOTSTRAP_SECRET) return reply({ error: "Bootstrap secret tidak valid." }, 403);
    if (!validText(b.username,60) || !validText(b.displayName,120) || typeof b.password !== "string" || b.password.length < 12 || b.password.length > 128)
      return reply({ error: "Username/nama wajib diisi dan password admin minimal 12 karakter." }, 400);
    const salt = randomToken(), id = crypto.randomUUID(), hash = await hashPassword(b.password,salt);
    try {
      const created = await env.GAP_ANALYSIS_DB.prepare("INSERT INTO users (id,username,display_name,password_hash,password_salt,role) SELECT ?,?,?,?,?, 'Admin' WHERE NOT EXISTS (SELECT 1 FROM users)")
        .bind(id,b.username.trim(),b.displayName.trim(),hash,salt).run();
      if (!created.meta || created.meta.changes !== 1) return reply({ error: "Admin awal sudah dibuat." }, 409);
    } catch { return reply({ error: "Username sudah digunakan atau data tidak valid." }, 409); }
    await audit(env.GAP_ANALYSIS_DB,{id,username:b.username.trim()},"CREATE_INITIAL_ADMIN","user",id);
    return reply({ message: "Admin awal berhasil dibuat. Silakan login." },201);
  }

  if (path === "/api/auth/login" && method === "POST") {
    const b = await body(request);
    if (!b || !validText(b.username,60) || typeof b.password !== "string" || b.password.length > 128) return reply({error:"Username atau password salah."},400);
    const u = await env.GAP_ANALYSIS_DB.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").bind(b.username.trim()).first();
    if (!u || !u.active || await hashPassword(b.password,u.password_salt) !== u.password_hash) return reply({error:"Username atau password salah."},401);
    const token = randomToken(), tokenHash = await sha256(token), expires = Math.floor(Date.now()/1000)+SESSION_SECONDS;
    await env.GAP_ANALYSIS_DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Math.floor(Date.now()/1000)).run();
    await env.GAP_ANALYSIS_DB.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)").bind(tokenHash,u.id,expires).run();
    await audit(env.GAP_ANALYSIS_DB,u,"LOGIN","session");
    return reply({user:{id:u.id,username:u.username,displayName:u.display_name,role:u.role}},200,{"set-cookie":setCookie(token)});
  }

  if (path === "/api/auth/logout" && method === "POST") {
    const token = getCookie(request,"bai_gap_session");
    if (token) await env.GAP_ANALYSIS_DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return reply({message:"Logout berhasil."},200,{"set-cookie":setCookie("",0)});
  }

  // Public internal workspace mode: no login/session is required.
  // Keep the legacy created_by foreign key valid without requiring a schema migration.
  // INSERT OR IGNORE makes initialization safe when requests arrive concurrently.
  const workspaceId = "public-workspace";
  await env.GAP_ANALYSIS_DB.prepare(
    "INSERT OR IGNORE INTO users (id,username,display_name,password_hash,password_salt,role,active) VALUES (?,?,?,?,?,'Assessor',1)"
  ).bind(workspaceId, "bai-public-workspace", "Workspace", randomToken(), randomToken()).run();
  // Resolve the actual row after INSERT OR IGNORE: a pre-existing unique username
  // must never leave created_by pointing at a non-existent user ID.
  const workspaceRow = await env.GAP_ANALYSIS_DB.prepare(
    "SELECT id FROM users WHERE id=? OR username=? COLLATE NOCASE LIMIT 1"
  ).bind(workspaceId, "bai-public-workspace").first();
  if (!workspaceRow) throw new Error("Public workspace user could not be initialized in D1.");
  const user = { id: workspaceRow.id, username: "workspace", display_name: "Workspace", role: "Assessor", active: 1 };
  if (path === "/api/auth/me" && method === "GET")
    return reply({user:{id:user.id,username:user.username,displayName:user.display_name,role:user.role}});

  if (path === "/api/gaps" && method === "GET") {
    const {results} = await env.GAP_ANALYSIS_DB.prepare("SELECT id,title,domain,actual_condition,ideal_condition,actual,target,priority,owner,due,action,status,created_at,updated_at FROM gaps ORDER BY created_at DESC").all();
    return reply({data:results});
  }
  if (path === "/api/gaps" && method === "POST") {
    if (!["Admin","Assessor"].includes(user.role)) return reply({error:"Viewer hanya memiliki akses baca."},403);
    const b = await body(request);
    if (!validGap(b)) return reply({error:"Data assessment tidak lengkap atau tidak valid."},400);
    const id=crypto.randomUUID();
    await env.GAP_ANALYSIS_DB.prepare("INSERT INTO gaps (id,title,domain,actual_condition,ideal_condition,actual,target,priority,owner,due,action,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id,b.title.trim(),b.domain,b.actual_condition.trim(),b.ideal_condition.trim(),Number(b.actual),Number(b.target),b.priority,b.owner.trim(),b.due,b.action.trim(),b.status,user.id).run();
    await audit(env.GAP_ANALYSIS_DB,user,"CREATE","gap",id,{title:b.title,priority:b.priority});
    return reply({id,message:"Assessment disimpan."},201);
  }

  const gap = path.match(/^\/api\/gaps\/([a-f0-9-]+)$/i);
  if (gap && ["PUT","PATCH","DELETE"].includes(method)) {
    if (!["Admin","Assessor"].includes(user.role)) return reply({error:"Viewer hanya memiliki akses baca."},403);
    const id=gap[1], exists=await env.GAP_ANALYSIS_DB.prepare("SELECT id FROM gaps WHERE id=?").bind(id).first();
    if (!exists) return reply({error:"Assessment tidak ditemukan."},404);
    if (method==="DELETE") {
      // Assessor dapat menghapus temuan pada workspace operasional; Viewer tetap read-only.
      await env.GAP_ANALYSIS_DB.prepare("DELETE FROM gaps WHERE id=?").bind(id).run();
      await audit(env.GAP_ANALYSIS_DB,user,"DELETE","gap",id);
      return reply({message:"Assessment dihapus."});
    }
    const b=await body(request);
    if (!validGap(b)) return reply({error:"Data assessment tidak valid."},400);
    await env.GAP_ANALYSIS_DB.prepare("UPDATE gaps SET title=?,domain=?,actual_condition=?,ideal_condition=?,actual=?,target=?,priority=?,owner=?,due=?,action=?,status=?,updated_at=datetime('now') WHERE id=?")
      .bind(b.title.trim(),b.domain,b.actual_condition.trim(),b.ideal_condition.trim(),Number(b.actual),Number(b.target),b.priority,b.owner.trim(),b.due,b.action.trim(),b.status,id).run();
    await audit(env.GAP_ANALYSIS_DB,user,"UPDATE","gap",id,{title:b.title,status:b.status});
    return reply({message:"Assessment diperbarui."});
  }

  if (path === "/api/users" && method === "GET") {
    if (user.role!=="Admin") return reply({error:"Akses khusus Admin."},403);
    const {results}=await env.GAP_ANALYSIS_DB.prepare("SELECT id,username,display_name AS displayName,role,active,created_at AS createdAt FROM users ORDER BY created_at DESC").all();
    return reply({data:results});
  }
  if (path === "/api/users" && method === "POST") {
    if (user.role!=="Admin") return reply({error:"Akses khusus Admin."},403);
    const b=await body(request);
    if (!b || !validText(b.username,60) || !validText(b.displayName,120) || typeof b.password!=="string" || b.password.length<12 || b.password.length>128 || !ROLES.includes(b.role))
      return reply({error:"Isi username, nama, role, dan password minimal 12 karakter."},400);
    const salt=randomToken(),id=crypto.randomUUID(),hash=await hashPassword(b.password,salt);
    try { await env.GAP_ANALYSIS_DB.prepare("INSERT INTO users (id,username,display_name,password_hash,password_salt,role) VALUES (?,?,?,?,?,?)").bind(id,b.username.trim(),b.displayName.trim(),hash,salt,b.role).run(); }
    catch { return reply({error:"Username sudah digunakan."},409); }
    await audit(env.GAP_ANALYSIS_DB,user,"CREATE","user",id,{username:b.username,role:b.role});
    return reply({id,message:"Pengguna dibuat."},201);
  }
  const userRoute=path.match(/^\/api\/users\/([a-f0-9-]+)$/i);
  if (userRoute && ["PATCH","DELETE"].includes(method)) {
    if (user.role!=="Admin") return reply({error:"Akses khusus Admin."},403);
    const id=userRoute[1];
    if (id===user.id) return reply({error:"Admin tidak dapat menonaktifkan akunnya sendiri."},400);
    const target=await env.GAP_ANALYSIS_DB.prepare("SELECT id FROM users WHERE id=?").bind(id).first();
    if (!target) return reply({error:"Pengguna tidak ditemukan."},404);
    if (method==="DELETE") {
      await env.GAP_ANALYSIS_DB.prepare("UPDATE users SET active=0,updated_at=datetime('now') WHERE id=?").bind(id).run();
      await env.GAP_ANALYSIS_DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(id).run();
      await audit(env.GAP_ANALYSIS_DB,user,"DISABLE","user",id);
      return reply({message:"Pengguna dinonaktifkan."});
    }
    const b=await body(request);
    if (!b || !ROLES.includes(b.role) || typeof b.active!=="boolean") return reply({error:"Role atau status pengguna tidak valid."},400);
    await env.GAP_ANALYSIS_DB.prepare("UPDATE users SET role=?,active=?,updated_at=datetime('now') WHERE id=?").bind(b.role,b.active?1:0,id).run();
    if (!b.active) await env.GAP_ANALYSIS_DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(id).run();
    await audit(env.GAP_ANALYSIS_DB,user,"UPDATE","user",id,{role:b.role,active:b.active});
    return reply({message:"Hak akses diperbarui."});
  }
  if (path==="/api/audit" && method==="GET") {
    if (user.role!=="Admin") return reply({error:"Akses khusus Admin."},403);
    const {results}=await env.GAP_ANALYSIS_DB.prepare("SELECT id,username,action,entity,entity_id AS entityId,details,created_at AS createdAt FROM audit_logs ORDER BY id DESC LIMIT 300").all();
    return reply({data:results});
  }
  return reply({error:"Endpoint tidak ditemukan."},404);
}

export async function onRequest(context) {
  try {
    return await handleRequest(context);
  } catch (error) {
    // Always return JSON so the client can display a useful, consistent error.
    console.error("BAI Gap API failure:", error);
    return reply({ error: "Terjadi kesalahan pada server saat memproses permintaan. Silakan coba kembali." }, 500);
  }
}
