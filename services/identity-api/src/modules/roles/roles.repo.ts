import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { roles } from '../../db/schema.js';

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;

export const DEFAULT_ROLES = [
  { name: 'public_host', description: 'Host con capacidad de crear salas y eventos públicos' },
  { name: 'private_host', description: 'Host con capacidad de crear salas privadas con invitación' },
  { name: 'participant', description: 'Usuario participante invitado' },
] as const;

export async function findByName(name: string): Promise<Role | null> {
  const result = await db.select().from(roles).where(eq(roles.name, name));
  return result[0] || null;
}

export async function findById(id: string): Promise<Role | null> {
  const result = await db.select().from(roles).where(eq(roles.id, id));
  return result[0] || null;
}

export async function create(role: NewRole): Promise<Role> {
  const result = await db.insert(roles).values(role).returning();
  return result[0];
}

export async function listAll(): Promise<Role[]> {
  const result = await db.select().from(roles);
  return result;
}

export async function ensureDefaultRoles(): Promise<Role[]> {
  const existing = await listAll();
  const existingNames = new Set(existing.map((r) => r.name));
  const created: Role[] = [...existing];

  for (const def of DEFAULT_ROLES) {
    if (!existingNames.has(def.name)) {
      const role = await create({ name: def.name, description: def.description });
      created.push(role);
      existingNames.add(def.name);
    }
  }

  return created;
}

