CREATE TABLE "slack_app_installation" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"installation" jsonb NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "slack_app_installation_teamId_unique" UNIQUE("team_id")
);
--> statement-breakpoint
ALTER TABLE "slack_app_installation" ADD CONSTRAINT "slack_app_installation_team_id_organization_slack_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("slack_team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_app_installation" ADD CONSTRAINT "slack_app_installation_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;