import 'dotenv/config';
import mysql from 'mysql2/promise';

export const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'agendaku',
  waitForConnections: true,
  connectionLimit: 10,
  timezone: 'Z', // semua waktu disimpan & dibaca sebagai UTC
});

// Paksa session MySQL memakai UTC supaya NOW() konsisten dengan data DATETIME
pool.pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

// Helper transaksi: otomatis commit, rollback bila error
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
