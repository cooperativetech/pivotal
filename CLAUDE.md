# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `pnpm run lint` - Run ESLint and TypeScript type checking
- `pnpm run dkgen --name migration_name` - Create a drizzle migration

## Architecture Overview

This is a full-stack chat application built with modern web technologies.

**Tech Stack:**
- Backend: Hono framework on Node.js with TypeScript
- Frontend: React with TypeScript, built with Vite
- Database: PostgreSQL with Drizzle ORM
- Authentication: better-auth library
- AI Integration: OpenRouter AI SDK provider
- Styling: Tailwind CSS v4

**Core Flow:**
1. Users authenticate via better-auth system
2. Authenticated users can see other users and create group chats
3. Group chats support public context and individual chat histories
4. Chat data stored in PostgreSQL with JSON columns for flexible chat structure

**Key Files:**
- `src/server.ts` - Main Hono server with API routes and authentication
- `src/auth.ts` - Better-auth configuration
- `src/db/schema/main.ts` - Database schema for chat table
- `src/db/schema/auth.ts` - Database schema for authentication (user, session, etc.)
- `src/shared/api-types.ts` - Shared TypeScript interfaces with Zod validation
- `src/frontend/` - React components and client-side code

## Important ESLint Rules

```
{
    'quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    'semi': ['error', 'never'],
    'comma-dangle': ['error', 'always-multiline'],
    'object-curly-spacing': ['error', 'always'],
    'array-bracket-spacing': ['error', 'never'],
    'no-trailing-spaces': ['error'],
    '@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_' }],
}
```

## Other Principles

- Backend code should never import from the src/frontend folder
- Frontend code should only import from src/frontend and src/shared folders (plus third-party libs)
- Shared code between frontend and backend goes in src/shared folder
- For every API route, define request/response types in src/shared/api-types.ts using Zod schemas
- Drizzle uses snake_case naming convention for database columns
