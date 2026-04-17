import crypto from 'node:crypto';

export default async function workspaceRoutes(app) {
  app.addHook('onRequest', app.authenticate);

  // Info del workspace
  app.get('/info', async (req) => {
    const ws = await app.prisma.workspace.findUnique({
      where: { id: req.user.workspaceId },
      select: { id: true, name: true, inviteCode: true },
    });
    if (req.user.role !== 'owner' && req.user.role !== 'admin') ws.inviteCode = '••••••';
    return ws;
  });

  // Lista de miembros
  app.get('/members', async (req) => app.prisma.user.findMany({
    where: { workspaceId: req.user.workspaceId },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
    orderBy: { name: 'asc' },
  }));

  // === ADMIN ROUTES ===

  // Miembros con conteo de tareas
  app.get('/admin/members', async (req, reply) => {
    if (req.user.role !== 'owner' && req.user.role !== 'admin')
      return reply.code(403).send({ error: 'admin_only' });

    const members = await app.prisma.user.findMany({
      where: { workspaceId: req.user.workspaceId },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
      orderBy: { name: 'asc' },
    });

    // Contar tareas por usuario
    const counts = await app.prisma.task.groupBy({
      by: ['assigneeId'],
      where: { workspaceId: req.user.workspaceId },
      _count: { id: true },
    });
    const countMap = {};
    for (const c of counts) countMap[c.assigneeId] = c._count.id;

    const pending = await app.prisma.task.groupBy({
      by: ['assigneeId'],
      where: { workspaceId: req.user.workspaceId, status: { not: 'done' } },
      _count: { id: true },
    });
    const pendingMap = {};
    for (const c of pending) pendingMap[c.assigneeId] = c._count.id;

    return members.map(m => ({
      ...m,
      totalTasks: countMap[m.id] || 0,
      pendingTasks: pendingMap[m.id] || 0,
    }));
  });

  // Cambiar rol de usuario
  app.patch('/admin/members/:userId/role', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner_only' });
    const { role } = req.body || {};
    if (!['member', 'admin'].includes(role)) return reply.code(400).send({ error: 'invalid_role' });

    const target = await app.prisma.user.findFirst({
      where: { id: req.params.userId, workspaceId: req.user.workspaceId },
    });
    if (!target) return reply.code(404).send({ error: 'user_not_found' });
    if (target.id === req.user.id) return reply.code(400).send({ error: 'cannot_change_own_role' });

    return app.prisma.user.update({ where: { id: target.id }, data: { role } });
  });

  // Eliminar usuario (reasigna tareas si se pasa reassignTo)
  app.delete('/admin/members/:userId', async (req, reply) => {
    if (req.user.role !== 'owner' && req.user.role !== 'admin')
      return reply.code(403).send({ error: 'admin_only' });

    const target = await app.prisma.user.findFirst({
      where: { id: req.params.userId, workspaceId: req.user.workspaceId },
    });
    if (!target) return reply.code(404).send({ error: 'user_not_found' });
    if (target.role === 'owner') return reply.code(400).send({ error: 'cannot_delete_owner' });
    if (target.id === req.user.id) return reply.code(400).send({ error: 'cannot_delete_self' });

    const { reassignTo } = req.query;
    if (reassignTo) {
      await app.prisma.task.updateMany({
        where: { assigneeId: target.id, workspaceId: req.user.workspaceId },
        data: { assigneeId: reassignTo },
      });
    }

    await app.prisma.user.delete({ where: { id: target.id } });
    return { ok: true };
  });

  // Regenerar código de invitación
  app.post('/admin/regenerate-code', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner_only' });
    const newCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const ws = await app.prisma.workspace.update({
      where: { id: req.user.workspaceId },
      data: { inviteCode: newCode },
    });
    return { inviteCode: ws.inviteCode };
  });

  // Ver todas las tareas (admin) — sin filtro de visibilidad
  app.get('/admin/tasks', async (req, reply) => {
    if (req.user.role !== 'owner' && req.user.role !== 'admin')
      return reply.code(403).send({ error: 'admin_only' });

    const { assigneeId, status } = req.query;
    const where = { workspaceId: req.user.workspaceId };
    if (assigneeId) where.assigneeId = assigneeId;
    if (status) where.status = status;

    return app.prisma.task.findMany({
      where,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      include: {
        assignee: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
      take: 200,
    });
  });

  // Reasignar tarea (admin)
  app.patch('/admin/tasks/:taskId/reassign', async (req, reply) => {
    if (req.user.role !== 'owner' && req.user.role !== 'admin')
      return reply.code(403).send({ error: 'admin_only' });

    const { assigneeId } = req.body || {};
    if (!assigneeId) return reply.code(400).send({ error: 'assignee_required' });

    const task = await app.prisma.task.findFirst({
      where: { id: req.params.taskId, workspaceId: req.user.workspaceId },
    });
    if (!task) return reply.code(404).send({ error: 'task_not_found' });

    return app.prisma.task.update({
      where: { id: task.id },
      data: { assigneeId },
      include: { assignee: { select: { id: true, name: true } } },
    });
  });
}
