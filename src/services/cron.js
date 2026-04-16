import cron from 'node-cron';
import { Expo } from 'expo-server-sdk';

const expo = new Expo();
async function sendPush(token, title, body, data = {}) {
  if (!Expo.isExpoPushToken(token)) return;
  try { await expo.sendPushNotificationsAsync([{ to: token, sound: 'default', title, body, data }]); }
  catch (e) { console.error('push', e); }
}

export function startCronJobs(prisma) {
  cron.schedule('* * * * *', async () => {
    const due = await prisma.reminder.findMany({
      where: { sent: false, remindAt: { lte: new Date() } },
      include: { task: { include: { assignee: true, creator: true } } },
      take: 50,
    });
    for (const r of due) {
      const target = r.task.assignee || r.task.creator;
      if (target?.pushToken) {
        await sendPush(target.pushToken, `⏰ ${r.task.title}`,
          r.task.dueDate ? `Vence ${r.task.dueDate.toLocaleString('es-ES')}` : 'Recordatorio',
          { taskId: r.task.id });
      }
      await prisma.reminder.update({ where: { id: r.id }, data: { sent: true } });
    }
  });
}
