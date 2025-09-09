import { drizzle } from 'drizzle-orm/node-postgres'
import fs from 'fs'
import path from 'path'

// Best-effort load of .env in case process was started without env exported
try {
  if (!process.env.PV_DB_URL) {
    const envPath = path.resolve(process.cwd(), '.env')
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8')
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
        if (!m) continue
        const key = m[1]
        let val = m[2].trim()
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
          val = val.slice(1, -1)
        }
        if (process.env[key] === undefined) {
          process.env[key] = val
        }
      }
    }
  }
} catch {}

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
