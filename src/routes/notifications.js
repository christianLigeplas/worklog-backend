import { getVapidPublicKey } from '../services/push.js';

export default async function notificationRoutes(app) {
  // Endpoint público: devuelve la clave pública para que el cliente pueda suscribirse
  app.get('/vapid-public-key', async () => ({ key: getVapidPublicKey() }));

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/notifications/vapid-public-key') return;
    try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'unauthorized' }); }
  });

  // Listar mis notificaciones
  app.get('/', async (req) => app.prisma.notification.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  }));

  // Contar no leídas
  app.get('/unread-count', async (req) => {
    const count = await app.prisma.notification.count({
      where: { userId: req.user.id, read: false },
    });
    return { count };
  });

  // Marcar todas como leídas
  app.post('/mark-all-read', async (req) => {
    await app.prisma.notification.updateMany({
      where: { userId: req.user.id, read: false },
      data: { read: true },
    });
    return { ok: true };
  });

  // Marcar una como leída
  app.post('/:id/read', async (req, reply) => {
    const n = await app.prisma.notification.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!n) return reply.code(404).send({ error: 'not_found' });
    await app.prisma.notification.update({ where: { id: n.id }, data: { read: true } });
    return { ok: true };
  });

  // Borrar notificación
  app.delete('/:id', async (req, reply) => {
    const n = await app.prisma.notification.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!n) return reply.code(404).send({ error: 'not_found' });
    await app.prisma.notification.delete({ where: { id: n.id } });
    return { ok: true };
  });

  // Suscribir endpoint push
  app.post('/subscribe', async (req) => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) return { error: 'invalid_subscription' };
    // Upsert por endpoint
    const existing = await app.prisma.pushSubscription.findUnique({ where: { endpoint } });
    if (existing) {
      if (existing.userId !== req.user.id) {
        await app.prisma.pushSubscription.update({
          where: { id: existing.id },
          data: { userId: req.user.id, p256dh: keys.p256dh, auth: keys.auth },
        });
      }
      return { ok: true };
    }
    await app.prisma.pushSubscription.create({
      data: { userId: req.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
    });
    return { ok: true };
  });

  // Desuscribir
  app.post('/unsubscribe', async (req) => {
    const { endpoint } = req.body || {};
    if (!endpoint) return { error: 'endpoint_required' };
    await app.prisma.pushSubscription.deleteMany({
      where: { endpoint, userId: req.user.id },
    });
    return { ok: true };
  });
}
