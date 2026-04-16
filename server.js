import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { PrismaClient } from '@prisma/client';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import authRoutes from './src/routes/auth.js';
import taskRoutes from './src/routes/tasks.js';
import projectRoutes from './src/routes/projects.js';
import attachmentRoutes from './src/routes/attachments.js';
import summaryRoutes from './src/routes/summaries.js';
import assistantRoutes from './src/routes/assistant.js';
import workspaceRoutes from './src/routes/workspace.js';
import { startCronJobs } from './src/services/cron.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const prisma = new PrismaClient();
const app = Fastify({ logger: true, bodyLimit: 50 * 1024 * 1024 });

await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.JWT_SECRET || 'dev-secret-change-me' });
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
await app.register(fastifyStatic, { root: DATA_DIR, prefix: '/files/' });

app.decorate('prisma', prisma);
app.decorate('dataDir', DATA_DIR);
app.decorate('authenticate', async (req, reply) => {
  try { await req.jwtVerify(); }
  catch { reply.code(401).send({ error: 'unauthorized' }); }
});

app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

await app.register(authRoutes,        { prefix: '/auth' });
await app.register(workspaceRoutes,   { prefix: '/workspace' });
await app.register(projectRoutes,     { prefix: '/projects' });
await app.register(taskRoutes,        { prefix: '/tasks' });
await app.register(attachmentRoutes,  { prefix: '/attachments' });
await app.register(summaryRoutes,     { prefix: '/summaries' });
await app.register(assistantRoutes,   { prefix: '/assistant' });

startCronJobs(prisma);

const port = Number(process.env.PORT || 3000);
app.listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`✅ Server on http://localhost:${port}`))
  .catch(err => { console.error(err); process.exit(1); });