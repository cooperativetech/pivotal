# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `pnpm run lint` - Run TypeScript type checking and ESLint with cache
- `pnpm run dkgen --name migration_name` - Generate Drizzle migration after schema changes

## Architecture Overview

### Application Structure

The application is a Slack bot with an integrated web interface that facilitates scheduling and meeting preparation workflows:

- **Backend**: Hono-based HTTP server (`src/server.ts`) with multiple deployment modes (local, dev, prod)
- **Slack Integration**: Slack Bolt SDK for websocket-based message handling and interactive components
- **Frontend**: React + Vite SPA with React Router for user authentication and topic management
- **Database**: PostgreSQL with Drizzle ORM for type-safe database operations
- **Authentication**: Better-auth library with GitHub, Google, and Slack OAuth providers

### Key Components

**Server & API** (`src/server.ts`, `src/routes/`)
- Main Hono server handles both API routes and static file serving
- `/api` routes: Protected endpoints for user profile, topics, calendar, GitHub repos
- `/local_api` routes: Development-only endpoints for simulating Slack interactions
- Environment-based configuration (local uses port 3001, dev/prod use 3009)

**Slack Bot** (`src/slack-bot.ts`, `src/slack-message-handler.ts`)
- WebSocket connection via Slack Bolt for real-time messaging
- Message handler processes conversations and manages topic states
- Interactive components for calendar preferences and user actions
- Auto-message cron for scheduled reminders and prompts

**Agent System** (`src/agents/`)
- Workflow-specific agents mapped by type (scheduling, meeting-prep)
- AI-powered conversation handling with OpenRouter/OpenAI models
- Langfuse integration for LLM observability and tracing
- Organization context tools for GitHub integration (action items, commit summaries)

**Database Schema** (`src/db/schema/`)
- `main.ts`: Core application tables (topics, messages, users, calendars)
- `auth.ts`: Better-auth tables (users, sessions, accounts, verifications)
- Topic state management with per-user context tracking
- Slack message storage with full raw payload preservation

**Integrations** (`src/integrations/`)
- **GitHub**: OAuth flow for app installation, repository access via Octokit
- **Google**: Calendar API integration with service account support
- **Slack**: OAuth installation flow and user account linking

**Calendar Service** (`src/calendar-service.ts`)
- User calendar fetching via Google OAuth
- Bot-created events using service account impersonation
- Automatic Google Meet link generation
- Calendar preference management

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
- All tables use UUID primary keys except auth tables and Slack-specific tables (use Slack IDs)
- Timestamps include timezone information
- JSON columns store structured data (user arrays, raw Slack payloads)

## TypeScript Conventions

- Path alias `@shared/*` maps to `src/shared/*`
- Always use `import ... from 'package'` syntax rather than `const ... = await import('package')`, except for the one exception of `const { App } = await import('@slack/bolt')`

## Frontend Conventions

- Always use `cursor-pointer` and `disabled:cursor-default` in the className for buttons

## Git Commit Template

```
[Concise commit message title]

Summary:

Test Plan:

```
- wrap commit messages at 72 characters
- keep commit titles to 72 characters or less
- in commit messages, don't take credit for authoring code