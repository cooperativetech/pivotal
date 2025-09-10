CREATE TABLE "calendar_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"calendar_id" text NOT NULL,
	"event_id" text NOT NULL,
	"ical_uid" text,
	"summary" text,
	"description" text,
	"location" text,
	"meet_link" text,
	"html_link" text,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_topic_id_topic_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_created_by_user_id_slack_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."slack_user"("id") ON DELETE no action ON UPDATE no action;