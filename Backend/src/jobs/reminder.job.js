import cron from 'node-cron';
import { pool } from '../config/db.js';
import { sendPush } from '../utils/push.js';

function sisaWaktuText(deadline) {
  const mins = Math.round((new Date(deadline).getTime() - Date.now()) / 60000);
  if (mins <= 0) return 'sudah lewat batas waktu';
  if (mins < 60) return `${mins} menit lagi`;
  if (mins < 1440) return `${Math.round(mins / 60)} jam lagi`;
  return `${Math.round(mins / 1440)} hari lagi`;
}

let running = false;

async function processReminders() {
  if (running) return;
  running = true;
  try {
    const [rows] = await pool.query(
      `SELECT r.reminder_id, r.task_id, t.title, t.deadline, t.status, u.push_token
         FROM reminders r
         JOIN tasks t ON t.task_id = r.task_id
         JOIN users u ON u.user_id = r.user_id
        WHERE r.is_sent = 0 AND r.reminder_at <= NOW()
        ORDER BY r.reminder_at ASC
        LIMIT 200`
    );
    if (!rows.length) return;

    for (const r of rows) {
      if (r.status !== 'selesai' && r.push_token) {
        await sendPush([r.push_token], {
          title: 'Deadline mendekat ⏰',
          body: `${r.title} — ${sisaWaktuText(r.deadline)}`,
          data: { type: 'reminder', task_id: r.task_id }, // dipakai app untuk membuka detail tugas
        });
      }
    }
    await pool.query('UPDATE reminders SET is_sent = 1 WHERE reminder_id IN (?)', [
      rows.map((r) => r.reminder_id),
    ]);
  } catch (err) {
    console.error('Reminder job error:', err.message);
  } finally {
    running = false;
  }
}

// Jalan setiap menit
export function startReminderJob() {
  cron.schedule('* * * * *', processReminders);
  console.log('Reminder job aktif (setiap 1 menit)');
}
