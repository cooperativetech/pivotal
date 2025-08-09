ALTER TABLE "user_context" RENAME TO "user_data";--> statement-breakpoint
ALTER TABLE "user_data" DROP CONSTRAINT "user_context_slack_user_id_unique";--> statement-breakpoint
ALTER TABLE "user_data" DROP CONSTRAINT "user_context_slack_user_id_slack_user_id_fk";
--> statement-breakpoint
ALTER TABLE "user_data" ADD CONSTRAINT "user_data_slack_user_id_slack_user_id_fk" FOREIGN KEY ("slack_user_id") REFERENCES "public"."slack_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_data" DROP COLUMN "google_access_token";--> statement-breakpoint
ALTER TABLE "user_data" DROP COLUMN "google_refresh_token";--> statement-breakpoint
ALTER TABLE "user_data" DROP COLUMN "google_token_expires_at";--> statement-breakpoint
ALTER TABLE "user_data" ADD CONSTRAINT "user_data_slack_user_id_unique" UNIQUE("slack_user_id");