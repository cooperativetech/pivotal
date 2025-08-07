CREATE TABLE "slack_user_mapping" (
	"slack_user_id" text PRIMARY KEY NOT NULL,
	"google_access_token" text,
	"google_refresh_token" text,
	"google_token_expires_at" timestamp with time zone,
	"slack_team_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slack_user_name" text,
	"slack_display_name" text
);
--> statement-breakpoint
CREATE TABLE "user_context" (
	"slack_user_id" text PRIMARY KEY NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_context" ADD CONSTRAINT "user_context_slack_user_id_slack_user_mapping_slack_user_id_fk" FOREIGN KEY ("slack_user_id") REFERENCES "public"."slack_user_mapping"("slack_user_id") ON DELETE no action ON UPDATE no action;