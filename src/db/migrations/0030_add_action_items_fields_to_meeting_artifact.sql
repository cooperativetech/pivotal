ALTER TABLE "meeting_artifact" ADD COLUMN "action_items_processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_artifact" ADD COLUMN "action_items_commit_sha" text;--> statement-breakpoint
ALTER TABLE "meeting_artifact" ADD COLUMN "action_items_error" text;