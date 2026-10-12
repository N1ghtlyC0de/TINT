import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export async function findByProviderSub(providerSub: string, provider: 'firebase' = 'firebase') {
  const result = await db
    .select()
    .from(users)
    .where(and(eq(users.providerSub, providerSub), eq(users.provider, provider)));
  return result[0] || null;
}

export async function findById(id: string) {
  const result = await db.select().from(users).where(eq(users.id, id));
  return result[0] || null;
}

export async function create(user: NewUser) {
  const result = await db.insert(users).values(user).returning();
  return result[0];
}

/**
 * Crea o recupera el usuario en un solo `INSERT ... ON CONFLICT (provider, provider_sub)
 * DO UPDATE`: dos primeros logins concurrentes ya no pueden duplicarlo. En cada login se
 * refrescan email, nombre y avatar con lo que trae el ID token de Firebase.
 *
 * Al insertar por primera vez, asigna el rol indicado o 'participant' por defecto.
 * En logins subsecuentes, conserva el rol existente.
 */
export async function upsertByProvider(userData: {
  providerSub: string;
  email?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  provider?: 'firebase';
  role?: 'public_host' | 'private_host' | 'participant';
  roleId?: string | null;
}) {
  const profile = {
    email: userData.email ?? null,
    displayName: userData.displayName ?? null,
    avatarUrl: userData.avatarUrl ?? null,
  };
  const result = await db
    .insert(users)
    .values({
      provider: userData.provider || 'firebase',
      providerSub: userData.providerSub,
      ...profile,
      role: userData.role || 'participant',
      roleId: userData.roleId ?? null,
    })
    .onConflictDoUpdate({
      target: [users.provider, users.providerSub],
      set: { ...profile, updatedAt: new Date() },
    })
    .returning();
  return result[0];
}

export async function updateRole(id: string, role: string, roleId?: string | null) {
  const values: Partial<NewUser> = {
    role,
    updatedAt: new Date(),
  };
  if (roleId !== undefined) {
    values.roleId = roleId;
  }
  const result = await db
    .update(users)
    .set(values)
    .where(eq(users.id, id))
    .returning();
  return result[0] || null;
}

