import { sendPushToUser } from '../services/push.js';

function visibilityFilter(userId) {
  return {
    OR: [
      { visibility: 'public' },
      { visibility: 'private', creatorId: userId },
      { visibility: 'shared', OR: [
          { creatorId: userId },
          { assigneeId: userId },
          { shares: { some: { userId } } },
        ]
      },
    ],
  };
}

export default async function taskRoutes(app) {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const { status, priority, projectId, assigneeId, from, to, q, mine, visibility, archived } = req.query;
    const where = { workspaceId: req.user.workspaceId, AND: [visibilityFilter(req.user.id)] };
    // Por defecto solo no archivadas
    where.archived = archived === '1' || archived === 'true';
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (projectId) where.projectId = projectId;
    if (assigneeId) where.assigneeId = assigneeId;
    if (mine === '1') where.assigneeId = req.user.id;
    if (visibility === 'private') where.AND.push({ visibility: 'private', creatorId: req.user.id });
    else if (visibility === 'public') where.AND.push({ visibility: 'public' });
    if (from || to) where.dueDate = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    };
    if (q) where.AND.push({
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ],
    });
    return app.prisma.task.findMany({
      where,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      include: {
        attachments: true,
        comments: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true } } } },
        project: true,
        assignee: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        shares: { include: { user: { select: { id: true, name: true } } } },
        reminders: { where: { sent: false }, orderBy: { remindAt: 'asc' } },
      },
    });
  });

  app.get('/:id', async (req, reply) => {
    const task = await app.prisma.task.findFirst({
      where: { id: req.params.id, workspaceId: req.user.workspaceId, AND: [visibilityFilter(req.user.id)] },
      include: {
        attachments: true,
        comments: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true } } } },
        project: true,
        assignee: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        shares: { include: { user: { select: { id: true, name: true } } } },
        reminders: { where: { sent: false }, orderBy: { remindAt: 'asc' } },
      },
    });
    if (!task) return reply.code(404).send({ error: 'not_found' });
    return task;
  });

  app.post('/', async (req) => {
    const { title, description, projectId, dueDate, startDate, priority, tags, location, assigneeId, visibility, sharedWith } = req.body || {};
    const task = await app.prisma.task.create({
      data: {
        workspaceId: req.user.workspaceId,
        creatorId: req.user.id,
        assigneeId: assigneeId || req.user.id,
        title: title || 'Sin título',
        description, projectId: projectId || null,
        dueDate: dueDate ? new Date(dueDate) : null,
        startDate: startDate ? new Date(startDate) : null,
        priority: priority || 'medium',
        tags: tags || [], location: location || null,
        visibility: ['private', 'shared', 'public'].includes(visibility) ? visibility : 'private',
      },
    });
    if (Array.isArray(sharedWith) && sharedWith.length) {
      await app.prisma.taskShare.createMany({
        data: sharedWith.map((uid) => ({ taskId: task.id, userId: uid })),
        skipDuplicates: true,
      });
    }
    if (task.dueDate) {
      const remindAt = new Date(task.dueDate.getTime() - 60 * 60 * 1000);
      if (remindAt > new Date()) await app.prisma.reminder.create({ data: { taskId: task.id, remindAt } });
    }
    // Notifica al asignado si es distinto del creador
    if (task.assigneeId && task.assigneeId !== req.user.id) {
      await app.prisma.notification.create({
        data: { userId: task.assigneeId, taskId: task.id,
          title: '📌 Nueva tarea asignada', body: task.title },
      });
      await sendPushToUser(app.prisma, task.assigneeId, {
        title: '📌 Nueva tarea asignada', body: task.title,
        taskId: task.id, url: `/task/${task.id}`,
      });
    }
    return task;
  });

  app.patch('/:id', async (req, reply) => {
    const t = await app.prisma.task.findFirst({ where: { id: req.params.id, workspaceId: req.user.workspaceId } });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const data = { ...req.body };
    if (data.visibility && t.creatorId !== req.user.id) delete data.visibility;
    if (data.dueDate) data.dueDate = new Date(data.dueDate);
    if (data.startDate) data.startDate = new Date(data.startDate);
    if (data.status === 'done' && t.status !== 'done') data.completedAt = new Date();
    const sharedWith = data.sharedWith; delete data.sharedWith;
    const updated = await app.prisma.task.update({ where: { id: t.id }, data });
    if (Array.isArray(sharedWith)) {
      await app.prisma.taskShare.deleteMany({ where: { taskId: t.id } });
      if (sharedWith.length) {
        await app.prisma.taskShare.createMany({
          data: sharedWith.map((uid) => ({ taskId: t.id, userId: uid })),
          skipDuplicates: true,
        });
      }
    }
    // Notificar al asignado si ha cambiado
    if (data.assigneeId && data.assigneeId !== t.assigneeId && data.assigneeId !== req.user.id) {
      await app.prisma.notification.create({
        data: { userId: data.assigneeId, taskId: t.id,
          title: '👤 Te han asignado una tarea', body: updated.title },
      });
      await sendPushToUser(app.prisma, data.assigneeId, {
        title: '👤 Te han asignado una tarea', body: updated.title,
        taskId: t.id, url: `/task/${t.id}`,
      });
    }
    return updated;
  });

  // 📦 Archivar / desarchivar
  app.post('/:id/archive', async (req, reply) => {
    const t = await app.prisma.task.findFirst({ where: { id: req.params.id, workspaceId: req.user.workspaceId } });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    return app.prisma.task.update({
      where: { id: t.id },
      data: { archived: true, archivedAt: new Date() },
    });
  });

  app.post('/:id/unarchive', async (req, reply) => {
    const t = await app.prisma.task.findFirst({ where: { id: req.params.id, workspaceId: req.user.workspaceId } });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    return app.prisma.task.update({
      where: { id: t.id },
      data: { archived: false, archivedAt: null },
    });
  });

  app.delete('/:id', async (req, reply) => {
    const t = await app.prisma.task.findFirst({ where: { id: req.params.id, workspaceId: req.user.workspaceId } });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.creatorId !== req.user.id && req.user.role !== 'owner' && req.user.role !== 'admin')
      return reply.code(403).send({ error: 'only_creator_or_admin' });
    await app.prisma.task.delete({ where: { id: t.id } });
    return { ok: true };
  });

  app.post('/:id/comments', async (req, reply) => {
    const t = await app.prisma.task.findFirst({
      where: { id: req.params.id, workspaceId: req.user.workspaceId, AND: [visibilityFilter(req.user.id)] },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    return app.prisma.comment.create({ data: { taskId: t.id, userId: req.user.id, text: req.body.text } });
  });

  // 🔔 Crear recordatorio manual para una tarea
  app.post('/:id/reminders', async (req, reply) => {
    const t = await app.prisma.task.findFirst({
      where: { id: req.params.id, workspaceId: req.user.workspaceId, AND: [visibilityFilter(req.user.id)] },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const { remindAt, message } = req.body || {};
    if (!remindAt) return reply.code(400).send({ error: 'remindAt_required' });
    return app.prisma.reminder.create({
      data: {
        taskId: t.id,
        userId: req.user.id,
        message: message || null,
        remindAt: new Date(remindAt),
      },
    });
  });

  app.delete('/:id/reminders/:reminderId', async (req, reply) => {
    const t = await app.prisma.task.findFirst({
      where: { id: req.params.id, workspaceId: req.user.workspaceId },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    await app.prisma.reminder.deleteMany({
      where: { id: req.params.reminderId, taskId: t.id },
    });
    return { ok: true };
  });
}
