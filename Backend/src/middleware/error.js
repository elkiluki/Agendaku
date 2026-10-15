export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Express 4 tidak menangkap error async otomatis, jadi dibungkus
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function notFound(req, res) {
  res.status(404).json({ message: 'Endpoint tidak ditemukan' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err.status) return res.status(err.status).json({ message: err.message });
  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ message: 'Data sudah ada' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Body JSON tidak valid' });
  }
  console.error(err);
  res.status(500).json({ message: 'Terjadi kesalahan pada server' });
}
