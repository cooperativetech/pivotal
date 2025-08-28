import { Hono, type Context } from 'hono'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { webappRoutes } from './webapp/routes'

const PORT = 3000
const webapp = new Hono()
  .use(logger((message) => {
    const logEntry = `[${new Date().toISOString()}] ${message}`
    console.log(logEntry)
  }))
  .route('/api', webappRoutes)

export type WebappType = typeof webapp

serve({ fetch: webapp.fetch, port: PORT })
console.log(`Webapp server running on port ${PORT}...`)