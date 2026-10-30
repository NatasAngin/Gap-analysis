# BAI Gap Analysis — Cloudflare Pages + D1

Aplikasi ini adalah **Cloudflare Pages project**, bukan Cloudflare Worker biasa.
Frontend statis berada di `dist/`; API berada di `functions/api/[[path]].js` dan otomatis dipublikasikan sebagai Pages Functions.

## 1. Buat project Cloudflare Pages (Git integration)

1. Buka Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
2. Pilih repository `NatasAngin/Gap-analysis`.
3. Isi pengaturan berikut:

| Pengaturan | Nilai |
|---|---|
| Project name | `bai-gap-analysis` |
| Production branch | `main` |
| Root directory | `work/bai-gap` |
| Framework preset | `None` |
| Build command | Kosongkan |
| Build output directory | `dist` |

4. Simpan dan deploy. Git integration akan menjalankan deployment ketika perubahan pada branch produksi masuk.
5. **Jangan** isi Deploy command dengan `npx wrangler deploy`. Perintah itu untuk Worker, bukan Pages.
6. Jika log masih menampilkan `Executing user deploy command: npx wrangler deploy`, kemungkinan project yang dibuat adalah Worker/Workers Builds. Buat project baru melalui alur **Pages → Connect to Git** seperti langkah pertama.

Repository ini monorepo. Root directory wajib diarahkan ke `work/bai-gap`, bukan root repository.

## 2. Buat database D1

1. Cloudflare Dashboard → **Storage & databases** → **D1 SQL Database** → Create database.
2. Nama database: `bai-gap-production`.
3. Buka Pages project `bai-gap-analysis` → **Settings → Bindings** → Add → **D1 database**.
4. Isi **Variable name** persis `DB`, lalu pilih database `bai-gap-production`.
5. Pastikan binding ditambahkan pada environment **Production**. Untuk Preview, gunakan database terpisah (misalnya `bai-gap-preview`) agar data uji tidak bercampur dengan data produksi.
6. Simpan perubahan binding lalu lakukan redeploy.

Kode API membaca database melalui `env.DB`. Nama binding harus persis `DB`.

## 3. Terapkan skema database

Di terminal, masuk ke folder aplikasi:

```bash
cd work/bai-gap
npx wrangler login
npx wrangler d1 migrations apply bai-gap-production --remote
```

Pilih konfirmasi ketika diminta. Perintah ini menerapkan file di folder `migrations/` ke database remote. Pastikan nama database benar sebelum menekan konfirmasi.

Jika perintah migrasi tidak menemukan konfigurasi migrasi, jalankan SQL awal secara langsung:

```bash
npx wrangler d1 execute bai-gap-production --remote --file=./migrations/0001_initial.sql
```

File SQL menggunakan `CREATE TABLE IF NOT EXISTS`, sehingga dapat dijalankan ulang tanpa membuat tabel duplikat.

## 4. Tambahkan secret bootstrap Admin

1. Pages project → **Settings → Variables and Secrets**.
2. Pada environment Production, tambahkan secret bernama `BOOTSTRAP_SECRET`.
3. Gunakan nilai acak panjang (minimal 32 karakter). Jangan menaruh nilainya di repository atau membagikannya melalui chat.
4. Simpan lalu redeploy.

Setelah deployment selesai dan migrasi D1 berhasil, buat Admin pertama dengan mengirim POST ke:

```text
https://bai-gap-analysis.pages.dev/api/setup/admin
```

Contoh body JSON:

```json
{
  "bootstrapSecret": "ISI_DENGAN_SECRET_YANG_DISIMPAN_DI_CLOUDFLARE",
  "username": "it.admin",
  "displayName": "IT Administrator",
  "password": "GUNAKAN_PASSWORD_UNIK_MINIMAL_12_KARAKTER"
}
```

Endpoint hanya dapat membuat Admin ketika tabel users masih kosong. Setelah Admin pertama berhasil dibuat, **hapus secret `BOOTSTRAP_SECRET` dari pengaturan Pages dan redeploy**. Jangan menyimpan secret atau password produksi di GitHub.

## 5. Verifikasi setelah deployment

Buka alamat Pages project dan periksa:

- `GET /api/health` mengembalikan `{"status":"ok","service":"bai-gap-api"}`.
- Halaman menampilkan form login.
- Admin dapat login dan membuat akun Assessor serta Viewer.
- Assessor dapat membuat dan mengubah assessment.
- Viewer hanya dapat membaca data.
- Admin dapat menghapus assessment dan melihat Audit Log.
- Data tetap tersedia setelah logout/login atau membuka aplikasi dari browser lain.

Jika `/api/health` menampilkan pesan binding D1 belum dikonfigurasi, periksa binding bernama `DB` dan pastikan sudah redeploy setelah binding ditambahkan. Jika tabel tidak ditemukan, terapkan migrasi pada database yang sama dengan binding Production.

## 6. Deploy manual (opsional)

Jika menggunakan Direct Upload dan bukan Git integration, dari folder `work/bai-gap` jalankan:

```bash
npx wrangler pages deploy dist --project-name bai-gap-analysis
```

Jangan gunakan `npx wrangler deploy` untuk project Pages.

## 7. Hak akses

- **Admin**: kelola pengguna/role, melihat audit log, membaca/membuat/mengubah/menghapus Gap.
- **Assessor**: membaca, membuat, dan mengubah Gap.
- **Viewer**: hanya membaca Gap.

## Catatan keamanan dan status pengujian

- Password di-hash menggunakan PBKDF2-HMAC-SHA256 dengan salt acak per pengguna.
- Cookie sesi ditandai HttpOnly, Secure, dan SameSite=Lax; database menyimpan hash token sesi.
- Hak akses diperiksa kembali di API, bukan hanya disembunyikan dari tampilan.
- Sebelum memasukkan data perusahaan, lakukan pengujian end-to-end di Pages + D1, aktifkan proteksi/rate limiting untuk endpoint login melalui Cloudflare, dan lakukan review keamanan.
- Kode dapat diperiksa di GitHub, tetapi deployment, pembuatan D1, binding, secret, dan uji runtime Cloudflare tetap membutuhkan akses ke akun Cloudflare pemilik project.
