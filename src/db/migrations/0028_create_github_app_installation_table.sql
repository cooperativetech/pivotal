CREATE TABLE "github_app_installation" (
	"id" text PRIMARY KEY NOT NULL,
	"slack_team_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"repository_id" text,
	"repository_connected_by_user_id" text,
	"repository_connected_at" timestamp,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_installation_slackTeamId_unique" UNIQUE("slack_team_id")
);
--> statement-breakpoint
ALTER TABLE "github_app_installation" ADD CONSTRAINT "github_app_installation_slack_team_id_organization_slack_team_id_fk" FOREIGN KEY ("slack_team_id") REFERENCES "public"."organization"("slack_team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_app_installation" ADD CONSTRAINT "github_app_installation_repository_connected_by_user_id_user_id_fk" FOREIGN KEY ("repository_connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_app_installation" ADD CONSTRAINT "github_app_installation_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "installation_id";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "repository_id";