-- Add raw_ts column as nullable first
ALTER TABLE "slack_message" ADD COLUMN "raw_ts" text;--> statement-breakpoint
-- Add thread_ts column
ALTER TABLE "slack_message" ADD COLUMN "thread_ts" text;--> statement-breakpoint
-- Copy ts value from raw JSON to raw_ts column
UPDATE "slack_message" SET "raw_ts" = (raw->>'ts')::text WHERE raw->>'ts' IS NOT NULL;--> statement-breakpoint
-- Copy thread_ts value from raw JSON to thread_ts column (if it exists)
UPDATE "slack_message" SET "thread_ts" = (raw->>'thread_ts')::text WHERE raw->>'thread_ts' IS NOT NULL;--> statement-breakpoint
-- Now make raw_ts NOT NULL after populating it
ALTER TABLE "slack_message" ALTER COLUMN "raw_ts" SET NOT NULL;