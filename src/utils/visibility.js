// Filtro de visibilidad con equipos
//
// Reglas:
//   private → solo el creador (no hay asignado)
//   team    → creador + asignado principal + asignados múltiples + miembros del equipo asignado
//   public  → todos
//
// Usa SIEMPRE esto para consultar tareas.

/**
 * Devuelve un objeto Prisma WHERE para filtrar tareas que un usuario puede ver.
 * Requiere tener cargadas las memberships del usuario (teamIds).
 */
export function visibilityWhere(userId, userTeamIds = []) {
  return {
    OR: [
      { visibility: 'public' },
      {
        visibility: 'private',
        creatorId: userId,
      },
      {
        visibility: 'team',
        OR: [
          { creatorId: userId },
          { assigneeId: userId },
          { assignees: { some: { userId } } },
          userTeamIds.length > 0 ? { teamId: { in: userTeamIds } } : { id: '___never___' },
        ],
      },
    ],
  };
}

/**
 * Devuelve los IDs de equipos a los que pertenece el usuario.
 */
export async function getUserTeamIds(prisma, userId) {
  const memberships = await prisma.teamMember.findMany({
    where: { userId },
    select: { teamId: true },
  });
  return memberships.map(m => m.teamId);
}

/**
 * Comprueba si un usuario puede ver una tarea concreta (ya cargada con assignees, team).
 */
export function canUserSeeTask(task, userId, userTeamIds = []) {
  if (!task) return false;
  if (task.visibility === 'public') return true;
  if (task.creatorId === userId) return true;
  if (task.visibility === 'private') return false;
  if (task.visibility === 'team') {
    if (task.assigneeId === userId) return true;
    if ((task.assignees || []).some(a => a.userId === userId)) return true;
    if (task.teamId && userTeamIds.includes(task.teamId)) return true;
  }
  return false;
}

/**
 * Valida que una asignación sea consistente con el equipo.
 * - Privada: el único asignado permitido es el creador.
 * - Team: si hay teamId, los usuarios asignados deben ser miembros del equipo.
 * - Public: sin restricciones.
 */
export async function validateAssignment(prisma, { visibility, teamId, creatorId, assigneeId, assigneeIds = [] }) {
  if (visibility === 'private') {
    if (assigneeId && assigneeId !== creatorId) {
      return { ok: false, error: 'private_cannot_assign' };
    }
    if (assigneeIds.length > 0 && !assigneeIds.every(id => id === creatorId)) {
      return { ok: false, error: 'private_cannot_assign' };
    }
    return { ok: true };
  }
  if (visibility === 'team' && teamId) {
    const members = await prisma.teamMember.findMany({
      where: { teamId }, select: { userId: true },
    });
    const memberIds = new Set(members.map(m => m.userId));
    const toCheck = [assigneeId, ...assigneeIds].filter(Boolean);
    for (const uid of toCheck) {
      if (!memberIds.has(uid) && uid !== creatorId) {
        return { ok: false, error: 'assignee_not_in_team' };
      }
    }
  }
  return { ok: true };
}
