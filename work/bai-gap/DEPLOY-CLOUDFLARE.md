# BAI Gap Analysis — Cloudflare Pages + D1

Aplikasi ini adalah **Cloudflare Pages project**, bukan Cloudflare Worker biasa. Frontend statis berada di `dist/`; API berada di `functions/api/[[path]].js` dan otomatis dipublikasikan sebagai Pages Functions.

## 1. Pengaturan Cloudflare Pages

| Pengaturan | Nilai |
|---|---|
| Project name | `bai-gap-analysis` |
| Production branch | `main` |
| Root directory | `work/bai-gap` |
| Framework preset | `None` |
| Build command | Kosongkan |
| Build output directory | `dist` |

Hubungkan repository melalui **Workers & Pages → Create application → Pages → Connect to Git**. Jangan isi Deploy command dengan `npx wrangler deploy`; itu perintah untuk Worker, bukan Pages. Untuk Direct Upload, gunakan `npx wrangler pages deploy dist --project-name bai-gap-analysis` dari folder `work/bai-gap`.

## 2. Konfigurasi D1

Database produksi:
- Database name: `bai-gap-production`
- Database ID: `24585639-21b0-4a44-bbb2-91b61daa317f`
- Binding variable: `GAP_ANALYSIS_DB`

Konfigurasi ini sudah ditulis di `wrangler.toml`. Binding variable di Cloudflare Pages harus sama persis:

1. Buka Pages project `bai-gap-analysis`.
2. Masuk **Settings → Bindings → Add → D1 database**.
3. Isi Variable name dengan `GAP_ANALYSIS_DB`.
4. Pilih database `bai-gap-production` dan pastikan ID-nya cocok dengan UUID di atas.
5. Simpan lalu redeploy project.

Kode Pages Function mengakses database melalui `env.GAP_ANALYSIS_DB`. Jangan gunakan binding lama `DB` bersamaan dengan nama binding baru. Untuk Preview, disarankan menggunakan database terpisah agar data uji tidak bercampur dengan produksi.

## 3. Terapkan migrasi database

Dari folder `work/bai-gap`, jalankan:

```bash
npx wrangler login
npx wrangler d1 migrations apply bai-gap-production --remote
```

Pastikan nama database dan ID sesuai sebelum mengonfirmasi migrasi.

## 4. Secret bootstrap Admin

Di Pages project → **Settings → Variables and Secrets**, tambahkan secret Production bernama `BOOTSTRAP_SECRET` dengan nilai acak panjang. Jangan masukkan nilainya ke repository atau bagikan melalui chat. Simpan lalu redeploy.

Setelah migrasi selesai, kirim POST ke:

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

Endpoint hanya membuat Admin jika tabel users masih kosong. Setelah Admin pertama berhasil dibuat, hapus secret `BOOTSTRAP_SECRET` dari Pages settings lalu redeploy.

## 5. Verifikasi deployment

- `GET /api/health` mengembalikan status `ok`.
- Login Admin berhasil.
- Admin dapat membuat akun Assessor dan Viewer.
- Assessor dapat membuat dan mengubah assessment.
- Viewer hanya dapat membaca data.
- Admin dapat menghapus assessment dan melihat Audit Log.
- Data tetap tersedia setelah login dari browser lain.

Jika API mengembalikan pesan binding belum dikonfigurasi, periksa nama binding `GAP_ANALYSIS_DB` dan lakukan redeploy. Jika tabel tidak ditemukan, pastikan migrasi diterapkan pada database yang sama dengan binding Production.

## 6. Hak akses

- **Admin**: kelola pengguna/role, melihat audit log, membaca/membuat/mengubah/menghapus Gap.
- **Assessor**: membaca, membuat, dan mengubah Gap.
- **Viewer**: hanya membaca Gap.

## Catatan keamanan dan status

Password di-hash menggunakan PBKDF2-HMAC-SHA256 dengan salt acak per pengguna. Cookie sesi menggunakan HttpOnly, Secure, dan SameSite=Lax; database menyimpan hash token sesi. Hak akses diperiksa di API.

Perubahan konfigurasi repository tidak otomatis membuat binding/secret di dashboard Cloudflare. Deployment, penerapan migrasi, dan pengujian end-to-end tetap perlu dilakukan pada akun Cloudflare pemilik project sebelum data perusahaan dimasukkan.
