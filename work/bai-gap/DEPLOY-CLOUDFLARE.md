# BAI Gap Analysis — Cloudflare Workers + Static Assets + D1

Repository ini disiapkan untuk **Cloudflare Workers Builds** dengan perintah deployment default `npx wrangler deploy`. Worker entrypoint berada di `src/worker.js`, frontend statis disajikan melalui Workers Static Assets dari folder `dist/`, dan API tetap memakai handler autentikasi/RBAC yang sudah ada di `functions/api/[[path]].js`.

## 1. Pengaturan Cloudflare Workers Builds

| Pengaturan | Nilai |
|---|---|
| Project/Worker name | `bai-gap-analysis` |
| Production branch | `main` |
| Root directory | `work/bai-gap` |
| Build command | Kosongkan (tidak ada proses build) |
| Deploy command | `npx wrangler deploy` |

Pastikan deployment memakai branch `main`. Jika dashboard menyediakan pilihan **Root directory**, isi `work/bai-gap`. Jangan arahkan root directory ke folder repository paling atas karena konfigurasi Wrangler aplikasi berada di `work/bai-gap/wrangler.toml`.

Worker sekarang memiliki entrypoint eksplisit dan konfigurasi Static Assets. Dengan demikian, `npx wrangler deploy` tidak lagi perlu menebak folder aset. Request `/api/*` diteruskan ke handler API, sedangkan request lainnya disajikan dari `dist/`.

## 2. D1 database

Database produksi:
- Name: `bai-gap-production`
- ID: `24585639-21b0-4a44-bbb2-91b61daa317f`
- Binding variable: `GAP_ANALYSIS_DB`

Binding di `wrangler.toml` sudah menggunakan nama yang sama dengan yang dibaca oleh kode API. Pastikan database yang dipilih di Cloudflare memiliki ID yang sama. Jangan membuat database baru jika database produksi ini masih tersedia.

Terapkan migrasi dari folder `work/bai-gap`:

```bash
npx wrangler login
npx wrangler d1 migrations apply bai-gap-production --remote
```

## 3. Secret bootstrap Admin

Di Worker → **Settings → Variables and Secrets**, tambahkan secret Production bernama `BOOTSTRAP_SECRET` dengan nilai acak panjang. Jangan simpan secret atau password di repository atau bagikan melalui chat.

Setelah migrasi dan secret dikonfigurasi, kirim POST ke:

```text
https://<alamat-worker-kamu>/api/setup/admin
```

Contoh body:

```json
{
  "bootstrapSecret": "ISI_DENGAN_SECRET_YANG_DISIMPAN_DI_CLOUDFLARE",
  "username": "it.admin",
  "displayName": "IT Administrator",
  "password": "GUNAKAN_PASSWORD_UNIK_MINIMAL_12_KARAKTER"
}
```

Endpoint hanya membuat Admin jika tabel users masih kosong. Setelah Admin pertama berhasil dibuat, hapus secret `BOOTSTRAP_SECRET` dari Worker settings lalu deploy ulang.

## 4. Verifikasi

- `GET /api/health` mengembalikan `{"status":"ok","service":"bai-gap-api"}`.
- Halaman utama dan file CSS/JS dimuat.
- Login Admin berhasil.
- Admin dapat membuat akun Assessor dan Viewer.
- Assessor dapat membuat dan mengubah assessment.
- Viewer hanya dapat membaca.
- Admin dapat menghapus assessment dan melihat Audit Log.
- Data tetap tersedia setelah login dari browser lain.

## 5. Hak akses dan keamanan

- **Admin**: kelola pengguna/role, melihat audit log, membaca/membuat/mengubah/menghapus Gap.
- **Assessor**: membaca, membuat, dan mengubah Gap.
- **Viewer**: hanya membaca Gap.

Password di-hash menggunakan PBKDF2-HMAC-SHA256 dengan salt acak per pengguna. Cookie sesi menggunakan HttpOnly, Secure, dan SameSite=Lax; database menyimpan hash token sesi. Hak akses diperiksa di API.

## Catatan penting

Perubahan repository tidak otomatis mengatur secret atau konfigurasi akun Cloudflare. Pastikan root directory Workers Builds adalah `work/bai-gap`, D1 binding tersedia sebagai `GAP_ANALYSIS_DB`, dan secret `BOOTSTRAP_SECRET` telah dibuat sebelum bootstrap Admin. Uji deployment dan API sebelum memasukkan data perusahaan.
