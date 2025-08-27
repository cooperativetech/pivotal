import type { GenericMessageEvent, BotMessageEvent } from '@slack/types'
import type { UsersListResponse, ChatPostMessageResponse, WebClient } from '@slack/web-api'
import db from './db/engine'
import type { SlackMessage, SlackUser, SlackUserInsert } from './db/schema/main'
import { topicTable, slackMessageTable, slackUserTable, slackChannelTable } from './db/schema/main'
import { analyzeTopicRelevance, scheduleNextStep } from './agents'
import { and, eq, ne, sql } from 'drizzle-orm'
import { tsToDate } from './utils'

export type SlackAPIUser = NonNullable<UsersListResponse['members']>[number]
export type SlackAPIMessage = GenericMessageEvent | BotMessageEvent

// Helper function to create or update slackChannel record
async function upsertSlackChannel(channelId: string, userIds: string[]): Promise<void> {
  try {
    await db.insert(slackChannelTable)
      .values({
        id: channelId,
        userIds: userIds,
      })
      .onConflictDoUpdate({
        target: slackChannelTable.id,
        set: {
          userIds: sql.raw('excluded.user_ids'),
        },
      })
  } catch (error) {
    console.error('Error upserting slackChannel:', error)
  }
}

// Helper function to get all Slack users
export async function getSlackUsers(client: WebClient, includeBots = true): Promise<Map<string, SlackUser>> {
  const userMap = new Map<string, SlackUser>()
  const usersToUpsert: SlackUserInsert[] = []

  try {
    let allMembers: SlackAPIUser[] = []
    let cursor: string | undefined = ''
    while (true) {
      const result = await client.users.list({
        cursor,
        limit: 200, // Recommended limit per documentation
      })
      if (result.ok && result.members) {
        allMembers = allMembers.concat(result.members)
      }
      cursor = result.response_metadata?.next_cursor
      if (!cursor) {
        break
      }
    }

    for (const member of allMembers) {
      if (!member.updated && member.id === 'USLACKBOT') {
        member.updated = 1
      }
      if (
        !member.id
        || !member.team_id
        || !member.updated
        || member.deleted === undefined
        || (!member.deleted && !member.real_name)
      ) {
        console.warn('Warning: member missing critical fields:', member)
        continue
      }
      const isBot = member.is_bot || member.id === 'USLACKBOT'
      const slackUser: SlackUserInsert = {
        id: member.id,
        teamId: member.team_id,
        realName: member.real_name,
        email: member.profile?.email?.toLowerCase(),
        tz: member.tz,
        isBot: isBot,
        deleted: member.deleted,
        updated: new Date(member.updated * 1000),
        raw: member,
      }
      usersToUpsert.push(slackUser)
      if (!member.deleted && member.real_name && (!isBot || includeBots)) {
        const userMapUser: SlackUser = {
          ...slackUser,
          realName: slackUser.realName || null,
          email: slackUser.email || null,
          tz: slackUser.tz || null,
        }
        userMap.set(member.id, userMapUser)
      }
    }

    // Perform upsert for all users
    if (usersToUpsert.length > 0) {
      await db.insert(slackUserTable)
        .values(usersToUpsert)
        .onConflictDoUpdate({
          target: slackUserTable.id,
          set: {
            teamId: sql.raw('excluded.team_id'),
            realName: sql.raw('excluded.real_name'),
            email: sql.raw('excluded.email'),
            tz: sql.raw('excluded.tz'),
            isBot: sql.raw('excluded.is_bot'),
            deleted: sql.raw('excluded.deleted'),
            updated: sql.raw('excluded.updated'),
            raw: sql.raw('excluded.raw'),
          },
        })
    }
  } catch (error) {
    console.error('Error fetching Slack users:', error)
  }

  return userMap
}

// Global lock for message processing
export const messageProcessingLock = {
  isLocked: false,
  queue: [] as (() => void)[],
  rejectQueue: [] as (() => void)[],
  acquire(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isLocked) {
        this.isLocked = true
        resolve()
      } else {
        this.queue.push(resolve)
        this.rejectQueue.push(reject)
      }
    })
  },
  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()
      this.rejectQueue.shift()
      next?.()
    } else {
      this.isLocked = false
    }
  },
  clear(): Promise<void> {
    this.rejectQueue.forEach((reject) => reject())
    this.queue = []
    this.rejectQueue = []

    // Wait for lock to be released, to finish any ongoing processing
    return new Promise((resolve) => {
      if (!this.isLocked) {
        resolve()
        return
      }
      const checkInterval = setInterval(() => {
        if (!this.isLocked) {
          clearInterval(checkInterval)
          resolve()
        }
      }, 100)
    })
  },
}

async function processSchedulingActions(
  topicId: string,
  message: SlackMessage,
  client: WebClient,
): Promise<SlackMessage[]> {
  const createdMessages: SlackMessage[] = []
  try {
    // Get the topic details
    let [topic] = await db.select().from(topicTable).where(eq(topicTable.id, topicId))
    if (!topic) {
      console.error('Topic not found:', topicId)
      return createdMessages
    }

    // Only process scheduling topics
    if (topic.workflowType !== 'scheduling') {
      return createdMessages
    }

    // Get all previous messages for this topic
    const previousMessages = await db
      .select()
      .from(slackMessageTable)
      .where(and(
        eq(slackMessageTable.topicId, topicId),
        ne(slackMessageTable.id, message.id),
      ))
      .orderBy(slackMessageTable.timestamp)

    // Get Slack users for name mapping (including bots to get bot's name)
    const userMap = await getSlackUsers(client)

    // Call scheduleNextStep to determine actions
    const nextStep = await scheduleNextStep(message, topic, previousMessages, userMap)
    console.log('Next scheduling step:', nextStep)

    // Check if the current message sender will receive any DMs
    let senderWillReceiveDM = false
    if (nextStep.messagesToUsers && nextStep.messagesToUsers.length > 0) {
      // Get the sender's name from userMap
      const senderName = userMap.get(message.userId)?.realName
      if (senderName) {
        // Check if sender is in any of the DM recipient lists
        for (const messageGroup of nextStep.messagesToUsers) {
          if (messageGroup.userNames && messageGroup.userNames.includes(senderName)) {
            senderWillReceiveDM = true
            break
          }
        }
      }
    }

    // Only send the reply message if it's not empty
    let response: ChatPostMessageResponse | null = null
    if (nextStep.replyMessage && nextStep.replyMessage.trim()) {
      response = await client.chat.postMessage({
        channel: message.channelId,
        thread_ts: message.rawTs,
        text: nextStep.replyMessage,
      })

      // Save the bot's reply to the database immediately
      if (response.ok && response.ts) {
        const [createdMessage] = await db.insert(slackMessageTable).values({
          topicId: topicId,
          channelId: message.channelId,
          userId: topic.botUserId,
          text: nextStep.replyMessage,
          timestamp: tsToDate(response.ts),
          rawTs: response.ts,
          threadTs: message.rawTs,
          raw: response.message,
        }).returning()
        createdMessages.push(createdMessage)
      }
    } else if (!nextStep.groupMessage && !senderWillReceiveDM) {
      // Only add thumbs up if there's no reply, no group message, and sender won't get a DM
      try {
        await client.reactions.add({
          channel: message.channelId,
          name: 'thumbsup',
          timestamp: message.rawTs,
        })
      } catch (reactionError) {
        console.error('Error adding thumbs up reaction:', reactionError)
      }
    }

    // Get the updated topic details, which may have changed userIds for example
    const updatedTopics = await db.select().from(topicTable).where(eq(topicTable.id, topicId))
    if (updatedTopics.length < 1) {
      console.error('Updated topic not found:', topicId)
      return createdMessages
    }
    topic = updatedTopics[0]

    // Send individual messages if needed
    if (nextStep.messagesToUsers && nextStep.messagesToUsers.length > 0) {
      // Create name to ID mapping
      const nameToIdMap = new Map<string, string>()
      userMap.forEach((user, id) => {
        if (user.realName) {
          nameToIdMap.set(user.realName, id)
        }
      })

      for (const messageGroup of nextStep.messagesToUsers) {
        // Determine which userIds to use
        const userIdsToMessage: string[] = []

        if (messageGroup.userNames) {
          // Map names back to userIds
          for (const name of messageGroup.userNames) {
            const userId = nameToIdMap.get(name)
            if (userId) {
              userIdsToMessage.push(userId)
            } else {
              console.warn(`Could not find userId for name: ${name}`)
            }
          }
        }

        for (const userId of userIdsToMessage) {
          try {
            // Open a DM channel with the user
            const dmChannel = await client.conversations.open({
              users: userId,
            })

            if (dmChannel.ok && dmChannel.channel?.id) {
              // Create or update slackChannel record for DM in the DB
              // Only include the actual user, not the bot
              await upsertSlackChannel(dmChannel.channel.id, [userId])

              // Send the message
              const dmResponse = await client.chat.postMessage({
                channel: dmChannel.channel.id,
                text: messageGroup.text,
              })

              // Save the bot's DM to the database immediately
              if (dmResponse.ok && dmResponse.ts) {
                const [createdMessage] = await db.insert(slackMessageTable).values({
                  topicId: topicId,
                  channelId: dmChannel.channel.id,
                  userId: topic.botUserId,
                  text: messageGroup.text,
                  timestamp: tsToDate(dmResponse.ts),
                  rawTs: dmResponse.ts,
                  threadTs: null,
                  raw: dmResponse.message,
                }).returning()
                createdMessages.push(createdMessage)
              }
            }
          } catch (dmError) {
            console.error(`Failed to send DM to ${userId}:`, dmError)
          }
        }
      }
    }

    // Send group message if needed
    if (nextStep.groupMessage) {
      // Create or open an MPIM (multi-party instant message) with all topic users
      if (topic.userIds && topic.userIds.length > 0) {
        try {
          // Open a conversation with multiple users (MPIM)
          const mpimResult = await client.conversations.open({
            users: topic.userIds.join(','), // Comma-separated list of user IDs
          })

          if (mpimResult.ok && mpimResult.channel?.id) {
            // Create or update slackChannel record for MPIM in the DB
            // Only include actual users, not the bot
            await upsertSlackChannel(mpimResult.channel.id, [...topic.userIds])

            // Send the group message to the MPIM
            const groupResponse = await client.chat.postMessage({
              channel: mpimResult.channel.id,
              text: nextStep.groupMessage,
            })

            // Save the bot's group message to the database immediately
            if (groupResponse.ok && groupResponse.ts) {
              const [createdMessage] = await db.insert(slackMessageTable).values({
                topicId: topicId,
                channelId: mpimResult.channel.id,
                userId: topic.botUserId,
                text: nextStep.groupMessage,
                timestamp: tsToDate(groupResponse.ts),
                rawTs: groupResponse.ts,
                threadTs: null,
                raw: groupResponse.message,
              }).returning()
              createdMessages.push(createdMessage)
            }
          } else {
            console.error('Failed to open MPIM:', mpimResult.error)
            // Fallback to posting in the original channel
            const groupResponse = await client.chat.postMessage({
              channel: message.channelId,
              text: nextStep.groupMessage,
            })

            if (groupResponse.ok && groupResponse.ts) {
              const [createdMessage] = await db.insert(slackMessageTable).values({
                topicId: topicId,
                channelId: message.channelId,
                userId: topic.botUserId,
                text: nextStep.groupMessage,
                timestamp: tsToDate(groupResponse.ts),
                rawTs: groupResponse.ts,
                threadTs: message.rawTs,
                raw: groupResponse.message,
              }).returning()
              createdMessages.push(createdMessage)
            }
          }
        } catch (mpimError) {
          console.error('Error creating MPIM:', mpimError)
          // Fallback to posting in the original channel
          const groupResponse = await client.chat.postMessage({
            channel: message.channelId,
            text: nextStep.groupMessage,
          })

          if (groupResponse.ok && groupResponse.ts) {
            const [createdMessage] = await db.insert(slackMessageTable).values({
              topicId: topicId,
              channelId: message.channelId,
              userId: topic.botUserId,
              text: nextStep.groupMessage,
              timestamp: tsToDate(groupResponse.ts),
              rawTs: groupResponse.ts,
              threadTs: message.rawTs,
              raw: groupResponse.message,
            }).returning()
            createdMessages.push(createdMessage)
          }
        }
      } else {
        console.warn('No userIds found in topic for group message')
        // Fallback to posting in the original channel
        const groupResponse = await client.chat.postMessage({
          channel: message.channelId,
          text: nextStep.groupMessage,
        })

        if (groupResponse.ok && groupResponse.ts) {
          const [createdMessage] = await db.insert(slackMessageTable).values({
            topicId: topicId,
            channelId: message.channelId,
            userId: topic.botUserId,
            text: nextStep.groupMessage,
            timestamp: tsToDate(groupResponse.ts),
            rawTs: groupResponse.ts,
            threadTs: message.rawTs,
            raw: groupResponse.message,
          }).returning()
          createdMessages.push(createdMessage)
        }
      }
    }

    // Mark topic as inactive if requested
    if (nextStep.markTopicInactive) {
      await db.update(topicTable)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(topicTable.id, topicId))
      console.log('Scheduling workflow topic marked as inactive:', topicId)
    }
  } catch (error) {
    console.error('Error processing scheduling actions:', error)
  }
  return createdMessages
}

async function getOrCreateTopic(
  message: SlackAPIMessage,
  botUserId: string,
  client: WebClient,
  ignoreExistingTopics: boolean = false,
): Promise<string | null> {
  // Ensure we have required fields
  if (!('text' in message && message.text && message.ts && message.channel)) {
    return null
  }

  // For bot messages, we need to check differently since they don't have a user field
  const isBotMessage = 'bot_id' in message && message.bot_id
  const userId = isBotMessage ? message.bot_id! : message.user!

  const isDirectMessage = message.channel_type === 'im'
  const isBotMentioned = message.text.includes(`<@${botUserId}>`)

  // Get Slack users for name mapping (including bots to get bot's name)
  const userMap = await getSlackUsers(client)

  // Step 1: Query all active topics from the DB
  const topics = ignoreExistingTopics ? [] : await db.select().from(topicTable).where(eq(topicTable.isActive, true))

  // Create slack message object for analysis
  const slackMessage = {
    id: '', // Will be set when inserting
    topicId: '', // Will be set based on analysis
    channelId: message.channel,
    userId: userId,
    text: message.text,
    timestamp: tsToDate(message.ts),
    rawTs: message.ts,
    threadTs: ('thread_ts' in message && message.thread_ts) ? message.thread_ts : null,
    raw: message,
  }

  // Step 2: Call analyzeTopicRelevance for non-bot messages
  const analysis = await analyzeTopicRelevance(topics, slackMessage, userMap, botUserId)
  console.log('Analysis result:', analysis)

  // Step 3: If message is relevant to existing topic
  if (analysis.relevantTopicId) {
    return analysis.relevantTopicId
  }

  // Step 4: If DM or bot mentioned and could form new topic
  if ((isDirectMessage || isBotMentioned) && analysis.suggestedNewTopic) {
    // Check if it's a scheduling workflow
    if (analysis.workflowType === 'scheduling') {
      // Extract mentioned users from the message text
      const mentionedUserIds = new Set<string>([userId]) // Start with the sender

      // Look for user mentions in the format <@USERID>
      const mentionPattern = /<@([A-Z0-9_]+)>/g
      let match
      while ((match = mentionPattern.exec(message.text)) !== null) {
        const mentionedId = match[1]
        if (mentionedId !== botUserId) { // Don't include the bot
          mentionedUserIds.add(mentionedId)
        }
      }

      // Also look for mentioned names if we have the user map
      if (userMap.size > 0) {
        const messageText = message.text
        userMap.forEach((user, id) => {
          // Check if this user's name appears in the message
          if (user.realName && messageText.includes(user.realName) && id !== botUserId) {
            mentionedUserIds.add(id)
          }
        })
      }

      console.log(`Creating topic with users: ${Array.from(mentionedUserIds).join(', ')}`)

      // Create new topic with all mentioned users
      const [newTopic] = await db.insert(topicTable).values({
        userIds: Array.from(mentionedUserIds),
        botUserId: botUserId,
        summary: analysis.suggestedNewTopic,
        workflowType: analysis.workflowType,
      }).returning()

      return newTopic.id
    } else {
      // Non-scheduling workflow - send canned response in thread
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.ts,
        text: 'Sorry, but I\'m only set up for scheduling requests at the moment. Try something like "plan lunch with the team" or "schedule a meeting for next week".',
      })
      return null
    }
  }

  return null
}

async function saveMessageToTopic(
  topicId: string,
  message: SlackAPIMessage,
): Promise<SlackMessage> {
  const userId = ('bot_id' in message && message.bot_id) ? message.bot_id : message.user!
  const isDirectMessage = message.channel_type === 'im'

  // For DM channels, ensure the channel record exists with both users
  if (isDirectMessage) {
    // Get the topic to find the other participant (the bot)
    const [topic] = await db.select().from(topicTable).where(eq(topicTable.id, topicId))
    if (topic) {
      // For DMs, only include the actual user, not the bot
      await upsertSlackChannel(message.channel, [userId])
    }
  }

  // Save message to DB related to that topic
  const [slackMessage] = await db.insert(slackMessageTable).values({
    topicId: topicId,
    channelId: message.channel,
    userId: userId,
    text: message.text!,
    timestamp: tsToDate(message.ts),
    rawTs: message.ts,
    threadTs: ('thread_ts' in message && message.thread_ts) ? message.thread_ts : null,
    raw: message,
  }).returning()

  // Update the topic's updatedAt timestamp
  await db.update(topicTable)
    .set({ updatedAt: new Date() })
    .where(eq(topicTable.id, topicId))

  return slackMessage
}

interface MessageProcessingRes {
  topicId: string,
  savedReqMessage: SlackMessage,
  resMessages: SlackMessage[],
}

async function getOrCreateDummyTopic(botUserId: string): Promise<string> {
  const DUMMY_SUMMARY = 'dummy topic for uncategorized messages'
  const [dummyTopic] = await db.select()
    .from(topicTable)
    .where(and(
      eq(topicTable.summary, DUMMY_SUMMARY),
      eq(topicTable.workflowType, 'other'),
    ))
  if (dummyTopic) {
    return dummyTopic.id
  }
  const [newDummyTopic] = await db.insert(topicTable).values({
    botUserId: botUserId,
    summary: DUMMY_SUMMARY,
    workflowType: 'other',
  }).returning()
  return newDummyTopic.id
}

export async function handleSlackMessage(
  message: SlackAPIMessage,
  botUserId: string,
  client: WebClient,
  presetTopicId: string | null = null,
  ignoreExistingTopics: boolean = false,
): Promise<MessageProcessingRes | null> {
  // Check if message has required fields
  if (!('text' in message && message.text && message.ts && message.channel)) {
    return null
  }

  // Acquire the global lock before processing
  try {
    await messageProcessingLock.acquire()
  } catch {
    console.log('Clearing queue, skipping handleSlackMessage for message:', message)
    return null
  }
  console.log('Processing message:', message)

  try {
    // Route message to topic (creates topic if necessary)
    const topicId = presetTopicId ? presetTopicId : await getOrCreateTopic(message, botUserId, client, ignoreExistingTopics)

    // If getOrCreateTopic returns null or the dummy topic, save the message to the dummy topic and return
    const dummyTopicId = await getOrCreateDummyTopic(botUserId)
    if (!topicId || topicId === dummyTopicId) {
      await saveMessageToTopic(dummyTopicId, message)
      return null
    }

    const savedReqMessage = await saveMessageToTopic(topicId, message)
    const resMessages = await processSchedulingActions(
      topicId,
      savedReqMessage,
      client,
    )

    return { topicId, savedReqMessage, resMessages }
  } catch (error) {
    console.error('Error processing message:', error)
    // Optionally add an error reaction
    try {
      await client.reactions.add({
        channel: message.channel,
        name: 'x',
        timestamp: message.ts,
      })
    } catch (reactionError) {
      console.error('Error adding error reaction:', reactionError)
    }
  } finally {
    // Always release the lock when done
    messageProcessingLock.release()
  }

  return null
}
