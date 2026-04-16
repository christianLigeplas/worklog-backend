export default async function taskRoutes(app) {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const { status, priority, projectId, assigneeId, from, to, q, mine } = req.query;
    const where = { workspaceId: req.user.workspaceId };
    if (status)     where.status = status;
    if (priority)   where.priority = priority;
    if (projectId)  where.projectId = projectId;
    if (assigneeId) where.assigneeId = assigneeId;
    if (mine === '1') where.assigneeId = req.user.id;
    if (from || to) where.dueDate = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to   ? { lte: new Date(to)   } : {})
    };
    if (q) where.OR = [
      { title:       { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
    return app.prisma.task.findMany({
      where,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      include: {
        attachments: true,
        comments: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true } } } },
        project: true,
        assignee: { select: { id: true, name: true } },
        creator:  { select: { id: true, name: true } },
      },
    });
  });

  app.get('/:id', async (req, reply) => {
    const task = await app.prisma.task.findFirst({
      where: { id: req.params.id, workspaceId: req.user.workspaceId },
      include: {
        attachments: true,
        comments: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true } } } },
        project: true,
        assignee: { select: { id: true, name: true } },
        creator:  { select: { id: true, name: true } },
      },
    });
    if (!task) return reply.code(404).send({ error: 'not_found' });
    return task;
  });

  app.post('/', async (req) => {
    const { title, description, projectId, dueDate, priority, tags, location, assigneeId } = req.body || {};
    const task = await app.prisma.task.create({
      data: {
        workspaceId: req.user.workspaceId,
        creatorId:   req.user.id,
        assigneeId:  assigneeId || req.user.id,
        title:       title || 'Sin título',
        description, projectId: projectId || null,
        dueDate:     dueDate ? new Date(dueDate) : null,
        priority:    priority || 'medium',
        tags:        tags || [],
        location:    location || null,
      },
    });
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
    const data = { ...req.body };
    if (data.dueDate) data.dueDate = new Date(data.dueDate);
    if (data.status === 'done' && t.status !== 'done') data.completedAt = new Date();
    return app.prisma.task.update({ where: { id: t.id }, data });
  });

  app.delete('/:id', async (req, reply) => {
    const t = await app.prisma.task.findFirst({
      where: { id: req.params.id, workspaceId: req.user.workspaceId },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    await app.prisma.task.delete({ where: { id: t.id } });
    return { ok: true };
  });

  app.post('/:id/comments', async (req, reply) => {
    const t = await app.prisma.task.findFirst({
      where: { id: req.params.id, workspaceId: req.user.workspaceId },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    return app.prisma.comment.create({
      data: { taskId: t.id, userId: req.user.id, text: req.body.text },
    });
  });
}
