import bcrypt from 'bcrypt';

export default async function authRoutes(app) {
  // Registro: requiere código de invitación del workspace
  app.post('/register', async (req, reply) => {
    const { email, password, name, inviteCode } = req.body || {};
    if (!email || !password || !name) return reply.code(400).send({ error: 'missing_fields' });

    let workspace;
    if (inviteCode) {
      workspace = await app.prisma.workspace.findUnique({ where: { inviteCode } });
      if (!workspace) return reply.code(400).send({ error: 'invalid_invite_code' });
    } else {
      // Sin código: ¿es el primer usuario? Crea el workspace inicial con código maestro
      const masterCode = process.env.WORKSPACE_INVITE_CODE || 'EQUIPO2026';
      workspace = await app.prisma.workspace.findUnique({ where: { inviteCode: masterCode } });
      if (!workspace) {
        workspace = await app.prisma.workspace.create({
          data: { name: 'Mi Equipo', inviteCode: masterCode },
        });
      }
    }

    const exists = await app.prisma.user.findUnique({ where: { email } });
    if (exists) return reply.code(409).send({ error: 'email_in_use' });

    const userCount = await app.prisma.user.count({ where: { workspaceId: workspace.id } });
    const role = userCount === 0 ? 'owner' : 'member';

    const user = await app.prisma.user.create({
      data: {
        email, name,
        passwordHash: await bcrypt.hash(password, 10),
        workspaceId: workspace.id,
        role,
      },
    });

    const token = app.jwt.sign({ id: user.id, workspaceId: workspace.id, role });
    return { token, user: { id: user.id, email, name, role }, workspace: { id: workspace.id, name: workspace.name } };
  });

  app.post('/login', async (req, reply) => {
    const { email, password } = req.body || {};
    const user = await app.prisma.user.findUnique({
      where: { email }, include: { workspace: true },
    });
    if (!user || !await bcrypt.compare(password, user.passwordHash))
      return reply.code(401).send({ error: 'invalid_credentials' });

    const token = app.jwt.sign({ id: user.id, workspaceId: user.workspaceId, role: user.role });
    return {
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      workspace: { id: user.workspace.id, name: user.workspace.name },
    };
  });

  app.post('/push-token', { onRequest: [app.authenticate] }, async (req) => {
    await app.prisma.user.update({
      where: { id: req.user.id }, data: { pushToken: req.body.token },
    });
    return { ok: true };
  });
}
