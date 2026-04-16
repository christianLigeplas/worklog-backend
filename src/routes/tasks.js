// Construye filtro de visibilidad: el usuario ve task si:
// - es público
// - es privado y él es el creador
// - es shared y él es creador, asignado, o está en shares
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
    const { status, priority, projectId, assigneeId, from, to, q, mine } = req.query;
    const where = {
      workspaceId: req.user.workspaceId,
      AND: [visibilityFilter(req.user.id)],
    };
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (projectId) where.projectId = projectId;
    if (assigneeId) where.assigneeId = assigneeId;
    if (mine === '1') where.assigneeId = req.user.id;
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
      },
    });
  });

  app.get('/:id', async (req, reply) => {
    const task = await app.prisma.task.findFirst({
      where: {
        id: req.params.id,
        workspaceId: req.user.workspaceId,
        AND: [visibilityFilter(req.user.id)],
      },
      include: {
        attachments: true,
        comments: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true } } } },
        project: true,
        assignee: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        shares: { include: { user: { select: { id: true, name: true } } } },
      },
    });
    if (!task) return reply.code(404).send({ error: 'not_found' });
    return task;
  });

  app.post('/', async (req) => {
    const { title, description, projectId, dueDate, priority, tags, location, assigneeId, visibility, sharedWith } = req.body || {};
    const task = await app.prisma.task.create({
      data: {
        workspaceId: req.user.workspaceId,
        creatorId: req.user.id,
        assigneeId: assigneeId || req.user.id,
        title: title || 'Sin título',
        description,
        projectId: projectId || null,
        dueDate: dueDate ? new Date(dueDate) : null,
        priority: priority || 'medium',
        tags: tags || [],
        location: location || null,
        visibility: ['private', 'shared', 'public'].includes(visibility) ? visibility : 'public',
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
      if (remindAt > new Date())
        await app.prisma.reminder.create({ data: { taskId: task.id, remindAt } });
    }
    return task;
  });

  app.patch('/:id', async (req, reply) => {
    const t = await app.prisma.task.findFirst({
      where: { id: req.params.id, workspaceId: req.user.workspaceId },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    // Solo el creador puede cambiar visibility
    const data = { ...req.body };
    if (data.visibility && t.creatorId !== req.user.id) delete data.visibility;
    if (data.dueDate) data.dueDate = new Date(data.dueDate);
    if (data.status === 'done' && t.status !== 'done') data.completedAt = new Date();
    const sharedWith = data.sharedWith;
    delete data.sharedWith;
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
    return updated;
  });

  app.delete('/:id', async (req, reply) => {
    const t = await app.prisma.task.findFirst({
      where: { id: req.params.id, workspaceId: req.user.workspaceId },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.creatorId !== req.user.id) return reply.code(403).send({ error: 'only_creator_can_delete' });
    await app.prisma.task.delete({ where: { id: t.id } });
    return { ok: true };
  });

  app.post('/:id/comments', async (req, reply) => {
    const t = await app.prisma.task.findFirst({
      where: {
        id: req.params.id,
        workspaceId: req.user.workspaceId,
        AND: [visibilityFilter(req.user.id)],
      },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    return app.prisma.comment.create({
      data: { taskId: t.id, userId: req.user.id, text: req.body.text },
    });
  });
}
