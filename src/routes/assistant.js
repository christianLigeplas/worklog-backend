import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Eres un asistente de productividad para un equipo de trabajo. Hablas español.

Cuando el usuario escriba algo, analiza si quiere CREAR UNA TAREA o si es solo CONVERSACIÓN.

IMPORTANTE: NO crees tareas automáticamente. Si parece una tarea, PREGUNTA primero para confirmar los detalles.

Responde siempre SOLO con JSON puro (sin markdown, sin backticks).

Si el usuario describe algo que PODRÍA ser una tarea, responde así:
{
  "action": "confirm_task",
  "task": {
    "title": "título sugerido",
    "description": "descripción sugerida",
    "priority": "low" | "medium" | "high",
    "dueDate": "ISO 8601 o null",
    "tags": ["etiquetas"],
    "assigneeName": "nombre o null"
  },
  "reply": "He preparado esta tarea:\\n\\n📌 **Título:** ...\\n📝 **Descripción:** ...\\n⏰ **Fecha:** ...\\n🔴 **Prioridad:** ...\\n\\n¿La creo así o quieres cambiar algo?"
}

Si el usuario CONFIRMA (dice sí, ok, dale, créala, perfecto, etc.):
{
  "action": "create_task",
  "task": { (usar los datos de la última tarea confirmada) },
  "reply": "✅ Tarea creada: ..."
}

Si el usuario quiere MODIFICAR antes de crear:
{
  "action": "confirm_task",
  "task": { (con los cambios aplicados) },
  "reply": "He actualizado la tarea:\\n\\n📌 **Título:** ...\\n\\n¿La creo así?"
}

Si NO es una tarea (saludo, pregunta, charla):
{
  "action": "chat",
  "reply": "respuesta amable"
}

Reglas de prioridad:
- "urgente", "ya", "asap", "crítico" → high
- "cuando puedas", "sin prisa" → low
- Sin indicación → medium

Fechas:
- "mañana" → fecha de mañana 09:00
- "esta tarde" → hoy 17:00
- "el lunes" → próximo lunes 09:00

NUNCA escribas texto fuera del JSON.`;

function safeParse(raw) {
  const clean = raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(clean);
}

export default async function assistantRoutes(app) {
  app.addHook('onRequest', app.authenticate);

  app.get('/history', async (req) => app.prisma.chatMessage.findMany({
    where: { userId: req.user.id }, orderBy: { createdAt: 'asc' }, take: 100,
  }));

  app.delete('/history', async (req) => {
    await app.prisma.chatMessage.deleteMany({ where: { userId: req.user.id } });
    return { ok: true };
  });

  app.post('/message', async (req, reply) => {
    const { text } = req.body || {};
    if (!text?.trim()) return reply.code(400).send({ error: 'empty_text' });
    if (!process.env.ANTHROPIC_API_KEY) return reply.code(500).send({ error: 'missing_anthropic_key' });

    await app.prisma.chatMessage.create({ data: { userId: req.user.id, role: 'user', content: text } });

    const members = await app.prisma.user.findMany({
      where: { workspaceId: req.user.workspaceId }, select: { id: true, name: true },
    });
    const me = members.find(m => m.id === req.user.id);

    // Contexto con últimos 6 mensajes para mantener conversación
    const recent = await app.prisma.chatMessage.findMany({
      where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 6,
    });
    const history = recent.reverse().map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    const contextMsg = `Fecha actual: ${new Date().toISOString()}
Hablo con: ${me?.name || 'Usuario'}
Miembros del equipo: ${members.map(m => m.name).join(', ')}

Mensaje: "${text}"`;

    // Reemplazar último mensaje con el contextualizado
    if (history.length > 0) history[history.length - 1].content = contextMsg;

    let parsed;
    try {
      const resp = await client.messages.create({
        model: MODEL, max_tokens: 600, system: SYSTEM_PROMPT,
        messages: history.length > 0 ? history : [{ role: 'user', content: contextMsg }],
      });
      parsed = safeParse(resp.content[0].text);
    } catch (e) {
      app.log.error({ err: e }, 'assistant parse error');
      const fb = { action: 'chat', reply: 'No pude procesar la petición. Comprueba el saldo de Anthropic o reformula.' };
      await app.prisma.chatMessage.create({ data: { userId: req.user.id, role: 'assistant', content: fb.reply } });
      return fb;
    }

    let createdTask = null;

    // Solo crear si action es exactamente "create_task"
    if (parsed.action === 'create_task' && parsed.task) {
      const t = parsed.task;
      const assignee = t.assigneeName
        ? members.find(m => m.name.toLowerCase().includes(t.assigneeName.toLowerCase()))
        : null;
      createdTask = await app.prisma.task.create({
        data: {
          workspaceId: req.user.workspaceId,
          creatorId: req.user.id,
          assigneeId: assignee?.id || req.user.id,
          title: t.title || 'Sin título',
          description: t.description || null,
          priority: ['low', 'medium', 'high'].includes(t.priority) ? t.priority : 'medium',
          dueDate: t.dueDate ? new Date(t.dueDate) : null,
          tags: Array.isArray(t.tags) ? t.tags : [],
          visibility: 'private',  // por defecto privada
        },
      });
      if (createdTask.dueDate) {
        const remindAt = new Date(createdTask.dueDate.getTime() - 60 * 60 * 1000);
        if (remindAt > new Date()) await app.prisma.reminder.create({ data: { taskId: createdTask.id, remindAt } });
      }
    }

    await app.prisma.chatMessage.create({
      data: { userId: req.user.id, role: 'assistant', content: parsed.reply || '✅ Hecho', taskId: createdTask?.id },
    });
    return { ...parsed, createdTask };
  });

  // Informe semanal
  app.post('/weekly-report', async (req, reply) => {
    if (!process.env.ANTHROPIC_API_KEY) return reply.code(500).send({ error: 'missing_anthropic_key' });
    const wid = req.user.workspaceId;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [pendingAll, completedWeek, createdWeek, overdueAll] = await Promise.all([
      app.prisma.task.findMany({
        where: { workspaceId: wid, status: { not: 'done' } },
        include: { assignee: { select: { name: true } } }, take: 80,
      }),
      app.prisma.task.findMany({
        where: { workspaceId: wid, status: 'done', completedAt: { gte: weekAgo } },
        include: { assignee: { select: { name: true } } }, take: 80,
      }),
      app.prisma.task.count({ where: { workspaceId: wid, createdAt: { gte: weekAgo } } }),
      app.prisma.task.findMany({
        where: { workspaceId: wid, status: { not: 'done' }, dueDate: { lt: now } },
        include: { assignee: { select: { name: true } } },
      }),
    ]);

    const me = await app.prisma.user.findUnique({ where: { id: req.user.id }, select: { name: true } });
    const byPerson = {};
    for (const t of completedWeek) { const n = t.assignee?.name || 'sin asignar'; byPerson[n] = (byPerson[n] || 0) + 1; }

    const summary = {
      usuario: me?.name, semana_del: weekAgo.toISOString().slice(0, 10), al: now.toISOString().slice(0, 10),
      creadas: createdWeek, completadas: completedWeek.length, pendientes: pendingAll.length,
      retrasadas: overdueAll.length, por_persona: byPerson,
      alta_prioridad: pendingAll.filter(t => t.priority === 'high').slice(0, 10).map(t => ({
        title: t.title, assignee: t.assignee?.name || 'sin asignar', due: t.dueDate?.toISOString().slice(0, 10) || 'sin fecha',
      })),
    };

    const prompt = `Genera informe semanal en español, conciso (max 350 palabras), markdown.
Datos: ${JSON.stringify(summary, null, 2)}
Estructura:
# 📊 Informe Semanal — ${summary.semana_del} a ${summary.al}
## 📈 Resumen general
## 👥 Rendimiento por persona
## ⚠️ Puntos de atención
## 🎯 Recomendaciones
## 💡 Frase motivadora
Solo markdown, sin bloques de código.`;

    try {
      const resp = await client.messages.create({ model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] });
      return { report: resp.content[0].text, period: { from: summary.semana_del, to: summary.al },
        stats: { created: createdWeek, completed: completedWeek.length, pending: pendingAll.length, overdue: overdueAll.length } };
    } catch (e) {
      app.log.error({ err: e }, 'weekly report error');
      return reply.code(500).send({ error: 'ai_error', message: e.message });
    }
  });
}
