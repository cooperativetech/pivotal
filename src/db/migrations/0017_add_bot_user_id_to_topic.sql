-- First add the column as nullable
ALTER TABLE "topic" ADD COLUMN "bot_user_id" text;

-- Set bot_user_id to 'UTESTBOT' for all existing topics
UPDATE "topic" SET "bot_user_id" = 'UTESTBOT';

-- Now make the column not nullable
ALTER TABLE "topic" ALTER COLUMN "bot_user_id" SET NOT NULL;