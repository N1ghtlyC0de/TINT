CREATE TABLE "guest_sessions" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"sub" text NOT NULL,
	"nick" varchar(64) NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;