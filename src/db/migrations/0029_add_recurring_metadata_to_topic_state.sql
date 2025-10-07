ALTER TABLE "topic_state" ADD COLUMN "recurring_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb;
