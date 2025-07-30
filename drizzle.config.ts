import { defineConfig } from 'drizzle-kit'

const dbUrl = process.env.PV_DB_URL!.includes('localhost')
  ? process.env.PV_DB_URL!
  : process.env.PV_DB_URL! + '?sslmode=no-verify'

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
