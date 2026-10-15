import { pool } from '../config/db.js';
import { HttpError } from '../middleware/error.js';

export const STATUSES = ['belum_dikerjakan', 'sedang_dikerjakan', 'selesai'];
export const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

// Terima ISO 8601 dari aplikasi, contoh: new Date().toISOString()
export function parseDeadline(value) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) {
    throw new HttpError(400, 'Format deadline tidak valid (pakai ISO 8601, contoh 2026-09-20T16:59:00Z)');
  }
  return d;
}

// undefined -> 60 menit (default), null/0 -> tanpa pengingat
export function normalizeMinutes(value) {
  if (value === undefined) return 60;
  if (value === null) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'remind_before_minutes tidak valid');
  return Math.floor(n);
}

export async function getMembership(workspaceId, userId) {
  const [rows] = await pool.query(
    'SELECT member_id, role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    [workspaceId, userId]
  );
  return rows[0] || null;
}

export async function requireMember(workspaceId, userId) {
  const m = await getMembership(workspaceId, userId);
  if (!m) throw new HttpError(404, 'Workspace tidak ditemukan');
  return m;
}

// Pastikan semua id adalah anggota workspace
export async function filterMembers(workspaceId, ids) {
  const unique = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
  if (!unique.length) return [];
  const [rows] = await pool.query(
    'SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id IN (?)',
    [workspaceId, unique]
  );
  if (rows.length !== unique.length) {
    throw new HttpError(400, 'Ada assignee yang bukan anggota workspace');
  }
  return unique;
}

// Ambil tugas bila user punya akses (pembuat ATAU anggota workspace tugas tsb)
export async function getTaskAccess(taskId, userId) {
  const [rows] = await pool.query(
    `SELECT t.*, w.owner_id AS ws_owner_id
       FROM tasks t
       LEFT JOIN workspaces w ON w.workspace_id = t.workspace_id
       LEFT JOIN workspace_members wm
              ON wm.workspace_id = t.workspace_id AND wm.user_id = ?
      WHERE t.task_id = ? AND (t.user_id = ? OR wm.user_id IS NOT NULL)`,
    [userId, taskId, userId]
  );
  if (!rows.length) return null;
  const task = rows[0];
  task.can_manage = task.user_id === userId || task.ws_owner_id === userId;
  return task;
}

export async function logActivity(conn, taskId, userId, type, targetUserId = null) {
  await conn.query(
    'INSERT INTO task_activities (task_id, user_id, activity_type, target_user_id) VALUES (?, ?, ?, ?)',
    [taskId, userId, type, targetUserId]
  );
}

// Buat ulang pengingat yang belum terkirim (US-04)
export async function rebuildReminders(conn, taskId, deadline, userIds, minutesBefore) {
  await conn.query('DELETE FROM reminders WHERE task_id = ? AND is_sent = 0', [taskId]);
  if (!userIds.length || !minutesBefore) return;

  const dl = new Date(deadline);
  const now = new Date();
  if (dl <= now) return;

  let at = new Date(dl.getTime() - minutesBefore * 60000);
  if (at < now) at = now; // waktu pengingat sudah lewat -> kirim secepatnya

  await conn.query(
    'INSERT INTO reminders (task_id, user_id, reminder_at, is_sent) VALUES ?',
    [userIds.map((uid) => [taskId, uid, at, 0])]
  );
}

// Hitung ulang status tugas kelompok dari progres tiap anggota (US-06, US-09)
export async function recalcTaskStatus(conn, taskId) {
  const [[c]] = await conn.query(
    `SELECT COUNT(*) AS total, SUM(completed_at IS NOT NULL) AS done
       FROM task_assignments WHERE task_id = ?`,
    [taskId]
  );
  const total = Number(c.total);
  const done = Number(c.done || 0);
  if (total === 0) return null;

  const status = done === total ? 'selesai' : done > 0 ? 'sedang_dikerjakan' : 'belum_dikerjakan';
  await conn.query('UPDATE tasks SET status = ? WHERE task_id = ?', [status, taskId]);
  return status;
}
