import { Router } from 'express';
import { pool, withTransaction } from '../config/db.js';
import { auth } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/error.js';
import { requireMember } from '../utils/helpers.js';

const router = Router();
router.use(auth);

// GET /api/workspaces  -> workspace yang diikuti user
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT w.workspace_id, w.owner_id, w.name, w.description, w.created_at,
              wm.role AS my_role,
              (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.workspace_id) AS member_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.workspace_id = w.workspace_id AND t.status <> 'selesai') AS active_tasks
         FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.workspace_id AND wm.user_id = ?
        ORDER BY w.created_at DESC`,
      [req.user.id]
    );
    res.json(
      rows.map((r) => ({
        ...r,
        member_count: Number(r.member_count),
        active_tasks: Number(r.active_tasks),
      }))
    );
  })
);

// POST /api/workspaces  { name, description }
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const description = req.body?.description ? String(req.body.description) : null;
    if (!name) throw new HttpError(400, 'Nama workspace wajib diisi');

    const id = await withTransaction(async (conn) => {
      const [r] = await conn.query(
        'INSERT INTO workspaces (owner_id, name, description) VALUES (?, ?, ?)',
        [req.user.id, name, description]
      );
      await conn.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')",
        [r.insertId, req.user.id]
      );
      return r.insertId;
    });

    res.status(201).json({ workspace_id: id, owner_id: req.user.id, name, description });
  })
);

// GET /api/workspaces/:id  -> detail + daftar anggota
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const wsId = Number(req.params.id);
    const m = await requireMember(wsId, req.user.id);

    const [[ws]] = await pool.query('SELECT * FROM workspaces WHERE workspace_id = ?', [wsId]);
    const [members] = await pool.query(
      `SELECT u.user_id, u.name, u.email, wm.role, wm.joined_at
         FROM workspace_members wm
         JOIN users u ON u.user_id = wm.user_id
        WHERE wm.workspace_id = ?
        ORDER BY wm.role = 'owner' DESC, u.name ASC`,
      [wsId]
    );
    res.json({ ...ws, my_role: m.role, members });
  })
);

// PUT /api/workspaces/:id  (hanya owner)
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const wsId = Number(req.params.id);
    const m = await requireMember(wsId, req.user.id);
    if (m.role !== 'owner') throw new HttpError(403, 'Hanya owner yang boleh mengubah workspace');

    const sets = [];
    const params = [];
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) throw new HttpError(400, 'Nama workspace tidak boleh kosong');
      sets.push('name = ?');
      params.push(name);
    }
    if (req.body?.description !== undefined) {
      sets.push('description = ?');
      params.push(req.body.description === null ? null : String(req.body.description));
    }
    if (!sets.length) throw new HttpError(400, 'Tidak ada data yang diubah');

    await pool.query(`UPDATE workspaces SET ${sets.join(', ')} WHERE workspace_id = ?`, [
      ...params,
      wsId,
    ]);
    res.json({ message: 'Workspace diperbarui' });
  })
);

// DELETE /api/workspaces/:id  (hanya owner; tugas di dalamnya ikut terhapus)
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const wsId = Number(req.params.id);
    const m = await requireMember(wsId, req.user.id);
    if (m.role !== 'owner') throw new HttpError(403, 'Hanya owner yang boleh menghapus workspace');

    await pool.query('DELETE FROM workspaces WHERE workspace_id = ?', [wsId]);
    res.json({ message: 'Workspace dihapus' });
  })
);

// POST /api/workspaces/:id/members  { email }  (hanya owner)
router.post(
  '/:id/members',
  asyncHandler(async (req, res) => {
    const wsId = Number(req.params.id);
    const m = await requireMember(wsId, req.user.id);
    if (m.role !== 'owner') throw new HttpError(403, 'Hanya owner yang boleh menambah anggota');

    const email = String(req.body?.email || '').trim().toLowerCase();
    const [users] = await pool.query('SELECT user_id, name, email FROM users WHERE email = ?', [email]);
    if (!users.length) throw new HttpError(404, 'Pengguna dengan email tersebut tidak ditemukan');

    const user = users[0];
    const [exist] = await pool.query(
      'SELECT member_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [wsId, user.user_id]
    );
    if (exist.length) throw new HttpError(409, 'Pengguna sudah menjadi anggota');

    await pool.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')",
      [wsId, user.user_id]
    );
    res.status(201).json({ ...user, role: 'member' });
  })
);

// DELETE /api/workspaces/:id/members/:userId
// owner boleh mengeluarkan anggota; anggota boleh keluar sendiri; owner tidak boleh keluar
router.delete(
  '/:id/members/:userId',
  asyncHandler(async (req, res) => {
    const wsId = Number(req.params.id);
    const targetId = Number(req.params.userId);
    const m = await requireMember(wsId, req.user.id);

    const isSelf = targetId === req.user.id;
    if (!isSelf && m.role !== 'owner') {
      throw new HttpError(403, 'Hanya owner yang boleh mengeluarkan anggota');
    }
    if (isSelf && m.role === 'owner') {
      throw new HttpError(400, 'Owner tidak bisa keluar. Hapus workspace jika sudah tidak dipakai');
    }

    await withTransaction(async (conn) => {
      await conn.query(
        `DELETE ta FROM task_assignments ta
           JOIN tasks t ON t.task_id = ta.task_id
          WHERE t.workspace_id = ? AND ta.user_id = ?`,
        [wsId, targetId]
      );
      await conn.query('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [
        wsId,
        targetId,
      ]);
    });
    res.json({ message: 'Anggota dikeluarkan' });
  })
);

export default router;
