import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.routes.js';
import taskRoutes from './routes/tasks.routes.js';
import workspaceRoutes from './routes/workspaces.routes.js';
import { notFound, errorHandler } from './middleware/error.js';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ app: 'Agendaku API', status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/workspaces', workspaceRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
