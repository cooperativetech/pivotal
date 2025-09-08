CREATE TABLE "topic_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"per_user_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "topic_state" ADD CONSTRAINT "topic_state_topic_id_topic_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_state" ADD CONSTRAINT "topic_state_created_by_message_id_slack_message_id_fk" FOREIGN KEY ("created_by_message_id") REFERENCES "public"."slack_message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Insert initial topic_state rows from existing topics
INSERT INTO "topic_state" (topic_id, user_ids, summary, is_active, per_user_context, created_by_message_id, created_at)
SELECT
    t.id as topic_id,
    t.user_ids,
    t.summary,
    t.is_active,
    t.per_user_context,
    (SELECT id FROM slack_message WHERE topic_id = t.id ORDER BY timestamp ASC LIMIT 1) as created_by_message_id,
    t.updated_at as created_at
FROM topic t
WHERE EXISTS (SELECT 1 FROM slack_message WHERE topic_id = t.id);
--> statement-breakpoint
ALTER TABLE "topic" DROP COLUMN "user_ids";--> statement-breakpoint
ALTER TABLE "topic" DROP COLUMN "summary";--> statement-breakpoint
ALTER TABLE "topic" DROP COLUMN "is_active";--> statement-breakpoint
ALTER TABLE "topic" DROP COLUMN "per_user_context";--> statement-breakpoint
ALTER TABLE "topic" DROP COLUMN "updated_at";
