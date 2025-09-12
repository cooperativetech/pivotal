import { drizzle } from 'drizzle-orm/node-postgres'

const url = process.env.PV_DB_URL
if (!url) {
  throw new Error('PV_DB_URL is required. Please export it in your shell (e.g., ~/.zshrc) or set it in your process manager/CI.')
}

const dbUrl = url.includes('localhost') ? url : url + '?sslmode=no-verify'

const db = drizzle({
  connection: dbUrl,
  casing: 'snake_case',
})

export type DBType = typeof db
export type TXType = Parameters<Parameters<DBType['transaction']>[0]>[0]

export default db
