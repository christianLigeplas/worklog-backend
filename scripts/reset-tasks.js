// Reset: borra SOLO tareas y lo asociado. Conserva usuarios y workspace.
// Se ejecuta si RESET_TASKS=1. Después, QUITAR la variable.

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  if (process.env.RESET_TASKS !== '1') {
    console.log('🧹 RESET_TASKS no activo. Saltando.');
    return;
  }

  console.log('🧹 Iniciando limpieza de tareas...');

  const [delNotif, delChat, delReminders, delComments, delAttach, delAssignees, delTasks] =
    await prisma.$transaction([
      prisma.notification.deleteMany({}),
      prisma.chatMessage.deleteMany({}),
      prisma.reminder.deleteMany({}),
      prisma.comment.deleteMany({}),
      prisma.attachment.deleteMany({}),
      prisma.taskAssignee.deleteMany({}),
      prisma.task.deleteMany({}),
    ]);

  console.log(`✅ Limpieza completa:
    - Tareas: ${delTasks.count}
    - Notificaciones: ${delNotif.count}
    - Chats: ${delChat.count}
    - Recordatorios: ${delReminders.count}
    - Comentarios: ${delComments.count}
    - Adjuntos: ${delAttach.count}
    - Asignaciones: ${delAssignees.count}`);
}

main()
  .catch(e => { console.error('❌ Error reset:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
