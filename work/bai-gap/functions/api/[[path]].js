const ROLES = ["Admin", "Assessor", "Viewer"];
const USER_ROLES = ["Assessor", "Viewer"];
const GAP_DOMAINS = ["Jaringan","Server & Virtualisasi","Keamanan","Backup & Recovery","Data Center","Monitoring","Dokumentasi","Administrasi"];
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
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" }, key, 256));
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
  const row = await env.GAP_ANALYSIS_DB.prepare("SELECT u.id,u.username,u.display_name,CASE WHEN COALESCE(u.is_super_admin,0)=1 THEN 'Super Admin' ELSE u.role END AS role,COALESCE(u.is_super_admin,0) AS is_super_admin,u.active,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?").bind(tokenHash).first();
  if (!row || !row.active || row.expires_at < Math.floor(Date.now() / 1000)) {
    await env.GAP_ANALYSIS_DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(tokenHash).run();
    return null;
  }
  return row;
}
async function body(request) { try { return await request.json(); } catch { return null; } }
function validText(v, max) { return typeof v === "string" && v.trim().length > 0 && v.length <= max; }
function validGap(b) {
  return b && validText(b.title,150) && validText(b.actual_condition,1000) && validText(b.ideal_condition,1000) && GAP_DOMAINS.includes(b.domain) && validText(b.owner,120) && validText(b.start_date,10) && validText(b.due,10) && b.start_date <= b.due && validText(b.action,2000) &&
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
    is_super_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_super_admin IN (0,1)),
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
    owner TEXT NOT NULL, start_date TEXT NOT NULL DEFAULT '', due TEXT NOT NULL, action TEXT NOT NULL,
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
  const userColumns = await db.prepare("PRAGMA table_info(users)").all();
  if (!(userColumns.results || []).some(column => column.name === "is_super_admin")) await db.prepare("ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0").run();
  await db.prepare("UPDATE users SET is_super_admin=1 WHERE id=(SELECT id FROM users WHERE role='Admin' AND username<>'bai-public-workspace' ORDER BY created_at ASC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM users WHERE is_super_admin=1)").run();
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
  if (!existingColumns.has("start_date")) {
    await db.prepare("ALTER TABLE gaps ADD COLUMN start_date TEXT NOT NULL DEFAULT ''").run();
    await db.prepare("UPDATE gaps SET start_date=substr(created_at,1,10) WHERE start_date=''").run();
  }

  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "") || "/", method = request.method.toUpperCase();

  if (!["GET","HEAD","OPTIONS"].includes(method)) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return reply({ error: "Origin tidak diizinkan." }, 403);
  }
  if (path === "/api/health" && method === "GET") return reply({ status: "ok", service: "bai-gap-api" });

  if (path === "/api/setup/status" && method === "GET") {
    const count = await env.GAP_ANALYSIS_DB.prepare("SELECT COUNT(*) AS total FROM users WHERE username <> 'bai-public-workspace'").first();
    return reply({ needsSetup: Number(count.total) === 0 });
  }

  if (path === "/api/setup/admin" && method === "POST") {
    try {
      const count = await env.GAP_ANALYSIS_DB.prepare("SELECT COUNT(*) AS total FROM users WHERE username <> 'bai-public-workspace'").first();
      if (Number(count && count.total) > 0) return reply({ error: "Admin awal sudah dibuat." }, 409);
      const b = await body(request);
      if (!env.BOOTSTRAP_SECRET) return reply({ error: "BOOTSTRAP_SECRET belum dikonfigurasi pada Cloudflare Worker." }, 503);
      if (!b || b.bootstrapSecret !== env.BOOTSTRAP_SECRET) return reply({ error: "Bootstrap secret tidak valid. Pastikan nilainya sama dengan BOOTSTRAP_SECRET di Cloudflare." }, 403);
      if (!validText(b.username,60) || !validText(b.displayName,120) || typeof b.password !== "string" || b.password.length < 12 || b.password.length > 128)
        return reply({ error: "Username/nama wajib diisi dan password admin minimal 12 karakter." }, 400);
      const salt = randomToken(), id = crypto.randomUUID(), hash = await hashPassword(b.password,salt);
      const created = await env.GAP_ANALYSIS_DB.prepare("INSERT INTO users (id,username,display_name,password_hash,password_salt,role,is_super_admin) SELECT ?,?,?,?,?, 'Admin',1 WHERE NOT EXISTS (SELECT 1 FROM users WHERE username <> 'bai-public-workspace')")
        .bind(id,b.username.trim(),b.displayName.trim(),hash,salt).run();
      if (!created.meta || Number(created.meta.changes) !== 1) return reply({ error: "Admin awal sudah dibuat atau username sudah digunakan." }, 409);
      try { await audit(env.GAP_ANALYSIS_DB,{id,username:b.username.trim()},"CREATE_INITIAL_ADMIN","user",id); }
      catch (auditError) { console.error("Initial admin audit write failed:", auditError); }
      return reply({ message: "Admin awal berhasil dibuat. Silakan login." },201);
    } catch (error) {
      console.error("Initial administrator setup failed:", error);
      return reply({ error: "Pendaftaran Administrator gagal diproses.", detail: String(error && error.message || error).slice(0,240) }, 500);
    }
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
    return reply({user:{id:u.id,username:u.username,displayName:u.display_name,role:u.is_super_admin?"Super Admin":u.role,isSuperAdmin:!!u.is_super_admin}},200,{"set-cookie":setCookie(token)});
  }

  if (path === "/api/auth/logout" && method === "POST") {
    const token = getCookie(request,"bai_gap_session");
    if (token) await env.GAP_ANALYSIS_DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return reply({message:"Logout berhasil."},200,{"set-cookie":setCookie("",0)});
  }

  const sessionUser = await getUser(request, env);
  if (path === "/api/auth/me" && method === "GET") {
    if (!sessionUser) return reply({error:"Sesi login tidak ditemukan. Silakan login."},401);
    return reply({user:{id:sessionUser.id,username:sessionUser.username,displayName:sessionUser.display_name,role:sessionUser.role,isSuperAdmin:!!sessionUser.is_super_admin}});
  }
  if (!sessionUser) return reply({error:"Login diperlukan untuk mengakses aplikasi."},401);
  const user = {id:sessionUser.id,username:sessionUser.username,display_name:sessionUser.display_name,role:sessionUser.role,is_super_admin:!!sessionUser.is_super_admin,active:sessionUser.active};
  const isSuperAdmin = user.role === "Super Admin";
  const canManageUsers = isSuperAdmin || user.role === "Admin";
  if (path === "/api/gaps/import" && method === "POST") {
    if (!["Admin","Assessor"].includes(user.role)) return reply({error:"Viewer hanya memiliki akses baca."},403);
    const b = await body(request);
    if (!b || !Array.isArray(b.rows) || b.rows.length < 1) return reply({error:"File tidak berisi data assessment."},400);
    if (b.rows.length > 100) return reply({error:"Maksimal 100 temuan per sekali import. Pecah file menjadi beberapa bagian."},400);
    const errors = [];
    b.rows.forEach((row,index) => { if (!validGap(row)) errors.push({row:index+2,error:"Data wajib tidak lengkap atau format/nilai tidak valid."}); });
    if (errors.length) return reply({error:"Import dibatalkan. Perbaiki baris yang ditandai lalu unggah ulang.",details:errors},400);
    const statements = b.rows.map(row => db.prepare("INSERT INTO gaps (id,title,domain,actual_condition,ideal_condition,actual,target,priority,owner,start_date,due,action,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(),row.title.trim(),row.domain.trim(),row.actual_condition.trim(),row.ideal_condition.trim(),Number(row.actual),Number(row.target),row.priority,row.owner.trim(),row.start_date,row.due,row.action.trim(),row.status,user.id));
    await db.batch(statements);
    await audit(db,user,"IMPORT","gap",null,{count:b.rows.length,filename:validText(b.filename,120)?b.filename:"uploaded-file"});
    return reply({message:"Import berhasil.",imported:b.rows.length},201);
  }

  if (path === "/api/gaps" && method === "GET") {
    const {results} = await env.GAP_ANALYSIS_DB.prepare("SELECT id,title,domain,actual_condition,ideal_condition,actual,target,priority,owner,start_date,due,due AS finish_date,action,status,created_at,updated_at FROM gaps ORDER BY created_at DESC").all();
    return reply({data:results});
  }
  if (path === "/api/gaps" && method === "POST") {
    if (!["Admin","Assessor"].includes(user.role)) return reply({error:"Viewer hanya memiliki akses baca."},403);
    const b = await body(request);
    if (!validGap(b)) return reply({error:"Data assessment tidak lengkap atau tidak valid."},400);
    const id=crypto.randomUUID();
    await env.GAP_ANALYSIS_DB.prepare("INSERT INTO gaps (id,title,domain,actual_condition,ideal_condition,actual,target,priority,owner,start_date,due,action,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id,b.title.trim(),b.domain,b.actual_condition.trim(),b.ideal_condition.trim(),Number(b.actual),Number(b.target),b.priority,b.owner.trim(),b.start_date,b.due,b.action.trim(),b.status,user.id).run();
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
    await env.GAP_ANALYSIS_DB.prepare("UPDATE gaps SET title=?,domain=?,actual_condition=?,ideal_condition=?,actual=?,target=?,priority=?,owner=?,start_date=?,due=?,action=?,status=?,updated_at=datetime('now') WHERE id=?")
      .bind(b.title.trim(),b.domain,b.actual_condition.trim(),b.ideal_condition.trim(),Number(b.actual),Number(b.target),b.priority,b.owner.trim(),b.start_date,b.due,b.action.trim(),b.status,id).run();
    await audit(env.GAP_ANALYSIS_DB,user,"UPDATE","gap",id,{title:b.title,status:b.status});
    return reply({message:"Assessment diperbarui."});
  }

  if (path === "/api/users" && method === "GET") {
    if (!["Admin","Super Admin"].includes(user.role)) return reply({error:"Akses khusus Administrator."},403);
    const {results}=await env.GAP_ANALYSIS_DB.prepare("SELECT id,username,display_name AS displayName,CASE WHEN COALESCE(is_super_admin,0)=1 THEN 'Super Admin' ELSE role END AS role,active,created_at AS createdAt FROM users ORDER BY created_at DESC").all();
    return reply({data:results});
  }
  if (path === "/api/users" && method === "POST") {
    if (!["Admin","Super Admin"].includes(user.role)) return reply({error:"Akses khusus Administrator."},403);
    const b=await body(request);
    const allowedRoles = user.role === "Super Admin" ? ROLES : USER_ROLES;
    if (!b || !validText(b.username,60) || !validText(b.displayName,120) || typeof b.password!=="string" || b.password.length<12 || b.password.length>128 || !allowedRoles.includes(b.role))
      return reply({error:user.role==="Super Admin"?"Data akun tidak valid.":"Administrator hanya dapat membuat akun User (Assessor/Viewer)."},400);
    const salt=randomToken(),id=crypto.randomUUID(),hash=await hashPassword(b.password,salt);
    try { await env.GAP_ANALYSIS_DB.prepare("INSERT INTO users (id,username,display_name,password_hash,password_salt,role,is_super_admin) VALUES (?,?,?,?,?,?,0)").bind(id,b.username.trim(),b.displayName.trim(),hash,salt,b.role).run(); }
    catch { return reply({error:"Username sudah digunakan."},409); }
    await audit(env.GAP_ANALYSIS_DB,user,"CREATE","user",id,{username:b.username,role:b.role});
    return reply({id,message:"Pengguna dibuat."},201);
  }
  const userRoute=path.match(/^\/api\/users\/([a-f0-9-]+)$/i);
  if (userRoute && ["PATCH","DELETE"].includes(method)) {
    if (!["Admin","Super Admin"].includes(user.role)) return reply({error:"Akses khusus Administrator."},403);
    const id=userRoute[1];
    if (id===user.id) return reply({error:"Admin tidak dapat menonaktifkan akunnya sendiri."},400);
    const target=await env.GAP_ANALYSIS_DB.prepare("SELECT id,is_super_admin FROM users WHERE id=?").bind(id).first();
    if (!target) return reply({error:"Pengguna tidak ditemukan."},404);
    if (target.is_super_admin && user.role!=="Super Admin") return reply({error:"Hanya Super Admin yang dapat mengelola akun Super Admin."},403);
    if (method==="DELETE") {
      await env.GAP_ANALYSIS_DB.prepare("UPDATE users SET active=0,updated_at=datetime('now') WHERE id=?").bind(id).run();
      await env.GAP_ANALYSIS_DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(id).run();
      await audit(env.GAP_ANALYSIS_DB,user,"DISABLE","user",id);
      return reply({message:"Pengguna dinonaktifkan."});
    }
    const b=await body(request);
    const allowedRoles = user.role === "Super Admin" ? ROLES : USER_ROLES;
    if (!b || !allowedRoles.includes(b.role) || typeof b.active!=="boolean") return reply({error:"Role atau status pengguna tidak valid atau tidak diizinkan."},400);
    await env.GAP_ANALYSIS_DB.prepare("UPDATE users SET role=?,active=?,updated_at=datetime('now') WHERE id=?").bind(b.role,b.active?1:0,id).run();
    if (!b.active) await env.GAP_ANALYSIS_DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(id).run();
    await audit(env.GAP_ANALYSIS_DB,user,"UPDATE","user",id,{role:b.role,active:b.active});
    return reply({message:"Hak akses diperbarui."});
  }
  if (path==="/api/audit" && method==="GET") {
    if (user.role!=="Super Admin") return reply({error:"Akses khusus Super Admin."},403);
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
