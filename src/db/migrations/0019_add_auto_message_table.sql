CREATE TABLE "auto_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text NOT NULL,
	"next_send_time" timestamp with time zone,
	"recurrence_schedule" jsonb NOT NULL,
	"start_new_topic" boolean DEFAULT false NOT NULL,
	"created_by_message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivation_metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "slack_message" ADD COLUMN "auto_message_id" uuid;--> statement-breakpoint
ALTER TABLE "auto_message" ADD CONSTRAINT "auto_message_created_by_message_id_slack_message_id_fk" FOREIGN KEY ("created_by_message_id") REFERENCES "public"."slack_message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_message" ADD CONSTRAINT "slack_message_auto_message_id_auto_message_id_fk" FOREIGN KEY ("auto_message_id") REFERENCES "public"."auto_message"("id") ON DELETE no action ON UPDATE no action;