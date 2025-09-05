import { drizzle } from 'drizzle-orm/node-postgres'

const dbUrl = process.env.PV_DB_URL!.includes('localhost')
  ? process.env.PV_DB_URL!
  : process.env.PV_DB_URL! + '?sslmode=no-verify'

const db = drizzle({
  connection: dbUrl,
  casing: 'snake_case',
})

export type DBType = typeof db
export type TXType = Parameters<Parameters<DBType['transaction']>[0]>[0]

export default db

