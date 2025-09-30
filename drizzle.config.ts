import { defineConfig } from 'drizzle-kit'

const url = process.env.PV_DB_URL
if (!url) {
  throw new Error('PV_DB_URL is required. Please export it in your shell (e.g., ~/.zshrc).')
}

const dbUrl = url.includes('localhost') ? url : url + '?sslmode=no-verify'

export default defineConfig({
  out: './src/db/migrations',
  schema: './src/db/schema',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    url: dbUrl,
  },
  migrations: {
    schema: 'public',
  },
})
