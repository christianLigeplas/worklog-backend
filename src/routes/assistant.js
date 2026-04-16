import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Eres un asistente de productividad para un equipo de trabajo. Tu trabajo es convertir mensajes en lenguaje natural (en español) en tareas estructuradas.

Cuando el usuario describa algo que hacer, extrae la información y responde SOLO con un JSON con esta forma exacta:

{
  "action": "create_task",
  "task": {
    "title": "string corto y claro",
    "description": "string opcional con contexto",
    "priority": "low" | "medium" | "high",
    "dueDate": "ISO 8601 datetime o null",
    "tags": ["array", "de", "etiquetas"],
    "assigneeName": "nombre del miembro al que se asigna o null"
  },
  "reply": "string corto y amable confirmando lo que has hecho"
}

Reglas:
- "urgente", "ya", "asap", "crítico" → priority: high
- "cuando puedas", "sin prisa" → priority: low
- "mañana" → fecha de mañana a las 09:00
- "esta tarde" → hoy a las 17:00
- "el lunes" → próximo lunes a las 09:00
- Etiquetas útiles: cliente, reunión, llamada, email, compra, bug, urgente, almacén, oficina, etc.
- Si menciona a alguien por nombre y está en la lista de miembros, asígnaselo
- Si NO es una tarea (saluda, pregunta general, charla), responde con:
  {"action": "chat", "reply": "tu respuesta amable y útil"}

NUNCA escribas texto fuera del JSON. NUNCA uses markdown. Solo JSON puro.`;

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

  // Procesar mensaje del chat (crear tarea)
  app.post('/message', async (req, reply) => {
    const { text } = req.body || {};
    if (!text?.trim()) return reply.code(400).send({ error: 'empty_text' });
    if (!process.env.ANTHROPIC_API_KEY) return reply.code(500).send({ error: 'missing_anthropic_key' });

    await app.prisma.chatMessage.create({ data: { userId: req.user.id, role: 'user', content: text } });

    const members = await app.prisma.user.findMany({
      where: { workspaceId: req.user.workspaceId },
      select: { id: true, name: true },
    });
    const me = members.find(m => m.id === req.user.id);
    const contextMsg = `Fecha actual: ${new Date().toISOString()}
Hablo con: ${me?.name || 'Usuario'}
Miembros del equipo: ${members.map(m => m.name).join(', ')}

Mensaje del usuario: "${text}"`;

    let parsed;
    try {
      const resp = await client.messages.create({
        model: MODEL, max_tokens: 500, system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: contextMsg }],
      });
      parsed = safeParse(resp.content[0].text);
    } catch (e) {
      app.log.error({ err: e }, 'assistant parse error');
      const fb = { action: 'chat', reply: 'No pude procesar la petición. Comprueba el saldo de Anthropic o reformula.' };
      await app.prisma.chatMessage.create({ data: { userId: req.user.id, role: 'assistant', content: fb.reply } });
      return fb;
    }

    let createdTask = null;
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
          visibility: 'public',
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

  // 📊 Informe SEMANAL: análisis IA de últimos 7 días
  app.post('/weekly-report', async (req, reply) => {
    if (!process.env.ANTHROPIC_API_KEY) return reply.code(500).send({ error: 'missing_anthropic_key' });
    const wid = req.user.workspaceId;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const visFilter = {
      OR: [
        { visibility: 'public' },
        { visibility: 'private', creatorId: req.user.id },
        { visibility: 'shared', OR: [
          { creatorId: req.user.id },
          { assigneeId: req.user.id },
          { shares: { some: { userId: req.user.id } } },
        ]},
      ],
    };

    const [pendingAll, completedWeek, createdWeek, overdueAll, mineActive] = await Promise.all([
      app.prisma.task.findMany({
        where: { workspaceId: wid, status: { not: 'done' }, AND: [visFilter] },
        include: { assignee: { select: { name: true } } },
        take: 80,
      }),
      app.prisma.task.findMany({
        where: { workspaceId: wid, status: 'done', completedAt: { gte: weekAgo }, AND: [visFilter] },
        include: { assignee: { select: { name: true } } },
        take: 80,
      }),
      app.prisma.task.count({
        where: { workspaceId: wid, createdAt: { gte: weekAgo }, AND: [visFilter] },
      }),
      app.prisma.task.findMany({
        where: { workspaceId: wid, status: { not: 'done' }, dueDate: { lt: now }, AND: [visFilter] },
        include: { assignee: { select: { name: true } } },
      }),
      app.prisma.task.count({
        where: { workspaceId: wid, assigneeId: req.user.id, status: { not: 'done' }, AND: [visFilter] },
      }),
    ]);

    const me = await app.prisma.user.findUnique({ where: { id: req.user.id }, select: { name: true } });

    // Agregar por persona
    const byPerson = {};
    for (const t of completedWeek) {
      const n = t.assignee?.name || 'sin asignar';
      byPerson[n] = (byPerson[n] || 0) + 1;
    }

    const summary = {
      usuario: me?.name || 'Usuario',
      semana_del: weekAgo.toISOString().slice(0, 10),
      al: now.toISOString().slice(0, 10),
      tareas_creadas_semana: createdWeek,
      tareas_completadas_semana: completedWeek.length,
      pendientes_total: pendingAll.length,
      retrasadas: overdueAll.length,
      mis_pendientes: mineActive,
      completadas_por_persona: byPerson,
      pendientes_alta_prioridad: pendingAll.filter(t => t.priority === 'high').slice(0, 10).map(t => ({
        title: t.title,
        assignee: t.assignee?.name || 'sin asignar',
        due: t.dueDate?.toISOString().slice(0, 10) || 'sin fecha',
      })),
    };

    const prompt = `Eres un coach de productividad de equipos. Genera un INFORME SEMANAL en español, conciso (máximo 350 palabras), tono profesional pero cercano, en MARKDOWN.

Datos de la semana del ${summary.semana_del} al ${summary.al}:
${JSON.stringify(summary, null, 2)}

Estructura del informe:

# 📊 Informe Semanal — ${summary.semana_del} a ${summary.al}

## 📈 Resumen general
(2-3 frases sobre el rendimiento del equipo: completadas vs creadas, ratio, sensación general)

## 👥 Rendimiento por persona
(análisis breve del reparto de tareas completadas. Destaca a quien más ha hecho. Si hay desequilibrio, comentalo con tacto)

## ⚠️ Puntos de atención
(retrasadas, alta prioridad sin avanzar, posibles cuellos de botella)

## 🎯 Recomendaciones para la próxima semana
(2-3 acciones concretas y accionables)

## 💡 Frase motivadora final
(una frase corta de cierre)

Devuelve SOLO el markdown, sin envolver en bloques de código. Nada de \`\`\`.`;

    try {
      const resp = await client.messages.create({
        model: MODEL, max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      });
      return {
        report: resp.content[0].text,
        period: { from: summary.semana_del, to: summary.al },
        stats: {
          created: createdWeek,
          completed: completedWeek.length,
          pending: pendingAll.length,
          overdue: overdueAll.length,
        },
      };
    } catch (e) {
      app.log.error({ err: e }, 'weekly report error');
      return reply.code(500).send({ error: 'ai_error', message: e.message });
    }
  });
}
