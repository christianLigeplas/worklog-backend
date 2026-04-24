// Asegura que cada workspace tiene equipo "General" con todos los usuarios dentro.
// Se ejecuta siempre al arrancar. Es idempotente (no hace daño si ya existe).

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('🔧 Verificando equipo General en workspaces...');

  const workspaces = await prisma.workspace.findMany({
    include: {
      members: { select: { id: true } },
      teams: { include: { members: true } },
    },
  });

  for (const ws of workspaces) {
    let general = ws.teams.find(t => t.name === 'General');
    if (!general) {
      general = await prisma.team.create({
        data: { workspaceId: ws.id, name: 'General', color: '#3b82f6' },
      });
      console.log(`  ✅ Creado equipo General en ${ws.name}`);
    }
    const currentIds = new Set((general.members || []).map(m => m.userId));
    const toAdd = ws.members.filter(m => !currentIds.has(m.id));
    if (toAdd.length) {
      await prisma.teamMember.createMany({
        data: toAdd.map(m => ({ teamId: general.id, userId: m.id })),
        skipDuplicates: true,
      });
      console.log(`  ✅ +${toAdd.length} miembros a General en ${ws.name}`);
    }
  }
  console.log('🔧 Verificación completada');
}

main()
  .catch(e => { console.error('❌ Error ensure:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
