-- Remove Google Calendar properties from UserContext JSON in user_data table
UPDATE user_data
SET context = context - 'googleAccessToken'
                      - 'googleRefreshToken'
                      - 'googleTokenExpiryDate'
                      - 'googleConnectedAt'
                      - 'calendar'
                      - 'calendarRangeLastFetched'
WHERE context IS NOT NULL
  AND jsonb_typeof(context) = 'object';
