import 'dotenv/config';
import app from './app.js';
import { pool } from './config/db.js';
import { startReminderJob } from './jobs/reminder.job.js';

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET belum diisi di file .env');
  process.exit(1);
}

const PORT = Number(process.env.PORT || 3000);

try {
  await pool.query('SELECT 1');
  console.log('Terhubung ke database MySQL');
} catch (err) {
  console.error('Gagal terhubung ke database:', err.message);
  process.exit(1);
}

// 0.0.0.0 supaya bisa diakses dari HP lewat IP laptop (satu jaringan WiFi)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Agendaku API berjalan di http://localhost:${PORT}`);
});

startReminderJob();
