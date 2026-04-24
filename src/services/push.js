import webpush from 'web-push';

let configured = false;

export function initPush() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const mail = process.env.VAPID_EMAIL || 'mailto:admin@ligeplas.local';

  if (!pub || !priv) {
    console.warn('⚠️  VAPID keys no configuradas — push desactivadas');
    return;
  }
  webpush.setVapidDetails(mail, pub, priv);
  configured = true;
  console.log('✅ Push VAPID configurado');
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export async function sendPushToSubscription(sub, payload) {
  if (!configured) return false;
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return true;
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) return 'expired';
    console.error('push error', e.statusCode, e.body);
    return false;
  }
}

export async function sendPushToUser(prisma, userId, payload) {
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  for (const s of subs) {
    const r = await sendPushToSubscription(s, payload);
    if (r === 'expired') {
      await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
    }
  }
}
