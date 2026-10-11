-- Migration: 0002_roles-medias-rbac.sql
-- Adds roles table, medias table, and extends users/rooms for RBAC and catalog support.

-- 1. Roles table
CREATE TABLE IF NOT EXISTS "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(30) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);

-- 2. Add role columns to users
ALTER TABLE "users" ADD COLUMN "role_id" uuid;
ALTER TABLE "users" ADD COLUMN "role" varchar(30) DEFAULT 'participant' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Make provider_sub unique (was missing)
ALTER TABLE "users" ADD CONSTRAINT "users_provider_sub_unique" UNIQUE("provider_sub");

-- 3. Medias table
CREATE TABLE IF NOT EXISTS "medias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"blob_url" text NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'processing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "medias" ADD CONSTRAINT "medias_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- 4. Extend rooms: add media_id, scheduled_at, grace_period_until
ALTER TABLE "rooms" ADD COLUMN "media_id" uuid;
ALTER TABLE "rooms" ADD COLUMN "scheduled_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "rooms" ADD COLUMN "grace_period_until" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rooms" ADD CONSTRAINT "rooms_media_id_medias_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."medias"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- 5. Seed default roles
INSERT INTO "roles" ("name", "description") VALUES
  ('public_host', 'Host con capacidad de crear salas y eventos públicos'),
  ('private_host', 'Host con capacidad de crear salas privadas con invitación'),
  ('participant', 'Usuario participante invitado')
ON CONFLICT ("name") DO NOTHING;

-- 6. Set existing users to public_host role
UPDATE "users" SET "role" = 'public_host' WHERE "role" = 'participant';

