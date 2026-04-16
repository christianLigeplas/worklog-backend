export default async function summaryRoutes(app) {
  app.addHook('onRequest', app.authenticate);

  app.get('/daily', async (req) => {
    const wid = req.user.workspaceId;
    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date();   end.setHours(23,59,59,999);

    const includeBase = {
      assignee: { select: { id: true, name: true } },
      project: { select: { name: true, color: true } },
    };

    const [dueToday, overdue, completedToday, highPriority, myTasks] = await Promise.all([
      app.prisma.task.findMany({
        where: { workspaceId: wid, status: { not: 'done' }, dueDate: { gte: start, lte: end } },
        orderBy: { priority: 'desc' }, include: includeBase,
      }),
      app.prisma.task.findMany({
        where: { workspaceId: wid, status: { not: 'done' }, dueDate: { lt: start } },
        include: includeBase,
      }),
      app.prisma.task.count({
        where: { workspaceId: wid, status: 'done', completedAt: { gte: start, lte: end } },
      }),
      app.prisma.task.findMany({
        where: { workspaceId: wid, status: { not: 'done' }, priority: 'high' },
        take: 5, include: includeBase,
      }),
      app.prisma.task.findMany({
        where: { workspaceId: wid, assigneeId: req.user.id, status: { not: 'done' } },
        orderBy: { dueDate: 'asc' }, take: 10, include: includeBase,
      }),
    ]);
    return { dueToday, overdue, completedToday, highPriority, myTasks };
  });
}
