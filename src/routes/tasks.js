import { visibilityWhere, getUserTeamIds, validateAssignment } from '../utils/visibility.js';
import { sendPushToUser } from '../services/push.js';

const taskInclude = {
  attachments: true,
  comments: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true } } } },
  project: true,
  assignee: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
  team: { select: { id: true, name: true, color: true } },
  assignees: { include: { user: { select: { id: true, name: true } } } },
  reminders: { where: { sent: false }, orderBy: { remindAt: 'asc' } },
  subtasks: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] },
};

export default async function taskRoutes(app) {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const userId = req.user.id;
    const teamIds = await getUserTeamIds(app.prisma, userId);
    const { status, priority, teamId, assigneeId, from, to, q, mine, visibility, archived, type } = req.query;

    const where = {
      AND: [
        { workspaceId: req.user.workspaceId },
        visibilityWhere(userId, teamIds),
        { archived: archived === '1' || archived === 'true' },
      ],
    };
    if (status) where.AND.push({ status });
    if (priority) where.AND.push({ priority });
    if (type) where.AND.push({ type });
    if (teamId) where.AND.push({ teamId });
    if (assigneeId) where.AND.push({
      OR: [{ assigneeId }, { assignees: { some: { userId: assigneeId } } }],
    });
    if (mine === '1') where.AND.push({
      OR: [{ assigneeId: userId }, { assignees: { some: { userId } } }],
    });
    if (visibility) where.AND.push({ visibility });
    if (from) where.AND.push({ dueDate: { gte: new Date(from) } });
    if (to) where.AND.push({ dueDate: { lte: new Date(to) } });
    if (q) where.AND.push({
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ],
    });
    return app.prisma.task.findMany({
      where,
      orderBy: [{ dueDate: 'asc' }, { startDate: 'asc' }, { createdAt: 'desc' }],
      include: taskInclude,
    });
  });

  app.get('/:id', async (req, reply) => {
    const userId = req.user.id;
    const teamIds = await getUserTeamIds(app.prisma, userId);
    const task = await app.prisma.task.findFirst({
      where: {
        AND: [
          { id: req.params.id },
          { workspaceId: req.user.workspaceId },
          visibilityWhere(userId, teamIds),
        ],
      },
      include: taskInclude,
    });
    if (!task) return reply.code(404).send({ error: 'not_found' });
    return task;
  });

  app.post('/', async (req, reply) => {
    const {
      title, description, projectId, dueDate, startDate, priority, tags, location,
      assigneeId, assigneeIds, teamId, visibility, type,
    } = req.body || {};

    const vis = ['private', 'team', 'public'].includes(visibility) ? visibility : 'private';
    const taskType = type === 'meeting' ? 'meeting' : 'task';
    let finalAssigneeId = vis === 'private' ? req.user.id : (assigneeId || req.user.id);
    let finalAssigneeIds = vis === 'private' ? [] : (Array.isArray(assigneeIds) ? assigneeIds.filter(Boolean) : []);
    let finalTeamId = vis === 'private' ? null : (teamId || null);

    const check = await validateAssignment(app.prisma, {
      visibility: vis, teamId: finalTeamId, creatorId: req.user.id,
      assigneeId: finalAssigneeId, assigneeIds: finalAssigneeIds,
    });
    if (!check.ok) return reply.code(400).send({ error: check.error });

    const task = await app.prisma.task.create({
      data: {
        workspaceId: req.user.workspaceId,
        creatorId: req.user.id,
        assigneeId: finalAssigneeId,
        teamId: finalTeamId,
        title: title || 'Sin título',
        description, projectId: projectId || null,
        type: taskType,
        dueDate: dueDate ? new Date(dueDate) : null,
        startDate: startDate ? new Date(startDate) : null,
        priority: priority || 'medium',
        tags: tags || [], location: location || null,
        visibility: vis,
      },
    });
    if (finalAssigneeIds.length) {
      await app.prisma.taskAssignee.createMany({
        data: finalAssigneeIds.map(uid => ({ taskId: task.id, userId: uid })),
        skipDuplicates: true,
      });
    }
    // Recordatorio automático: 1h antes
    const refDate = taskType === 'meeting' ? task.startDate : task.dueDate;
    if (refDate) {
      const remindAt = new Date(refDate.getTime() - 60 * 60 * 1000);
      if (remindAt > new Date()) await app.prisma.reminder.create({ data: { taskId: task.id, remindAt } });
    }
    // Notificar a asignados
    const toNotify = new Set([finalAssigneeId, ...finalAssigneeIds].filter(x => x && x !== req.user.id));
    const notifTitle = taskType === 'meeting' ? '📅 Nueva reunión' : '📌 Nueva tarea asignada';
    for (const uid of toNotify) {
      await app.prisma.notification.create({
        data: { userId: uid, taskId: task.id, title: notifTitle, body: task.title },
      });
      await sendPushToUser(app.prisma, uid, {
        title: notifTitle, body: task.title,
        taskId: task.id, url: `/task/${task.id}`,
      });
    }
    return task;
  });

  app.patch('/:id', async (req, reply) => {
    const t = await app.prisma.task.findFirst({ where: { id: req.params.id, workspaceId: req.user.workspaceId } });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const userId = req.user.id;
    const canEdit =
      t.visibility === 'public' ||
      t.creatorId === userId ||
      t.assigneeId === userId ||
      req.user.role === 'owner' || req.user.role === 'admin';
    if (!canEdit) return reply.code(403).send({ error: 'no_permission' });

    const data = { ...req.body };
    const newVisibility = data.visibility && ['private', 'team', 'public'].includes(data.visibility) ? data.visibility : t.visibility;
    if (data.visibility && t.creatorId !== userId && req.user.role !== 'owner') delete data.visibility;
    if (data.type && !['task', 'meeting'].includes(data.type)) delete data.type;

    if (data.dueDate !== undefined) data.dueDate = data.dueDate ? new Date(data.dueDate) : null;
    if (data.startDate !== undefined) data.startDate = data.startDate ? new Date(data.startDate) : null;
    if (data.status === 'done' && t.status !== 'done') data.completedAt = new Date();

    if (newVisibility === 'private' && t.visibility !== 'private') {
      await app.prisma.taskAssignee.deleteMany({ where: { taskId: t.id } });
      data.assigneeId = t.creatorId;
      data.teamId = null;
    }

    const assigneeIds = Array.isArray(data.assigneeIds) ? data.assigneeIds.filter(Boolean) : null;
    delete data.assigneeIds;

    if (newVisibility !== 'private' && (data.assigneeId !== undefined || assigneeIds || data.teamId !== undefined)) {
      const check = await validateAssignment(app.prisma, {
        visibility: newVisibility,
        teamId: data.teamId !== undefined ? data.teamId : t.teamId,
        creatorId: t.creatorId,
        assigneeId: data.assigneeId !== undefined ? data.assigneeId : t.assigneeId,
        assigneeIds: assigneeIds || [],
      });
      if (!check.ok) return reply.code(400).send({ error: check.error });
    }

    const updated = await app.prisma.task.update({ where: { id: t.id }, data });

    if (assigneeIds) {
      await app.prisma.taskAssignee.deleteMany({ where: { taskId: t.id } });
      if (assigneeIds.length) {
        await app.prisma.taskAssignee.createMany({
          data: assigneeIds.map(uid => ({ taskId: t.id, userId: uid })),
          skipDuplicates: true,
        });
      }
    }

    if (data.assigneeId && data.assigneeId !== t.assigneeId && data.assigneeId !== userId) {
      const isMeeting = (data.type || updated.type) === 'meeting';
      const title = isMeeting ? '📅 Te han añadido a una reunión' : '👤 Te han asignado una tarea';
      await app.prisma.notification.create({
        data: { userId: data.assigneeId, taskId: t.id, title, body: updated.title },
      });
      await sendPushToUser(app.prisma, data.assigneeId, {
        title, body: updated.title, taskId: t.id, url: `/task/${t.id}`,
      });
    }
    return updated;
  });

  // === SUBTASKS ===
  app.get('/:id/subtasks', async (req, reply) => {
    const userId = req.user.id;
    const teamIds = await getUserTeamIds(app.prisma, userId);
    const t = await app.prisma.task.findFirst({
      where: { AND: [{ id: req.params.id }, { workspaceId: req.user.workspaceId }, visibilityWhere(userId, teamIds)] },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    return app.prisma.subtask.findMany({
      where: { taskId: t.id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  });

  app.post('/:id/subtasks', async (req, reply) => {
    const userId = req.user.id;
    const teamIds = await getUserTeamIds(app.prisma, userId);
    const t = await app.prisma.task.findFirst({
      where: { AND: [{ id: req.params.id }, { workspaceId: req.user.workspaceId }, visibilityWhere(userId, teamIds)] },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const { text } = req.body || {};
    if (!text?.trim()) return reply.code(400).send({ error: 'text_required' });
    const count = await app.prisma.subtask.count({ where: { taskId: t.id } });
    return app.prisma.subtask.create({
      data: { taskId: t.id, text: text.trim(), position: count },
    });
  });

  app.patch('/:id/subtasks/:subtaskId', async (req, reply) => {
    const t = await app.prisma.task.findFirst({ where: { id: req.params.id, workspaceId: req.user.workspaceId } });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const sub = await app.prisma.subtask.findFirst({
      where: { id: req.params.subtaskId, taskId: t.id },
    });
    if (!sub) return reply.code(404).send({ error: 'subtask_not_found' });
    const { text, done } = req.body || {};
    const data = {};
    if (text !== undefined) data.text = String(text).trim();
    if (done !== undefined) data.done = !!done;
    return app.prisma.subtask.update({ where: { id: sub.id }, data });
  });

  app.delete('/:id/subtasks/:subtaskId', async (req, reply) => {
    const t = await app.prisma.task.findFirst({ where: { id: req.params.id, workspaceId: req.user.workspaceId } });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    await app.prisma.subtask.deleteMany({
      where: { id: req.params.subtaskId, taskId: t.id },
    });
    return { ok: true };
  });

  // Resto endpoints
  app.post('/:id/archive', async (req, reply) => {
    const t = await app.prisma.task.findFirst({ where: { id: req.params.id, workspaceId: req.user.workspaceId } });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    return app.prisma.task.update({ where: { id: t.id }, data: { archived: true, archivedAt: new Date() } });
  });
  app.post('/:id/unarchive', async (req, reply) => {
    const t = await app.prisma.task.findFirst({ where: { id: req.params.id, workspaceId: req.user.workspaceId } });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    return app.prisma.task.update({ where: { id: t.id }, data: { archived: false, archivedAt: null } });
  });

  app.delete('/:id', async (req, reply) => {
    const t = await app.prisma.task.findFirst({ where: { id: req.params.id, workspaceId: req.user.workspaceId } });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.creatorId !== req.user.id && req.user.role !== 'owner' && req.user.role !== 'admin')
      return reply.code(403).send({ error: 'only_creator_or_admin' });
    await app.prisma.task.delete({ where: { id: t.id } });
    return { ok: true };
  });

  app.post('/:id/comments', async (req, reply) => {
    const userId = req.user.id;
    const teamIds = await getUserTeamIds(app.prisma, userId);
    const t = await app.prisma.task.findFirst({
      where: { AND: [{ id: req.params.id }, { workspaceId: req.user.workspaceId }, visibilityWhere(userId, teamIds)] },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    return app.prisma.comment.create({ data: { taskId: t.id, userId, text: req.body.text } });
  });

  app.post('/:id/reminders', async (req, reply) => {
    const userId = req.user.id;
    const teamIds = await getUserTeamIds(app.prisma, userId);
    const t = await app.prisma.task.findFirst({
      where: { AND: [{ id: req.params.id }, { workspaceId: req.user.workspaceId }, visibilityWhere(userId, teamIds)] },
    });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const { remindAt, message } = req.body || {};
    if (!remindAt) return reply.code(400).send({ error: 'remindAt_required' });
    return app.prisma.reminder.create({
      data: { taskId: t.id, userId, message: message || null, remindAt: new Date(remindAt) },
    });
  });

  app.delete('/:id/reminders/:reminderId', async (req, reply) => {
    const t = await app.prisma.task.findFirst({ where: { id: req.params.id, workspaceId: req.user.workspaceId } });
    if (!t) return reply.code(404).send({ error: 'not_found' });
    await app.prisma.reminder.deleteMany({ where: { id: req.params.reminderId, taskId: t.id } });
    return { ok: true };
  });
}
