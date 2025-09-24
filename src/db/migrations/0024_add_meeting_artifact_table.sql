CREATE TABLE "meeting_artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"calendar_event_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"meeting_code" text,
	"meeting_uri" text,
	"summary" text,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"conference_record" text,
	"transcript_uri" text,
	"transcript_document_id" text,
	"transcript_fetched_at" timestamp with time zone,
	"transcript_last_checked_at" timestamp with time zone,
	"transcript_attempt_count" integer DEFAULT 0 NOT NULL,
	"gemini_summary" text,
	"gemini_model" text,
	"summary_posted_at" timestamp with time zone,
	"summary_slack_channel_id" text,
	"summary_slack_ts" text,
	"origin_channel_id" text,
	"origin_thread_ts" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_artifact" ADD CONSTRAINT "meeting_artifact_topic_id_topic_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topic"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_artifact_calendar_event_unique" ON "meeting_artifact" ("calendar_event_id");
--> statement-breakpoint
CREATE INDEX "meeting_artifact_pending_idx" ON "meeting_artifact" ("end_time") WHERE "summary_posted_at" IS NULL;
