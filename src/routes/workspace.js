export default async function workspaceRoutes(app) {
  app.addHook('onRequest', app.authenticate);

  app.get('/members', async (req) => {
    return app.prisma.user.findMany({
      where: { workspaceId: req.user.workspaceId },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: 'asc' },
    });
  });

  app.get('/info', async (req) => {
    const ws = await app.prisma.workspace.findUnique({
      where: { id: req.user.workspaceId },
      select: { id: true, name: true, inviteCode: true },
    });
    // Solo owner puede ver el código de invitación
    if (req.user.role !== 'owner') ws.inviteCode = '••••••';
    return ws;
  });
}
