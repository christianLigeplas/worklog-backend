import bcrypt from 'bcrypt';
import crypto from 'node:crypto';

export default async function authRoutes(app) {
  // Login
  app.post('/login', async (req, reply) => {
    const { email, password } = req.body || {};
    if (!email || !password) return reply.code(400).send({ error: 'missing_fields' });
    const user = await app.prisma.user.findUnique({ where: { email } });
    if (!user) return reply.code(401).send({ error: 'invalid_credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: 'invalid_credentials' });
    const token = app.jwt.sign({ id: user.id, workspaceId: user.workspaceId, role: user.role });
    return {
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, workspaceId: user.workspaceId },
    };
  });

  // Register
  app.post('/register', async (req, reply) => {
    const { email, password, name, inviteCode } = req.body || {};
    if (!email || !password || !name) return reply.code(400).send({ error: 'missing_fields' });

    const exists = await app.prisma.user.findUnique({ where: { email } });
    if (exists) return reply.code(409).send({ error: 'email_in_use' });

    let workspaceId; let role = 'owner';
    if (inviteCode) {
      const envCode = process.env.WORKSPACE_INVITE_CODE;
      const envMatches = envCode && envCode === inviteCode;
      let ws = null;
      if (envMatches) {
        ws = await app.prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' } });
      } else {
        ws = await app.prisma.workspace.findUnique({ where: { inviteCode } });
      }
      if (!ws) return reply.code(400).send({ error: 'invalid_invite_code' });
      workspaceId = ws.id;
      role = 'member';
    } else {
      const newWs = await app.prisma.workspace.create({
        data: {
          name: `${name}'s workspace`,
          inviteCode: crypto.randomBytes(4).toString('hex').toUpperCase(),
        },
      });
      workspaceId = newWs.id;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await app.prisma.user.create({
      data: { email, passwordHash, name, workspaceId, role },
    });

    // Añadir al equipo "General" si existe, o crearlo
    let general = await app.prisma.team.findFirst({
      where: { workspaceId, name: 'General' },
    });
    if (!general) {
      general = await app.prisma.team.create({
        data: { workspaceId, name: 'General', color: '#3b82f6' },
      });
    }
    await app.prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: general.id, userId: user.id } },
      update: {},
      create: { teamId: general.id, userId: user.id },
    });

    const token = app.jwt.sign({ id: user.id, workspaceId, role: user.role });
    return {
      token,
      user: { id: user.id, email, name, role: user.role, workspaceId },
    };
  });
}
