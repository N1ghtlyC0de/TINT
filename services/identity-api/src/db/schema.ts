import { pgTable, text, timestamp, boolean, uuid, varchar, bigint, integer, uniqueIndex } from 'drizzle-orm/pg-core';

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 30 }).unique().notNull(), // 'public_host' | 'private_host' | 'participant'
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  roleId: uuid('role_id').references(() => roles.id),
  role: varchar('role', { length: 30 }).notNull().default('participant'),
  provider: text('provider', { enum: ['firebase'] }).notNull().default('firebase'),
  providerSub: text('provider_sub').notNull().unique(),
  email: text('email'),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // Un usuario por cuenta del proveedor: es el target del upsert atómico (migración 0005).
  uniqueIndex('users_provider_sub_unique').on(t.provider, t.providerSub),
]);

export const medias = pgTable('medias', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  blobUrl: text('blob_url').notNull(),
  durationMs: integer('duration_ms').default(0).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('processing'), // 'processing' | 'ready' | 'failed'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  hostId: uuid('host_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 150 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'), // 'active' | 'grace_period' | 'closed' | 'deleted'
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).defaultNow().notNull(),
  gracePeriodUntil: timestamp('grace_period_until', { withTimezone: true }),
  // Vídeo asignado (F3): id estable que viaja en LOAD/STATE y key del objeto en MINIO_BUCKET.
  mediaId: uuid('media_id').references(() => medias.id),
  mediaKey: text('media_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Sesiones de invitado (F5): una fila por guest token emitido, para listarlos y revocarlos.
export const guestSessions = pgTable('guest_sessions', {
  jti: uuid('jti').primaryKey(),
  roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  sub: text('sub').notNull(),
  nick: varchar('nick', { length: 64 }).notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked: boolean('revoked').default(false).notNull(),
});

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 12 }).unique().notNull(),
  roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked: boolean('revoked').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Vídeos subidos al Blob Storage (MinIO). identity-api crea la fila y publica
// `media:uploads`; media-worker solo la actualiza (processing → ready | failed,
// duration_ms). Las columnas id, storage_key, duration_ms y status son su contrato.
export const videos = pgTable('videos', {
  id: uuid('id').primaryKey(),
  roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  storageKey: text('storage_key').notNull(),
  contentType: varchar('content_type', { length: 100 }).notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  durationMs: integer('duration_ms'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

