import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-3-5-haiku-20241022';

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

  // Procesar mensaje y crear tarea
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

  // 🤖 Informe diario: análisis IA de las tareas pendientes
  app.post('/daily-report', async (req, reply) => {
    if (!process.env.ANTHROPIC_API_KEY) return reply.code(500).send({ error: 'missing_anthropic_key' });
    const wid = req.user.workspaceId;
    const start = new Date(); start.setHours(0,0,0,0);

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

    const [pending, overdue, completedToday, mine] = await Promise.all([
      app.prisma.task.findMany({
        where: { workspaceId: wid, status: { not: 'done' }, AND: [visFilter] },
        include: { assignee: { select: { name: true } } },
        take: 50,
      }),
      app.prisma.task.findMany({
        where: { workspaceId: wid, status: { not: 'done' }, dueDate: { lt: start }, AND: [visFilter] },
        include: { assignee: { select: { name: true } } },
      }),
      app.prisma.task.count({ where: { workspaceId: wid, status: 'done', completedAt: { gte: start }, AND: [visFilter] } }),
      app.prisma.task.findMany({
        where: { workspaceId: wid, assigneeId: req.user.id, status: { not: 'done' }, AND: [visFilter] },
      }),
    ]);

    const me = await app.prisma.user.findUnique({ where: { id: req.user.id }, select: { name: true } });

    const summary = {
      usuario: me?.name || 'Usuario',
      pendientes_total: pending.length,
      mis_pendientes: mine.length,
      retrasadas: overdue.length,
      completadas_hoy: completedToday,
      tareas: pending.slice(0, 30).map(t => ({
        title: t.title,
        priority: t.priority,
        due: t.dueDate?.toISOString().slice(0, 10) || 'sin fecha',
        assignee: t.assignee?.name || 'sin asignar',
        status: t.status,
      })),
    };

    const prompt = `Eres un coach de productividad. Genera un informe MUY breve (máximo 200 palabras) en español para ${summary.usuario}, con tono cercano y motivador.

Datos del día:
${JSON.stringify(summary, null, 2)}

Estructura el informe en MARKDOWN con estas secciones:

## ☀️ Buenos días, ${summary.usuario}
(saludo + frase de contexto sobre el estado general)

## 🎯 Tus 3 prioridades de hoy
(las 3 tareas más críticas DE LAS QUE TIENE ASIGNADAS, con razón breve de por qué)

## ⚠️ Alertas
(retrasadas, alta prioridad sin fecha, tareas atascadas)

## 💡 Sugerencia
(un consejo concreto de productividad basado en los datos)

Responde SOLO el markdown, sin envolver en bloques de código.`;

    try {
      const resp = await client.messages.create({
        model: MODEL, max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      });
      return { report: resp.content[0].text, stats: { pending: pending.length, overdue: overdue.length, completedToday, mine: mine.length } };
    } catch (e) {
      app.log.error({ err: e }, 'daily report error');
      return reply.code(500).send({ error: 'ai_error', message: e.message });
    }
  });

  // 🤖 Sugerencia IA para una tarea concreta
  app.post('/task-suggestion/:taskId', async (req, reply) => {
    if (!process.env.ANTHROPIC_API_KEY) return reply.code(500).send({ error: 'missing_anthropic_key' });
    const task = await app.prisma.task.findFirst({
      where: { id: req.params.taskId, workspaceId: req.user.workspaceId },
      include: { comments: { include: { user: { select: { name: true } } } } },
    });
    if (!task) return reply.code(404).send({ error: 'not_found' });

    const ctx = {
      titulo: task.title,
      descripcion: task.description || '(sin descripción)',
      prioridad: task.priority,
      vence: task.dueDate?.toISOString() || 'sin fecha',
      etiquetas: task.tags,
      comentarios: task.comments.map(c => `- ${c.user?.name}: ${c.text}`).join('\n') || '(ninguno)',
    };

    const prompt = `Eres un asistente que ayuda a planificar tareas de trabajo. Te paso una tarea y debes dar consejo práctico en ESPAÑOL, BREVE (máximo 150 palabras), formato markdown.

Tarea:
${JSON.stringify(ctx, null, 2)}

Devuelve un análisis con:

**🎯 Plan de acción** (3-4 pasos concretos para resolverla)

**⏱️ Estimación** (cuánto tiempo aproximado)

**⚠️ Posibles bloqueos** (qué podría salir mal)

**💡 Tip** (un consejo práctico)

Sin envolver en bloques de código. Solo el markdown.`;

    try {
      const resp = await client.messages.create({
        model: MODEL, max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      });
      return { suggestion: resp.content[0].text };
    } catch (e) {
      app.log.error({ err: e }, 'task suggestion error');
      return reply.code(500).send({ error: 'ai_error', message: e.message });
    }
  });
}
