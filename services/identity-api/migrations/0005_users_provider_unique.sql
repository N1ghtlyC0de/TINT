-- Antes del índice único: fusiona los usuarios duplicados que pudo crear el upsert
-- no atómico (dos primeros logins concurrentes). Se conserva el más antiguo de cada
-- (provider, provider_sub), se le reasignan salas, invitaciones y vídeos de los
-- duplicados y después se borran. En una BD limpia estas sentencias no tocan nada.
UPDATE "rooms" AS r SET "host_id" = d.keep_id
FROM (
  SELECT "id", first_value("id") OVER (PARTITION BY "provider", "provider_sub" ORDER BY "created_at", "id") AS keep_id
  FROM "users"
) AS d
WHERE r."host_id" = d."id" AND d."id" <> d.keep_id;--> statement-breakpoint
UPDATE "invitations" AS i SET "created_by" = d.keep_id
FROM (
  SELECT "id", first_value("id") OVER (PARTITION BY "provider", "provider_sub" ORDER BY "created_at", "id") AS keep_id
  FROM "users"
) AS d
WHERE i."created_by" = d."id" AND d."id" <> d.keep_id;--> statement-breakpoint
UPDATE "videos" AS v SET "uploaded_by" = d.keep_id
FROM (
  SELECT "id", first_value("id") OVER (PARTITION BY "provider", "provider_sub" ORDER BY "created_at", "id") AS keep_id
  FROM "users"
) AS d
WHERE v."uploaded_by" = d."id" AND d."id" <> d.keep_id;--> statement-breakpoint
DELETE FROM "users" AS u
USING (
  SELECT "id", first_value("id") OVER (PARTITION BY "provider", "provider_sub" ORDER BY "created_at", "id") AS keep_id
  FROM "users"
) AS d
WHERE u."id" = d."id" AND d."id" <> d.keep_id;--> statement-breakpoint
CREATE UNIQUE INDEX "users_provider_sub_unique" ON "users" USING btree ("provider","provider_sub");
