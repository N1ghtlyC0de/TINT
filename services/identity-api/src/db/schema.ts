import { pgTable, text, timestamp, boolean, uuid, varchar, integer } from 'drizzle-orm/pg-core';

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
});

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
  mediaId: uuid('media_id').references(() => medias.id),
  title: varchar('title', { length: 150 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'), // 'active' | 'grace_period' | 'closed' | 'deleted'
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).defaultNow().notNull(),
  gracePeriodUntil: timestamp('grace_period_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
