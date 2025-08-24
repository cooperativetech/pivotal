ALTER TABLE "slack_channel" ALTER COLUMN "user_ids" SET DATA TYPE jsonb USING "user_ids"::jsonb;--> statement-breakpoint
ALTER TABLE "slack_message" ALTER COLUMN "raw" SET DATA TYPE jsonb USING "raw"::jsonb;--> statement-breakpoint
ALTER TABLE "slack_user" ALTER COLUMN "raw" SET DATA TYPE jsonb USING "raw"::jsonb;--> statement-breakpoint
ALTER TABLE "topic" ALTER COLUMN "user_ids" SET DATA TYPE jsonb USING "user_ids"::jsonb;--> statement-breakpoint
ALTER TABLE "topic" ALTER COLUMN "user_ids" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "user_data" ALTER COLUMN "context" SET DATA TYPE jsonb USING "context"::jsonb;--> statement-breakpoint
ALTER TABLE "user_data" ALTER COLUMN "context" SET DEFAULT '{}'::jsonb;
