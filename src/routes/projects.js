export default async function projectRoutes(app) {
  app.addHook('onRequest', app.authenticate);
  app.get('/', async (req) => app.prisma.project.findMany({
    where: { workspaceId: req.user.workspaceId }, orderBy: { createdAt: 'asc' },
  }));
  app.post('/', async (req) => app.prisma.project.create({
    data: { workspaceId: req.user.workspaceId, name: req.body.name, color: req.body.color || '#3b82f6' },
  }));
  app.delete('/:id', async (req, reply) => {
    const p = await app.prisma.project.findFirst({ where: { id: req.params.id, workspaceId: req.user.workspaceId } });
    if (!p) return reply.code(404).send({ error: 'not_found' });
    await app.prisma.project.delete({ where: { id: p.id } });
    return { ok: true };
  });
}
