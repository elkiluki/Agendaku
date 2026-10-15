import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Expo } from 'expo-server-sdk';
import { pool } from '../config/db.js';
import { auth } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/error.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const signToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });

// POST /api/auth/register  (US-05)
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!name) throw new HttpError(400, 'Nama wajib diisi');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Format email tidak valid');
    if (password.length < 6) throw new HttpError(400, 'Password minimal 6 karakter');

    const [exist] = await pool.query('SELECT user_id FROM users WHERE email = ?', [email]);
    if (exist.length) throw new HttpError(409, 'Email sudah terdaftar');

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
      [name, email, hash]
    );

    res.status(201).json({
      token: signToken(result.insertId),
      user: { user_id: result.insertId, name, email },
    });
  })
);

// POST /api/auth/login  (US-05)
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    const [rows] = await pool.query(
      'SELECT user_id, name, email, password FROM users WHERE email = ?',
      [email]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new HttpError(401, 'Email atau password salah');
    }

    res.json({
      token: signToken(user.user_id),
      user: { user_id: user.user_id, name: user.name, email: user.email },
    });
  })
);

// GET /api/auth/me
router.get(
  '/me',
  auth,
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      'SELECT user_id, name, email, created_at FROM users WHERE user_id = ?',
      [req.user.id]
    );
    if (!rows.length) throw new HttpError(404, 'User tidak ditemukan');
    res.json(rows[0]);
  })
);

// PUT /api/auth/push-token  { push_token: "ExponentPushToken[...]" | null }
router.put(
  '/push-token',
  auth,
  asyncHandler(async (req, res) => {
    const token = req.body?.push_token ?? null;
    if (token !== null && !Expo.isExpoPushToken(token)) {
      throw new HttpError(400, 'Push token Expo tidak valid');
    }
    if (token) {
      // satu perangkat hanya milik satu akun
      await pool.query('UPDATE users SET push_token = NULL WHERE push_token = ? AND user_id <> ?', [
        token,
        req.user.id,
      ]);
    }
    await pool.query('UPDATE users SET push_token = ? WHERE user_id = ?', [token, req.user.id]);
    res.json({ message: 'Push token diperbarui' });
  })
);

export default router;
