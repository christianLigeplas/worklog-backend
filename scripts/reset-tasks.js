// Script de limpieza: borra solo tareas, notificaciones, chats, recordatorios.
// Conserva usuarios, workspaces y equipos.
// Se ejecuta si la variable RESET_TASKS=1 está presente. Después de ejecutar con éxito,
// QUITAR esa variable en Railway para evitar que se ejecute dos veces.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  if (process.env.RESET_TASKS !== '1') {
    console.log('🧹 RESET_TASKS no está activo. Saltando limpieza.');
    return;
  }

  console.log('🧹 Iniciando limpieza de tareas...');

  // Orden importa: primero lo que depende de tasks, luego tasks
  const [
    delNotif, delChat, delReminders, delComments, delAttach, delAssignees, delTasks,
  ] = await prisma.$transaction([
    prisma.notification.deleteMany({}),
    prisma.chatMessage.deleteMany({}),
    prisma.reminder.deleteMany({}),
    prisma.comment.deleteMany({}),
    prisma.attachment.deleteMany({}),
    prisma.taskAssignee.deleteMany({}),
    prisma.task.deleteMany({}),
  ]);

  console.log(`✅ Limpieza completa:
    - Tareas borradas: ${delTasks.count}
    - Notificaciones: ${delNotif.count}
    - Chats: ${delChat.count}
    - Recordatorios: ${delReminders.count}
    - Comentarios: ${delComments.count}
    - Adjuntos: ${delAttach.count}
    - Asignaciones: ${delAssignees.count}`);

  // Crear equipo "General" en cada workspace si no existe, con todos los miembros
  const workspaces = await prisma.workspace.findMany({
    include: { members: { select: { id: true } }, teams: true },
  });
  for (const ws of workspaces) {
    const hasGeneral = ws.teams.some(t => t.name === 'General');
    if (!hasGeneral && ws.members.length > 0) {
      const team = await prisma.team.create({
        data: { workspaceId: ws.id, name: 'General', color: '#3b82f6' },
      });
      await prisma.teamMember.createMany({
        data: ws.members.map(m => ({ teamId: team.id, userId: m.id })),
        skipDuplicates: true,
      });
      console.log(`✅ Equipo "General" creado en workspace ${ws.name} con ${ws.members.length} miembros`);
    }
  }
}

main()
  .catch(e => { console.error('❌ Error en limpieza:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
