CREATE TABLE "slack_user" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"real_name" text,
	"tz" text,
	"is_bot" boolean NOT NULL,
	"deleted" boolean NOT NULL,
	"updated" timestamp with time zone NOT NULL,
	"raw" json NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_message" ALTER COLUMN "raw" SET NOT NULL;