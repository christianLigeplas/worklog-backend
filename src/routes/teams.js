// Rutas para gestión de equipos
// Owner: crear, renombrar, eliminar
// Owner/Admin: añadir/quitar miembros

export default async function teamRoutes(app) {
  app.addHook('onRequest', app.authenticate);

  const isAdmin = (req) => req.user.role === 'owner' || req.user.role === 'admin';
  const isOwner = (req) => req.user.role === 'owner';

  // Listar equipos del workspace (todos los pueden ver)
  app.get('/', async (req) => {
    return app.prisma.team.findMany({
      where: { workspaceId: req.user.workspaceId },
      orderBy: { name: 'asc' },
      include: {
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
      },
    });
  });

  // Mis equipos
  app.get('/mine', async (req) => {
    return app.prisma.team.findMany({
      where: {
        workspaceId: req.user.workspaceId,
        members: { some: { userId: req.user.id } },
      },
      orderBy: { name: 'asc' },
      include: {
        members: { include: { user: { select: { id: true, name: true } } } },
      },
    });
  });

  // Crear equipo (solo owner)
  app.post('/', async (req, reply) => {
    if (!isOwner(req)) return reply.code(403).send({ error: 'owner_only' });
    const { name, color, memberIds } = req.body || {};
    if (!name?.trim()) return reply.code(400).send({ error: 'name_required' });
    const team = await app.prisma.team.create({
      data: {
        workspaceId: req.user.workspaceId,
        name: name.trim(),
        color: color || '#3b82f6',
      },
    });
    if (Array.isArray(memberIds) && memberIds.length) {
      await app.prisma.teamMember.createMany({
        data: memberIds.map(uid => ({ teamId: team.id, userId: uid })),
        skipDuplicates: true,
      });
    }
    return team;
  });

  // Actualizar equipo (owner)
  app.patch('/:id', async (req, reply) => {
    if (!isOwner(req)) return reply.code(403).send({ error: 'owner_only' });
    const t = await app.prisma.team.findFirst({
      where: { id: req.params.id, workspaceId: req.user.workspaceId },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const { name, color } = req.body || {};
    return app.prisma.team.update({
      where: { id: t.id },
      data: { ...(name ? { name: name.trim() } : {}), ...(color ? { color } : {}) },
    });
  });

  // Eliminar equipo (owner). Las tareas con ese teamId se ponen a global.
  app.delete('/:id', async (req, reply) => {
    if (!isOwner(req)) return reply.code(403).send({ error: 'owner_only' });
    const t = await app.prisma.team.findFirst({
      where: { id: req.params.id, workspaceId: req.user.workspaceId },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    // Convertir tareas del equipo a globales
    await app.prisma.task.updateMany({
      where: { teamId: t.id },
      data: { teamId: null, visibility: 'public' },
    });
    await app.prisma.team.delete({ where: { id: t.id } });
    return { ok: true };
  });

  // Añadir miembro (owner/admin)
  app.post('/:id/members/:userId', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin_only' });
    const t = await app.prisma.team.findFirst({
      where: { id: req.params.id, workspaceId: req.user.workspaceId },
    });
    if (!t) return reply.code(404).send({ error: 'team_not_found' });
    const u = await app.prisma.user.findFirst({
      where: { id: req.params.userId, workspaceId: req.user.workspaceId },
    });
    if (!u) return reply.code(404).send({ error: 'user_not_found' });
    await app.prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: t.id, userId: u.id } },
      update: {},
      create: { teamId: t.id, userId: u.id },
    });
    return { ok: true };
  });

  // Quitar miembro (owner/admin)
  app.delete('/:id/members/:userId', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin_only' });
    const t = await app.prisma.team.findFirst({
      where: { id: req.params.id, workspaceId: req.user.workspaceId },
    });
    if (!t) return reply.code(404).send({ error: 'team_not_found' });
    await app.prisma.teamMember.deleteMany({
      where: { teamId: t.id, userId: req.params.userId },
    });
    return { ok: true };
  });
}
