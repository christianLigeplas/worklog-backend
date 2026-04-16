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

export default async function assistantRoutes(app) {
  app.addHook('onRequest', app.authenticate);

  // Histórico de chat del usuario
  app.get('/history', async (req) => {
    return app.prisma.chatMessage.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
  });

  app.delete('/history', async (req) => {
    await app.prisma.chatMessage.deleteMany({ where: { userId: req.user.id } });
    return { ok: true };
  });

  // Procesa mensaje y crea tarea si procede
  app.post('/message', async (req, reply) => {
    const { text } = req.body || {};
    if (!text?.trim()) return reply.code(400).send({ error: 'empty_text' });

    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(500).send({ error: 'missing_anthropic_key', message: 'Configura ANTHROPIC_API_KEY en el servidor' });
    }

    // Guarda mensaje del usuario
    await app.prisma.chatMessage.create({
      data: { userId: req.user.id, role: 'user', content: text },
    });

    // Contexto: miembros del equipo + fecha actual
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
        model: MODEL,
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: contextMsg }],
      });
      const raw = resp.content[0].text.trim();
      // Limpia posibles fences markdown
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      app.log.error({ err: e }, 'assistant parse error');
      const fallback = { action: 'chat', reply: 'No pude entenderlo bien. ¿Puedes reformularlo?' };
      await app.prisma.chatMessage.create({
        data: { userId: req.user.id, role: 'assistant', content: fallback.reply },
      });
      return fallback;
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
          creatorId:   req.user.id,
          assigneeId:  assignee?.id || req.user.id,
          title:       t.title || 'Sin título',
          description: t.description || null,
          priority:    ['low','medium','high'].includes(t.priority) ? t.priority : 'medium',
          dueDate:     t.dueDate ? new Date(t.dueDate) : null,
          tags:        Array.isArray(t.tags) ? t.tags : [],
        },
      });
      if (createdTask.dueDate) {
        const remindAt = new Date(createdTask.dueDate.getTime() - 60 * 60 * 1000);
        if (remindAt > new Date())
          await app.prisma.reminder.create({ data: { taskId: createdTask.id, remindAt } });
      }
    }

    await app.prisma.chatMessage.create({
      data: {
        userId: req.user.id,
        role: 'assistant',
        content: parsed.reply || '✅ Hecho',
        taskId: createdTask?.id,
      },
    });

    return { ...parsed, createdTask };
  });
}
