import { Router } from 'express';
import { pool, withTransaction } from '../config/db.js';
import { auth } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/error.js';
import { notifyUsers } from '../utils/push.js';
import {
  STATUSES,
  COLOR_RE,
  parseDeadline,
  normalizeMinutes,
  requireMember,
  filterMembers,
  getTaskAccess,
  logActivity,
  rebuildReminders,
  recalcTaskStatus,
} from '../utils/helpers.js';

const router = Router();
router.use(auth);

const DEFAULT_TZ = Number(process.env.DEFAULT_TZ_OFFSET_MIN ?? 420);
const tzOffset = (v) => (Number.isFinite(Number(v)) && v !== undefined ? Number(v) : DEFAULT_TZ);

// Tugas yang boleh dilihat user: miliknya sendiri ATAU tugas di workspace yang dia ikuti
const ACCESS_JOIN = `
  FROM tasks t
  LEFT JOIN workspaces w ON w.workspace_id = t.workspace_id
  LEFT JOIN workspace_members wm ON wm.workspace_id = t.workspace_id AND wm.user_id = ?`;
const ACCESS_WHERE = '(t.user_id = ? OR wm.user_id IS NOT NULL)';

const TASK_COLUMNS = `
  t.task_id, t.user_id, t.workspace_id, w.name AS workspace_name,
  t.title, t.description, t.deadline, t.status, t.label_color,
  t.created_at, t.updated_at,
  TIMESTAMPDIFF(MINUTE, NOW(), t.deadline) AS sisa_menit,
  (t.status <> 'selesai' AND t.deadline < NOW()) AS is_overdue,
  (SELECT COUNT(*) FROM task_assignments a WHERE a.task_id = t.task_id) AS total_assignees,
  (SELECT COUNT(*) FROM task_assignments a WHERE a.task_id = t.task_id AND a.completed_at IS NOT NULL) AS done_assignees`;

const formatTask = (r) => ({
  ...r,
  sisa_menit: r.sisa_menit === null ? null : Number(r.sisa_menit),
  is_overdue: !!Number(r.is_overdue),
  total_assignees: Number(r.total_assignees),
  done_assignees: Number(r.done_assignees),
});

async function getTaskDetail(taskId, uid) {
  const [rows] = await pool.query(
    `SELECT ${TASK_COLUMNS}, cu.name AS creator_name
     ${ACCESS_JOIN}
     JOIN users cu ON cu.user_id = t.user_id
     WHERE t.task_id = ? AND ${ACCESS_WHERE}`,
    [uid, taskId, uid]
  );
  if (!rows.length) return null;

  const [assignments] = await pool.query(
    `SELECT ta.user_id, u.name, ta.assigned_at, ta.completed_at
       FROM task_assignments ta JOIN users u ON u.user_id = ta.user_id
      WHERE ta.task_id = ? ORDER BY ta.assigned_at ASC, ta.assignment_id ASC`,
    [taskId]
  );
  const [activities] = await pool.query(
    `SELECT a.activity_id, a.activity_type, a.created_at,
            a.user_id, u.name AS user_name, a.target_user_id, tu.name AS target_name
       FROM task_activities a
       JOIN users u ON u.user_id = a.user_id
       LEFT JOIN users tu ON tu.user_id = a.target_user_id
      WHERE a.task_id = ?
      ORDER BY a.created_at DESC, a.activity_id DESC LIMIT 30`,
    [taskId]
  );
  const [reminders] = await pool.query(
    'SELECT reminder_id, reminder_at, is_sent FROM reminders WHERE task_id = ? AND user_id = ?',
    [taskId, uid]
  );

  return { ...formatTask(rows[0]), assignments, activities, reminders };
}

/* ------------------------------------------------------------------ */
/*  GET /api/tasks  (US-02, US-03, US-07, US-10, US-11)                */
/*  Selalu diurutkan deadline terdekat -> terjauh.                     */
/*  Query: status (belum_dikerjakan|sedang_dikerjakan|selesai|aktif),  */
/*         label_color, workspace_id (angka | "personal"),             */
/*         date (YYYY-MM-DD), tz (offset menit, default 420 = WIB)     */
/* ------------------------------------------------------------------ */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const { status, label_color, workspace_id, date, tz } = req.query;

    const where = [ACCESS_WHERE];
    const params = [uid, uid];

    if (status) {
      if (status === 'aktif') where.push("t.status <> 'selesai'");
      else if (STATUSES.includes(status)) {
        where.push('t.status = ?');
        params.push(status);
      } else throw new HttpError(400, 'Nilai status tidak valid');
    }
    if (label_color) {
      where.push('t.label_color = ?');
      params.push(label_color);
    }
    if (workspace_id === 'personal') where.push('t.workspace_id IS NULL');
    else if (workspace_id) {
      where.push('t.workspace_id = ?');
      params.push(Number(workspace_id));
    }
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Format date harus YYYY-MM-DD');
      where.push('DATE(DATE_ADD(t.deadline, INTERVAL ? MINUTE)) = ?');
      params.push(tzOffset(tz), date);
    }

    const [rows] = await pool.query(
      `SELECT ${TASK_COLUMNS} ${ACCESS_JOIN}
        WHERE ${where.join(' AND ')}
        ORDER BY t.deadline ASC, t.task_id ASC`,
      params
    );
    res.json(rows.map(formatTask));
  })
);

/* GET /api/tasks/calendar?month=YYYY-MM  (US-11) -> tanggal yang punya tugas aktif */
router.get(
  '/calendar',
  asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const { month, tz } = req.query;
    if (!/^\d{4}-\d{2}$/.test(month || '')) throw new HttpError(400, 'Format month harus YYYY-MM');
    const off = tzOffset(tz);

    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(DATE_ADD(t.deadline, INTERVAL ? MINUTE), '%Y-%m-%d') AS tanggal,
              COUNT(*) AS jumlah
         ${ACCESS_JOIN}
        WHERE ${ACCESS_WHERE}
          AND t.status <> 'selesai'
          AND DATE_FORMAT(DATE_ADD(t.deadline, INTERVAL ? MINUTE), '%Y-%m') = ?
        GROUP BY tanggal ORDER BY tanggal`,
      [off, uid, uid, off, month]
    );
    res.json(rows.map((r) => ({ tanggal: r.tanggal, jumlah: Number(r.jumlah) })));
  })
);

/* GET /api/tasks/stats/progress  (US-08) -> data grafik persentase */
router.get(
  '/stats/progress',
  asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const { workspace_id } = req.query;

    const where = [ACCESS_WHERE];
    const params = [uid, uid];
    if (workspace_id === 'personal') where.push('t.workspace_id IS NULL');
    else if (workspace_id) {
      where.push('t.workspace_id = ?');
      params.push(Number(workspace_id));
    }

    const [[s]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(t.status = 'selesai') AS selesai,
              SUM(t.status = 'sedang_dikerjakan') AS sedang,
              SUM(t.status = 'belum_dikerjakan') AS belum,
              SUM(t.status <> 'selesai' AND t.deadline < NOW()) AS terlambat
         ${ACCESS_JOIN}
        WHERE ${where.join(' AND ')}`,
      params
    );
    const total = Number(s.total || 0);
    const selesai = Number(s.selesai || 0);
    res.json({
      total,
      selesai,
      sedang_dikerjakan: Number(s.sedang || 0),
      belum_dikerjakan: Number(s.belum || 0),
      terlambat: Number(s.terlambat || 0),
      persen_selesai: total ? Math.round((selesai / total) * 1000) / 10 : 0,
    });
  })
);

/* POST /api/tasks  (US-01, US-04, US-06) */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const b = req.body || {};

    const title = String(b.title || '').trim();
    if (!title) throw new HttpError(400, 'Judul tugas wajib diisi');
    const deadline = parseDeadline(b.deadline);
    const description = b.description ? String(b.description) : null;
    const labelColor = b.label_color ?? null;
    if (labelColor !== null && !COLOR_RE.test(labelColor)) {
      throw new HttpError(400, 'label_color harus berformat hex, contoh #FF5733');
    }
    const minutes = normalizeMinutes(b.remind_before_minutes);

    const workspaceId = b.workspace_id ? Number(b.workspace_id) : null;
    let assigneeIds = [];
    if (workspaceId) {
      await requireMember(workspaceId, uid);
      assigneeIds = await filterMembers(workspaceId, b.assignee_ids);
    }

    const taskId = await withTransaction(async (conn) => {
      const [r] = await conn.query(
        `INSERT INTO tasks (user_id, workspace_id, title, description, deadline, label_color)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uid, workspaceId, title, description, deadline, labelColor]
      );
      const id = r.insertId;

      if (assigneeIds.length) {
        await conn.query('INSERT INTO task_assignments (task_id, user_id) VALUES ?', [
          assigneeIds.map((a) => [id, a]),
        ]);
        for (const a of assigneeIds) await logActivity(conn, id, uid, 'assigned', a);
      }
      await logActivity(conn, id, uid, 'created');

      const recipients = [...new Set([uid, ...assigneeIds])];
      await rebuildReminders(conn, id, deadline, recipients, minutes);
      return id;
    });

    // Beri tahu anggota yang ditugaskan (selain pembuat)
    const toNotify = assigneeIds.filter((a) => a !== uid);
    if (toNotify.length) {
      notifyUsers(toNotify, {
        title: 'Tugas baru untukmu',
        body: title,
        data: { type: 'assigned', task_id: taskId },
      }).catch(console.error);
    }

    res.status(201).json(await getTaskDetail(taskId, uid));
  })
);

/* GET /api/tasks/:id  (rincian + anggota yang sudah selesai, US-09) */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const detail = await getTaskDetail(Number(req.params.id), req.user.id);
    if (!detail) throw new HttpError(404, 'Tugas tidak ditemukan');
    res.json(detail);
  })
);

/* PUT /api/tasks/:id  (US-01) - semua field opsional */
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const taskId = Number(req.params.id);
    const task = await getTaskAccess(taskId, uid);
    if (!task) throw new HttpError(404, 'Tugas tidak ditemukan');

    const b = req.body || {};
    const sets = [];
    const params = [];
    let newDeadline = null;

    if (b.title !== undefined) {
      const t = String(b.title).trim();
      if (!t) throw new HttpError(400, 'Judul tidak boleh kosong');
      sets.push('title = ?');
      params.push(t);
    }
    if (b.description !== undefined) {
      sets.push('description = ?');
      params.push(b.description === null ? null : String(b.description));
    }
    if (b.deadline !== undefined) {
      newDeadline = parseDeadline(b.deadline);
      sets.push('deadline = ?');
      params.push(newDeadline);
    }
    if (b.label_color !== undefined) {
      if (b.label_color !== null && !COLOR_RE.test(b.label_color)) {
        throw new HttpError(400, 'label_color harus berformat hex, contoh #FF5733');
      }
      sets.push('label_color = ?');
      params.push(b.label_color);
    }

    const hasAssignees = !!task.workspace_id && Array.isArray(b.assignee_ids);
    const assigneeIds = hasAssignees ? await filterMembers(task.workspace_id, b.assignee_ids) : null;
    const remindProvided = b.remind_before_minutes !== undefined;

    if (!sets.length && !hasAssignees && !remindProvided) {
      throw new HttpError(400, 'Tidak ada data yang diubah');
    }
    const minutes = normalizeMinutes(b.remind_before_minutes);

    await withTransaction(async (conn) => {
      if (sets.length) {
        await conn.query(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`, [...params, taskId]);
      }
      if (hasAssignees) {
        if (assigneeIds.length) {
          await conn.query('DELETE FROM task_assignments WHERE task_id = ? AND user_id NOT IN (?)', [
            taskId,
            assigneeIds,
          ]);
          await conn.query('INSERT IGNORE INTO task_assignments (task_id, user_id) VALUES ?', [
            assigneeIds.map((a) => [taskId, a]),
          ]);
        } else {
          await conn.query('DELETE FROM task_assignments WHERE task_id = ?', [taskId]);
        }
      }
      await logActivity(conn, taskId, uid, 'updated');

      if (newDeadline || hasAssignees || remindProvided) {
        const [[cur]] = await conn.query('SELECT deadline FROM tasks WHERE task_id = ?', [taskId]);
        const [asg] = await conn.query('SELECT user_id FROM task_assignments WHERE task_id = ?', [taskId]);
        const recipients = [...new Set([task.user_id, ...asg.map((a) => a.user_id)])];
        await rebuildReminders(conn, taskId, cur.deadline, recipients, minutes);
      }
    });

    res.json(await getTaskDetail(taskId, uid));
  })
);

/* PATCH /api/tasks/:id/status  { status }  (US-03) */
router.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const taskId = Number(req.params.id);
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) {
      throw new HttpError(400, `status harus salah satu dari: ${STATUSES.join(', ')}`);
    }
    const task = await getTaskAccess(taskId, uid);
    if (!task) throw new HttpError(404, 'Tugas tidak ditemukan');

    await withTransaction(async (conn) => {
      await conn.query('UPDATE tasks SET status = ? WHERE task_id = ?', [status, taskId]);
      // sinkronkan progres anggota yang sedang login
      if (status === 'selesai') {
        await conn.query(
          'UPDATE task_assignments SET completed_at = COALESCE(completed_at, NOW()) WHERE task_id = ? AND user_id = ?',
          [taskId, uid]
        );
      } else {
        await conn.query(
          'UPDATE task_assignments SET completed_at = NULL WHERE task_id = ? AND user_id = ?',
          [taskId, uid]
        );
      }
      await logActivity(conn, taskId, uid, status === 'selesai' ? 'completed' : 'status_changed');
    });

    res.json(await getTaskDetail(taskId, uid));
  })
);

/* POST /api/tasks/:id/complete  { done: true|false }  (US-06, US-09)
   Centang bagian tugas milik anggota yang login. Status tugas dihitung otomatis:
   semua selesai -> selesai, sebagian -> sedang_dikerjakan. */
router.post(
  '/:id/complete',
  asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const taskId = Number(req.params.id);
    const done = req.body?.done !== false;
    const task = await getTaskAccess(taskId, uid);
    if (!task) throw new HttpError(404, 'Tugas tidak ditemukan');

    const [[cnt]] = await pool.query(
      'SELECT COUNT(*) AS total, SUM(user_id = ?) AS mine FROM task_assignments WHERE task_id = ?',
      [uid, taskId]
    );
    const total = Number(cnt.total);
    const mine = Number(cnt.mine || 0);

    if (!mine && total > 0 && !task.can_manage) {
      throw new HttpError(403, 'Kamu tidak ditugaskan pada tugas ini');
    }

    await withTransaction(async (conn) => {
      if (mine) {
        await conn.query(
          `UPDATE task_assignments
              SET completed_at = ${done ? 'COALESCE(completed_at, NOW())' : 'NULL'}
            WHERE task_id = ? AND user_id = ?`,
          [taskId, uid]
        );
        await recalcTaskStatus(conn, taskId);
      } else {
        // tugas tanpa pembagian anggota (mis. tugas pribadi)
        await conn.query('UPDATE tasks SET status = ? WHERE task_id = ?', [
          done ? 'selesai' : 'belum_dikerjakan',
          taskId,
        ]);
      }
      await logActivity(conn, taskId, uid, done ? 'completed' : 'status_changed');
    });

    res.json(await getTaskDetail(taskId, uid));
  })
);

/* POST /api/tasks/:id/ping  { target_user_id }  (US-12) */
router.post(
  '/:id/ping',
  asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const taskId = Number(req.params.id);
    const targetId = Number(req.body?.target_user_id);
    const task = await getTaskAccess(taskId, uid);
    if (!task) throw new HttpError(404, 'Tugas tidak ditemukan');
    if (!Number.isInteger(targetId) || targetId === uid) {
      throw new HttpError(400, 'target_user_id tidak valid');
    }

    const [target] = await pool.query(
      'SELECT completed_at FROM task_assignments WHERE task_id = ? AND user_id = ?',
      [taskId, targetId]
    );
    if (!target.length) throw new HttpError(400, 'Anggota tersebut tidak ditugaskan pada tugas ini');
    if (target[0].completed_at) throw new HttpError(400, 'Anggota tersebut sudah menyelesaikan bagiannya');

    const [[me]] = await pool.query('SELECT name FROM users WHERE user_id = ?', [uid]);
    await withTransaction((conn) => logActivity(conn, taskId, uid, 'ping', targetId));

    await notifyUsers([targetId], {
      title: `Pengingat dari ${me.name}`,
      body: `Segera kerjakan bagianmu: "${task.title}"`,
      data: { type: 'ping', task_id: taskId },
    });

    res.json({ message: 'Ping terkirim' });
  })
);

/* DELETE /api/tasks/:id  (US-01) - pembuat tugas atau owner workspace */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const taskId = Number(req.params.id);
    const task = await getTaskAccess(taskId, req.user.id);
    if (!task) throw new HttpError(404, 'Tugas tidak ditemukan');
    if (!task.can_manage) {
      throw new HttpError(403, 'Hanya pembuat tugas atau owner workspace yang boleh menghapus');
    }
    await pool.query('DELETE FROM tasks WHERE task_id = ?', [taskId]);
    res.json({ message: 'Tugas dihapus' });
  })
);

export default router;
