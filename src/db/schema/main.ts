import {
  pgTable,
  text,
  timestamp,
  json,
} from 'drizzle-orm/pg-core'
import { GroupChat } from '../../shared/api-types.ts'

export const chat = pgTable('chat', {
  id: text().primaryKey(),
  name: text().notNull(),
  groupChat: json().$type<GroupChat>().notNull(),
  createdAt: timestamp().notNull().defaultNow(),
})
