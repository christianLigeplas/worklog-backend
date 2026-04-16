import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

// Tipos permitidos: imágenes + documentos comunes
const ALLOWED = [
  'image/', 'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument',
  'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'text/', 'application/zip', 'application/x-zip-compressed',
  'application/json', 'application/vnd.oasis.opendocument',
];

export default async function attachmentRoutes(app) {
  app.addHook('onRequest', app.authenticate);

  app.post('/:taskId', async (req, reply) => {
    const task = await app.prisma.task.findFirst({
      where: { id: req.params.taskId, workspaceId: req.user.workspaceId },
    });
    if (!task) return reply.code(404).send({ error: 'task_not_found' });
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'no_file' });

    // Permitir tipos comunes; rechazar binarios raros
    const mime = data.mimetype || 'application/octet-stream';
    const ok = ALLOWED.some(prefix => mime.startsWith(prefix));
    if (!ok) return reply.code(400).send({ error: 'file_type_not_allowed', mime });

    const projectFolder = task.projectId || 'inbox';
    const relDir = path.join('workspaces', req.user.workspaceId, 'projects', projectFolder, 'tasks', task.id, 'files');
    const absDir = path.join(app.dataDir, relDir);
    fs.mkdirSync(absDir, { recursive: true });

    const safeName = `${Date.now()}-${data.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const absPath = path.join(absDir, safeName);
    await pipeline(data.file, fs.createWriteStream(absPath));
    const stat = fs.statSync(absPath);

    return app.prisma.attachment.create({
      data: {
        taskId: task.id, filename: data.filename,
        path: path.join(relDir, safeName).replace(/\\/g, '/'),
        mimeType: mime, sizeBytes: BigInt(stat.size),
      },
    });
  });

  app.delete('/:id', async (req, reply) => {
    const att = await app.prisma.attachment.findUnique({
      where: { id: req.params.id }, include: { task: true },
    });
    if (!att || att.task.workspaceId !== req.user.workspaceId)
      return reply.code(404).send({ error: 'not_found' });
    const abs = path.join(app.dataDir, att.path);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
    await app.prisma.attachment.delete({ where: { id: att.id } });
    return { ok: true };
  });
}
