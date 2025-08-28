import { eq } from 'drizzle-orm'
import { z } from 'zod'

import type { RunContext } from './agent-sdk'
import { Agent, Runner, tool } from './agent-sdk'
import db from '../db/engine'
import type { Topic, SlackMessage, SlackUser } from '../db/schema/main'
import { topicTable } from '../db/schema/main'
import {
  tsToDate,
  organizeMessagesByChannelAndThread,
  replaceUserMentions,
  getChannelDescription,
  formatTimestampWithTimezone,
} from '../utils'
import { getShortTimezoneFromIANA } from '@shared/utils'

export interface ConversationContext {
  topic: Topic,
  userMap: Map<string, SlackUser>,
  callingUserTimezone: string,
}

export const ConversationRes = z.strictObject({
  replyMessage: z.string().optional().nullable(),
  markTopicInactive: z.boolean().optional().nullable(),
  messagesToUsers: z.array(z.strictObject({
    userNames: z.array(z.string()),
    text: z.string(),
    includeCalendarButtons: z.boolean().optional().nullable(),
  })).optional().nullable(),
  groupMessage: z.string().optional().nullable(),
  reasoning: z.string(),
})
export type ConversationRes = z.infer<typeof ConversationRes>

export const ConversationAgent = Agent<ConversationContext, typeof ConversationRes>
export type ConversationAgent = InstanceType<typeof ConversationAgent>

export const updateUserNames = tool({
  name: 'updateUserNames',
  description: 'Update the list of users involved in the topic. Provide the COMPLETE list of user names who should be involved going forward (this replaces the existing list).',
  parameters: z.strictObject({
    userNames: z.array(z.string()).describe('Complete list of user names who should be involved (use exact names from User Directory)'),
  }),
  execute: async ({ userNames }, runContext?: RunContext<ConversationContext>) => {
    console.log('Tool called: updateUserNames with names:', userNames)

    if (!runContext) throw new Error('runContext not provided')
    const { topic, userMap } = runContext.context

    // Map names to user IDs
    const updatedUserIds: string[] = []

    for (const name of userNames) {
      let foundId: string | undefined
      for (const [id, user] of userMap.entries()) {
        if (user.realName === name) {
          foundId = id
          break
        }
      }

      if (foundId) {
        updatedUserIds.push(foundId)
      } else {
        throw new Error(`Could not find user ID for name: ${name}`)
      }
    }

    // Update the topic in the database with the new user IDs
    const [updatedTopic] = await db
      .update(topicTable)
      .set({
        userIds: updatedUserIds,
        updatedAt: new Date(),
      })
      .where(eq(topicTable.id, topic.id))
      .returning()

    // Update runContext with the updated topic
    runContext.context.topic = updatedTopic

    // Map IDs back to names for the response
    const updatedUserNames = updatedUserIds.map((id) => userMap.get(id)?.realName || id)
    return `Updated user list to: ${updatedUserNames.join(', ')}`
  },
})

export const updateSummary = tool({
  name: 'updateSummary',
  description: 'Update the topic summary when new information clarifies or changes the topic details.',
  parameters: z.strictObject({
    summary: z.string().describe('The updated topic summary'),
  }),
  execute: async ({ summary }, runContext?: RunContext<ConversationContext>) => {
    console.log('Tool called: updateSummary with summary:', summary)

    if (!runContext) throw new Error('runContext not provided')
    const { topic } = runContext.context

    // Update the topic in the database with the new summary
    const [updatedTopic] = await db
      .update(topicTable)
      .set({
        summary,
        updatedAt: new Date(),
      })
      .where(eq(topicTable.id, topic.id))
      .returning()

    // Update runContext with the updated topic
    runContext.context.topic = updatedTopic

    return `Updated topic summary to: ${summary}`
  },
})

export async function runConversationAgent(
  agent: ConversationAgent,
  message: SlackMessage,
  topic: Topic,
  previousMessages: SlackMessage[],
  userMap: Map<string, SlackUser>,
): Promise<ConversationRes> {
  // If user is explicitly asking for calendar connection, send link immediately
  const userRequestingCalendar = message.text.toLowerCase().includes('calendar') &&
    (message.text.toLowerCase().includes('link') ||
     message.text.toLowerCase().includes('connect') ||
     message.text.toLowerCase().includes('send me'))

  if (userRequestingCalendar) {
    const userName = userMap.get(message.userId)?.realName
    if (!userName) {
      throw new Error(`User ${message.userId} has no realName in userMap`)
    }

    return {
      replyMessage: '',
      messagesToUsers: [
        {
          userNames: [userName],
          text: 'Here are your Google Calendar connection options. Connecting will allow me to check your availability automatically when scheduling.',
          includeCalendarButtons: true,
        },
      ],
      reasoning: 'User explicitly requested calendar connection - showing fancy buttons',
    }
  }

  // Get timezone information for the calling user
  const callingUser = userMap.get(message.userId)
  const callingUserTimezone = callingUser?.tz || 'UTC'

  // Get channel information for descriptive display
  const channelDescription = await getChannelDescription(message.channelId, userMap)

  const userPrompt = `Your name in conversations: ${userMap.get(topic.botUserId)?.realName || 'Assistant'}

Previous Messages in this Topic:
${await organizeMessagesByChannelAndThread(previousMessages, callingUserTimezone)}

Message To Reply To:
From: ${userMap.get(message.userId)?.realName || 'Unknown User'} (Timezone: ${callingUser?.tz ? getShortTimezoneFromIANA(callingUserTimezone) : 'Unknown'})
Text: "${replaceUserMentions(message.text, userMap)}"
Channel: ${channelDescription}${
  message.raw && typeof message.raw === 'object' && 'thread_ts' in message.raw && typeof message.raw.thread_ts === 'string'
    ? `\nThread: [${formatTimestampWithTimezone(tsToDate(message.raw.thread_ts), callingUserTimezone)}]`
    : ''
}
Timestamp: ${formatTimestampWithTimezone(message.timestamp, callingUserTimezone)}

Based on the conversation history and current message, determine the next step in the scheduling workflow and generate the appropriate response.`

  console.log(`User prompt: ${userPrompt}`)

  try {
    const runner = new Runner({ groupId: `topic-${topic.id}` })
    const result = await runner.run(
      agent,
      userPrompt,
      { context: { topic, userMap, callingUserTimezone } },
    )
    if (!result.finalOutput) {
      throw new Error('No finalOutput generated')
    }
    return result.finalOutput
  } catch (error) {
    console.error('=== ERROR IN runConversationAgent ===')
    console.error('Error type:', error instanceof Error ? error.constructor.name : typeof error)
    console.error('Error message:', error instanceof Error ? error.message : String(error))
    console.error('Stack trace:', error instanceof Error ? error.stack : 'No stack trace')
    console.error('Full error object:', JSON.stringify(error, null, 2))
    console.error('=================================')

    // Return a safe default response
    return {
      replyMessage: 'I encountered an error processing the scheduling request.',
      reasoning: `Error occurred: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
