CREATE TABLE "llm_response" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_message_id" uuid NOT NULL,
	"system_prompt" text NOT NULL,
	"user_prompt" text NOT NULL,
	"response" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_response_slack_message_id_unique" UNIQUE("slack_message_id")
);
--> statement-breakpoint
ALTER TABLE "llm_response" ADD CONSTRAINT "llm_response_slack_message_id_slack_message_id_fk" FOREIGN KEY ("slack_message_id") REFERENCES "public"."slack_message"("id") ON DELETE no action ON UPDATE no action;