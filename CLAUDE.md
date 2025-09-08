# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `pnpm run lint` - Run ESLint and TypeScript type checking
- `pnpm run dkgen --name migration_name` - Generate Drizzle migration after schema changes

## Environment Variables

Required for development:
- `PV_DB_URL` - PostgreSQL connection string (e.g., `postgresql://localhost:5432/pivotal`)
- `PV_OPENROUTER_API_KEY` - OpenRouter API key for LLM interactions
- `PV_GOOGLE_CLIENT_ID` - Google OAuth client ID for calendar integration
- `PV_GOOGLE_CLIENT_SECRET` - Google OAuth client secret

Additional for production:
- `PV_SLACK_BOT_TOKEN` - Slack bot user OAuth token
- `PV_SLACK_APP_TOKEN` - Slack app-level token for socket mode

## Architecture Overview

This is a Slack bot for AI-assisted scheduling with evaluation framework.

**Core Components:**

1. **Slack Integration** (`src/slack-bot.ts`, `src/slack-message-handler.ts`)
   - Real Slack bot using Bolt framework in socket mode
   - Flack server (`src/flack-server.ts`) for local development/testing
   - Message handling with topic tracking and thread organization

2. **AI Processing** (`src/anthropic-api.ts`)
   - Uses OpenRouter AI SDK provider for LLM interactions
   - Analyzes message relevance to existing topics
   - Generates scheduling responses based on conversation context

3. **Calendar Integration** (`src/calendar-service.ts`)
   - Google Calendar OAuth flow
   - Fetches and analyzes user availability
   - Stores tokens in user_data table

4. **Database** (PostgreSQL with Drizzle ORM)
   - `topic` - Conversation topics with workflow types (scheduling/other)
   - `slack_message` - All messages linked to topics
   - `slack_user` - Slack user profiles
   - `slack_channel` - Channel membership tracking
   - `user_data` - User context including calendar tokens
   - `llm_response` - Cached LLM responses

5. **Evaluation Framework** (`src/evals/`)
   - Benchmark data generation for scheduling scenarios
   - LLM persona agents that simulate users in conversations
   - Scoring algorithms to evaluate scheduling performance
   - End-to-end evaluation via flack-eval

**Request Flow:**
1. Slack message received → Analyzed for topic relevance
2. New topic created or message added to existing topic
3. For scheduling topics → Calendar data fetched if available
4. LLM generates contextual response considering full conversation
5. Response sent back to Slack thread

## Important ESLint Rules

```javascript
{
  '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'avoidEscape' }],
  '@stylistic/semi': ['error', 'never'],
  '@stylistic/comma-dangle': ['error', 'always-multiline'],
  '@stylistic/object-curly-spacing': ['error', 'always'],
  '@stylistic/array-bracket-spacing': ['error', 'never'],
  '@stylistic/no-trailing-spaces': ['error'],
  '@stylistic/arrow-parens': ['error', 'always'],
  '@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_', 'varsIgnorePattern': '^_' }],
  '@typescript-eslint/consistent-type-imports': 'error',
}
```

## Database Conventions

- Drizzle uses snake_case naming for database columns
- All tables use UUID primary keys except Slack-specific tables (use Slack IDs)
- Timestamps include timezone information
- JSON columns store structured data (user arrays, raw Slack payloads)

## TypeScript Conventions

- Path alias `@shared/*` maps to `src/shared/*`
- Use `.ts` file extensions in imports (required for tsx)
- Strict mode enabled with no unused locals/parameters
- All imports must have checked side effects
- Always use `import ... from 'package'` syntax rather than `const ... = await import('package')`, except for the one exception of `const { App } = await import('@slack/bolt')`
