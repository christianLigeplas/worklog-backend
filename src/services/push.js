import webpush from 'web-push';

let configured = false;

export function initPush() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const mail = process.env.VAPID_EMAIL || 'mailto:admin@ligeplas.local';

  if (!pub || !priv) {
    console.warn('⚠️  VAPID keys no configuradas — push notifications desactivadas. Genera con: npx web-push generate-vapid-keys');
    return;
  }
  webpush.setVapidDetails(mail, pub, priv);
  configured = true;
  console.log('✅ Push VAPID configurado');
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

// Envía push a un endpoint concreto. Si está expirado, devolver null para borrarlo.
export async function sendPushToSubscription(sub, payload) {
  if (!configured) return false;
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      JSON.stringify(payload)
    );
    return true;
  } catch (e) {
    // 410 Gone → sub expirada
    if (e.statusCode === 410 || e.statusCode === 404) return 'expired';
    console.error('push error', e.statusCode, e.body);
    return false;
  }
}

// Envía push a todas las subs de un usuario. Borra las expiradas.
export async function sendPushToUser(prisma, userId, payload) {
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  for (const s of subs) {
    const r = await sendPushToSubscription(s, payload);
    if (r === 'expired') {
      await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
    }
  }
}
