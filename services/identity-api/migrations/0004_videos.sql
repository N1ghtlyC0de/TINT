CREATE TABLE "videos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"uploaded_by" uuid,
	"storage_key" text NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"duration_ms" integer,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;