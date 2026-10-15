# Agendaku Backend

REST API untuk aplikasi mobile Agendaku (React Native + Expo).
Stack: Node.js, Express, MySQL (mysql2), JWT, bcrypt, Expo Push Notifications, node-cron.

## 1. Persiapan

1. Install **Node.js 18+** (https://nodejs.org).
2. Nyalakan **MySQL** (XAMPP: start Apache + MySQL).
3. Import `database.sql` lewat phpMyAdmin (tab Import / SQL).
4. Di folder ini jalankan:

```bash
npm install
cp .env.example .env     # Windows: copy .env.example .env
```

5. Edit `.env`, sesuaikan `DB_USER`, `DB_PASSWORD`, dan isi `JWT_SECRET` dengan teks acak yang panjang.
6. Jalankan server:

```bash
npm run dev      # auto-restart saat file berubah
# atau
npm start
```

Cek di browser: http://localhost:3000 -> `{"app":"Agendaku API","status":"ok"}`

## 2. Menyambungkan dari Expo

`localhost` di HP / emulator **bukan** laptopmu. Gunakan:

| Perangkat | Base URL |
| --- | --- |
| HP fisik (Expo Go, 1 WiFi dengan laptop) | `http://IP_LAPTOP:3000` (cek dengan `ipconfig` / `ifconfig`) |
| Android Emulator | `http://10.0.2.2:3000` |
| iOS Simulator | `http://localhost:3000` |

Bila HP tidak bisa konek, izinkan port 3000 di firewall Windows.

Contoh pemakaian di React Native:

```js
const BASE_URL = 'http://192.168.1.10:3000/api';

// Login
const res = await fetch(`${BASE_URL}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const { token, user } = await res.json();
// simpan token pakai expo-secure-store

// Ambil daftar tugas (sudah urut deadline terdekat)
const tasks = await fetch(`${BASE_URL}/tasks?status=aktif`, {
  headers: { Authorization: `Bearer ${token}` },
}).then((r) => r.json());

// Tambah tugas (deadline WAJIB format ISO / toISOString())
await fetch(`${BASE_URL}/tasks`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    title: 'Laporan PjBL',
    deadline: new Date('2026-09-20T23:59:00+07:00').toISOString(),
    label_color: '#E74C3C',
    remind_before_minutes: 60,
  }),
});
```

Daftarkan push token (setelah login) dengan `expo-notifications`:

```js
import * as Notifications from 'expo-notifications';

const { data: pushToken } = await Notifications.getExpoPushTokenAsync({ projectId: 'ID_PROYEK_EXPO_KAMU' });
await fetch(`${BASE_URL}/auth/push-token`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ push_token: pushToken }),
});
```

Saat notifikasi diketuk, `response.notification.request.content.data` berisi
`{ type: 'reminder' | 'ping' | 'assigned', task_id }` untuk diarahkan ke halaman detail tugas.

## 3. Daftar Endpoint

Semua endpoint selain register/login butuh header `Authorization: Bearer <token>`.

### Auth (US-05)
| Method | Endpoint | Body | Keterangan |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | `name, email, password` | Daftar, mengembalikan token |
| POST | `/api/auth/login` | `email, password` | Login, mengembalikan token |
| GET | `/api/auth/me` | - | Data user yang login |
| PUT | `/api/auth/push-token` | `push_token` (null saat logout) | Simpan token notifikasi |

### Tugas
| Method | Endpoint | Keterangan | User Story |
| --- | --- | --- | --- |
| GET | `/api/tasks` | Daftar tugas, **otomatis urut deadline terdekat**. Berisi `sisa_menit` dan `is_overdue` | US-02, 07 |
| GET | `/api/tasks?status=aktif` | Hanya yang belum selesai (juga: `belum_dikerjakan`, `sedang_dikerjakan`, `selesai`) | US-03 |
| GET | `/api/tasks?label_color=%23E74C3C` | Filter label warna | US-10 |
| GET | `/api/tasks?workspace_id=3` / `personal` | Filter per workspace / tugas pribadi | US-06 |
| GET | `/api/tasks?date=2026-09-20` | Tugas pada tanggal tertentu | US-11 |
| GET | `/api/tasks/calendar?month=2026-09` | Tanggal yang punya tugas aktif (untuk titik penanda kalender) | US-11 |
| GET | `/api/tasks/stats/progress` | Total, selesai, terlambat, `persen_selesai` untuk grafik | US-08 |
| GET | `/api/tasks/:id` | Detail + daftar anggota & waktu selesai + riwayat aktivitas | US-09 |
| POST | `/api/tasks` | `title, deadline, description?, label_color?, workspace_id?, assignee_ids?, remind_before_minutes?` | US-01, 04, 06 |
| PUT | `/api/tasks/:id` | Ubah field apa pun (semua opsional) | US-01 |
| PATCH | `/api/tasks/:id/status` | `{ status }` | US-03 |
| POST | `/api/tasks/:id/complete` | `{ done: true/false }` centang bagian milik anggota; status tugas dihitung otomatis | US-06, 09 |
| POST | `/api/tasks/:id/ping` | `{ target_user_id }` kirim notifikasi ke anggota yang belum selesai | US-12 |
| DELETE | `/api/tasks/:id` | Hapus (pembuat / owner workspace) | US-01 |

Catatan: `remind_before_minutes` default 60 (pengingat 1 jam sebelum deadline). Isi `null` / `0` untuk tanpa pengingat.

### Workspace (US-06)
| Method | Endpoint | Body |
| --- | --- | --- |
| GET | `/api/workspaces` | - |
| POST | `/api/workspaces` | `name, description?` |
| GET | `/api/workspaces/:id` | - (berisi daftar anggota) |
| PUT | `/api/workspaces/:id` | `name?, description?` (owner) |
| DELETE | `/api/workspaces/:id` | - (owner) |
| POST | `/api/workspaces/:id/members` | `email` (owner) |
| DELETE | `/api/workspaces/:id/members/:userId` | - (owner mengeluarkan / anggota keluar) |

## 4. Catatan Penting

- **Zona waktu**: semua waktu disimpan dalam UTC. Aplikasi mengirim `toISOString()` dan menampilkan sebagai waktu lokal. Untuk filter tanggal/kalender, server memakai offset `DEFAULT_TZ_OFFSET_MIN` (420 = WIB) atau parameter `?tz=` dari aplikasi.
- **Reminder**: server mengecek tabel `reminders` tiap 1 menit dan mengirim push notification via Expo. Push notification hanya jalan di perangkat fisik (bukan emulator), dan butuh `projectId` Expo.
- **Real-time kolaborasi**: versi ini memakai polling. Di aplikasi, panggil ulang `GET /api/tasks/:id` setiap beberapa detik atau saat layar difokuskan. Bila nanti butuh yang benar-benar real-time, bisa ditambah Socket.IO.
- **Offline (read-only)**: simpan hasil `GET /api/tasks` ke `AsyncStorage` di aplikasi, tampilkan cache saat tidak ada koneksi.
- **Keamanan**: password di-hash bcrypt, akses data dicek per user lewat JWT. Jangan commit file `.env`.

## 5. Struktur Folder

```
src/
  config/db.js            koneksi MySQL + helper transaksi
  middleware/             auth JWT, error handler
  routes/                 auth, tasks, workspaces
  jobs/reminder.job.js    pengirim notifikasi pengingat (cron)
  utils/                  helper akses, reminder, push
  app.js / server.js
database.sql              skema database
```
