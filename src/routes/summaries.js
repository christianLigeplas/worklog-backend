import { visibilityWhere, getUserTeamIds } from '../utils/visibility.js';

export default async function summaryRoutes(app) {
  app.addHook('onRequest', app.authenticate);

  app.get('/daily', async (req) => {
    const userId = req.user.id;
    const wid = req.user.workspaceId;
    const teamIds = await getUserTeamIds(app.prisma, userId);

    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);

    const baseAnd = [
      { workspaceId: wid },
      { archived: false },
      visibilityWhere(userId, teamIds),
    ];
    const include = {
      assignee: { select: { id: true, name: true } },
      creator: { select: { id: true, name: true } },
      team: { select: { id: true, name: true, color: true } },
    };

    const [myTasks, dueToday, overdue, highPriority, completedToday] = await Promise.all([
      // Mis tareas: asignadas a mí (principal o múltiple) y no completadas
      app.prisma.task.findMany({
        where: {
          AND: [
            ...baseAnd,
            {
              OR: [
                { assigneeId: userId },
                { assignees: { some: { userId } } },
              ],
            },
            { status: { not: 'done' } },
          ],
        },
        orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
        include, take: 20,
      }),
      app.prisma.task.findMany({
        where: {
          AND: [
            ...baseAnd,
            { status: { not: 'done' } },
            { dueDate: { gte: startOfDay, lte: endOfDay } },
          ],
        },
        orderBy: { dueDate: 'asc' },
        include, take: 20,
      }),
      app.prisma.task.findMany({
        where: {
          AND: [
            ...baseAnd,
            { status: { not: 'done' } },
            { dueDate: { lt: startOfDay } },
          ],
        },
        orderBy: { dueDate: 'asc' },
        include, take: 20,
      }),
      app.prisma.task.findMany({
        where: {
          AND: [
            ...baseAnd,
            { status: { not: 'done' } },
            { priority: 'high' },
          ],
        },
        orderBy: { dueDate: 'asc' },
        include, take: 20,
      }),
      app.prisma.task.count({
        where: {
          AND: [
            ...baseAnd,
            { status: 'done' },
            { completedAt: { gte: startOfDay, lte: endOfDay } },
          ],
        },
      }),
    ]);

    return { myTasks, dueToday, overdue, highPriority, completedToday };
  });
}
