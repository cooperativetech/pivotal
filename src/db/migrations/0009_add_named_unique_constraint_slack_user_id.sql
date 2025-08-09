ALTER TABLE "slack_user_mapping" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "slack_user_mapping" CASCADE;--> statement-breakpoint
ALTER TABLE "user_context" DROP CONSTRAINT "user_context_pkey";--> statement-breakpoint
ALTER TABLE "user_context" ALTER COLUMN "context" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "user_context" ALTER COLUMN "context" SET DEFAULT '{}'::json;--> statement-breakpoint
ALTER TABLE "user_context" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_context" ADD COLUMN "google_access_token" text;--> statement-breakpoint
ALTER TABLE "user_context" ADD COLUMN "google_refresh_token" text;--> statement-breakpoint
ALTER TABLE "user_context" ADD COLUMN "google_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_context" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_context" ADD CONSTRAINT "user_context_slack_user_id_slack_user_id_fk" FOREIGN KEY ("slack_user_id") REFERENCES "public"."slack_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_context" ADD CONSTRAINT "user_context_slack_user_id_unique" UNIQUE("slack_user_id");
