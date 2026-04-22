import cron from 'node-cron';
import { sendPushToUser } from './push.js';

export function startCronJobs(prisma) {
  // Cada minuto: comprueba recordatorios que haya que disparar
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      const due = await prisma.reminder.findMany({
        where: { sent: false, remindAt: { lte: now } },
        include: {
          task: {
            include: {
              assignee: { select: { id: true, name: true } },
              creator: { select: { id: true, name: true } },
            },
          },
        },
        take: 50,
      });

      for (const r of due) {
        if (!r.task) { await prisma.reminder.delete({ where: { id: r.id } }); continue; }
        // Destinatario: el userId del reminder, o asignado, o creador
        const targetUserId = r.userId || r.task.assigneeId || r.task.creatorId;
        if (!targetUserId) { await prisma.reminder.update({ where: { id: r.id }, data: { sent: true } }); continue; }

        const title = '🔔 Recordatorio';
        const body = r.message || r.task.title;

        // Crear notificación in-app
        await prisma.notification.create({
          data: { userId: targetUserId, taskId: r.task.id, title, body },
        });

        // Enviar push
        await sendPushToUser(prisma, targetUserId, {
          title, body, taskId: r.task.id, url: `/task/${r.task.id}`,
        });

        await prisma.reminder.update({ where: { id: r.id }, data: { sent: true } });
      }
    } catch (e) {
      console.error('cron reminder error', e);
    }
  });
  console.log('✅ Cron jobs started');
}
