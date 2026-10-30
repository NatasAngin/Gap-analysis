# BAI Gap Analysis — Cloudflare Pages + D1

## Implemented backend foundation
- Pages Functions API for login/logout/session validation.
- D1 data model for users, sessions, Gap records and audit logs.
- PBKDF2-HMAC-SHA256 password hashing with per-user random salt (310,000 iterations).
- Opaque random session cookie marked Secure, HttpOnly and SameSite=Lax; only its SHA-256 digest is stored.
- Server-side role checks: Admin, Assessor and Viewer.
- One-time first-admin bootstrap endpoint, protected by a Cloudflare secret.
- Audit records for login, user changes and Gap changes.

## Cloudflare Pages project settings
Connect repository NatasAngin/Gap-analysis:
- Production branch: main (merge this feature branch after review)
- Root directory: work/bai-gap
- Framework preset: None
- Build command: leave blank
- Build output directory: dist

Root directory is set to the Gap Analysis project folder because the repository is a monorepo with other projects.

## Create and bind D1
1. Cloudflare Dashboard → Storage & databases → D1 SQL Database → Create database: bai-gap-production.
2. Copy the database ID and replace REPLACE_WITH_D1_DATABASE_ID in wrangler.toml.
3. In Pages → bai-gap-analysis → Settings → Functions → D1 database bindings, add binding name DB and select bai-gap-production. Configure Production and Preview independently if both are used.
4. Apply migration from the work/bai-gap directory:
   npm install --save-dev wrangler
   npx wrangler login
   npx wrangler d1 migrations apply bai-gap-production --remote

## First Admin bootstrap
Pages → Settings → Variables and Secrets: add secret BOOTSTRAP_SECRET with a long random value (32+ characters). Redeploy.
Once deployed and D1 migration is applied, POST JSON to:
https://YOUR-PROJECT.pages.dev/api/setup/admin

{
  "bootstrapSecret": "THE_SECRET_FROM_CLOUDFLARE",
  "username": "it.admin",
  "displayName": "IT Administrator",
  "password": "USE-A-UNIQUE-PASSWORD-AT-LEAST-12-CHARACTERS"
}

This endpoint only succeeds while the users table is empty. After creating the first Admin, remove BOOTSTRAP_SECRET from Pages secrets and redeploy.

## Role policy
- Admin: user/role management, view audit logs, read/create/update/delete Gap records.
- Assessor: read/create/update Gap records.
- Viewer: read-only Gap records.
- Only Admin can delete a Gap. Admin cannot deactivate their own account.

## API routes
GET /api/health
POST /api/setup/admin
POST /api/auth/login
POST /api/auth/logout
GET /api/auth/me
GET /api/gaps
POST /api/gaps
PUT /api/gaps/:id
DELETE /api/gaps/:id
GET /api/users (Admin)
POST /api/users (Admin)
PATCH /api/users/:id (Admin)
DELETE /api/users/:id (Admin; deactivates)
GET /api/audit (Admin)

## Important
The existing dist/app.js still uses LocalStorage and demo records. This commit is the backend/API and schema foundation only; it does not yet connect the visible UI to these endpoints or add login/user-management screens. Do not enter real company information or treat the application as production-ready until frontend integration, security review, and end-to-end tests are completed.
