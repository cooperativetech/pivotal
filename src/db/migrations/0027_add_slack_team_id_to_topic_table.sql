ALTER TABLE "topic" ADD COLUMN "slack_team_id" text;--> statement-breakpoint

DO $$
DECLARE
  org_count integer;
  team_id text;
BEGIN
  SELECT COUNT(*) INTO org_count FROM "organization";

  IF org_count = 0 THEN
    -- Skip update, no organizations exist
    NULL;
  ELSIF org_count > 1 THEN
    RAISE EXCEPTION 'Cannot migrate: multiple organizations exist. Manual migration required.';
  ELSE
    -- Exactly 1 organization, get its slack_team_id and update all topics
    SELECT slack_team_id INTO team_id FROM "organization" LIMIT 1;
    UPDATE "topic" SET slack_team_id = team_id;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "topic" ALTER COLUMN "slack_team_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "topic" ADD CONSTRAINT "topic_slack_team_id_organization_slack_team_id_fk" FOREIGN KEY ("slack_team_id") REFERENCES "public"."organization"("slack_team_id") ON DELETE no action ON UPDATE no action;
