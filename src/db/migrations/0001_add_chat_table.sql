CREATE TABLE "chat" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"group_chat" json NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
