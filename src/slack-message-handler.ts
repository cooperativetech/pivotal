import type { SlackEventMiddlewareArgs, AllMiddlewareArgs } from '@slack/bolt'
import type { UsersListResponse } from '@slack/web-api'
import db from './db/engine'
import { topicTable, slackMessageTable, TopicInsert, slackUserTable, SlackUserInsert } from './db/schema/main'
import { analyzeTopicRelevance, scheduleNextStep } from './anthropic-api'
import { eq, sql } from 'drizzle-orm'
import { tsToDate } from './shared/utils'

type UsersListMember = NonNullable<UsersListResponse['members']>[number];

// Helper function to get all Slack users
export async function getSlackUsers(client: AllMiddlewareArgs['client'], includeBots = true): Promise<Map<string, string>> {
  const userMap = new Map<string, string>()
  const usersToUpsert: SlackUserInsert[] = []

  try {
    let allMembers: UsersListMember[] = []
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
      usersToUpsert.push({
        id: member.id,
        teamId: member.team_id,
        realName: member.real_name,
        tz: member.tz,
        isBot: isBot,
        deleted: member.deleted,
        updated: new Date(member.updated * 1000),
        raw: member,
      })
      if (!member.deleted && member.real_name && (!isBot || includeBots)) {
        userMap.set(member.id, member.real_name)
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
const messageProcessingLock = {
  isLocked: false,
  queue: [] as (() => void)[],
  acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.isLocked) {
        this.isLocked = true
        resolve()
      } else {
        this.queue.push(resolve)
      }
    })
  },
  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()
      next?.()
    } else {
      this.isLocked = false
    }
  },
}

async function processSchedulingActions(
  topicId: string,
  message: SlackEventMiddlewareArgs<'message'>['message'],
  client: AllMiddlewareArgs['client'],
  botUserId: string | undefined,
) {
  try {
    // Get the topic details
    const [topic] = await db.select().from(topicTable).where(eq(topicTable.id, topicId))
    if (!topic) {
      console.error('Topic not found:', topicId)
      return
    }

    // Only process scheduling topics
    if (topic.workflowType !== 'scheduling') {
      return
    }

    // Get all previous messages for this topic
    const previousMessages = await db
      .select()
      .from(slackMessageTable)
      .where(eq(slackMessageTable.topicId, topicId))
      .orderBy(slackMessageTable.timestamp)

    // Get the saved message for proper typing
    const currentMessage = previousMessages[previousMessages.length - 1]
    if (!currentMessage) {
      console.error('Current message not found')
      return
    }

    // Get Slack users for name mapping (including bots to get bot's name)
    const userMap = await getSlackUsers(client)

    // Call scheduleNextStep to determine actions
    const nextStep = await scheduleNextStep(currentMessage, topic, previousMessages.slice(0, -1), userMap, botUserId, client)
    console.log('Next scheduling step:', nextStep)

    // Always send the reply message in thread
    if ('channel' in message && 'ts' in message) {
      const response = await client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.ts,
        text: nextStep.replyMessage,
      })

      // Save the bot's reply to the database immediately
      if (response.ok && response.ts) {
        await db.insert(slackMessageTable).values({
          topicId: topicId,
          channelId: message.channel,
          userId: botUserId || 'bot',
          text: nextStep.replyMessage,
          timestamp: tsToDate(response.ts),
          raw: response.message,
        })
      }
    }

    // Process other actions based on the response
    // Update topic if needed
    if (nextStep.updateUserIds || nextStep.updateUserNames || nextStep.updateSummary) {
      const updates: Partial<TopicInsert> = {}

      // Handle updateUserNames by mapping names back to userIds
      if (nextStep.updateUserNames) {
        const nameToIdMap = new Map<string, string>()
        userMap.forEach((name, id) => {
          nameToIdMap.set(name, id)
        })

        const updatedUserIds: string[] = []
        for (const name of nextStep.updateUserNames) {
          const userId = nameToIdMap.get(name)
          if (userId) {
            updatedUserIds.push(userId)
          } else {
            console.warn(`Could not find userId for name: ${name}`)
          }
        }

        if (updatedUserIds.length > 0) {
          updates.userIds = updatedUserIds
        }
      } else if (nextStep.updateUserIds) {
        // Fallback to direct userIds if provided
        updates.userIds = nextStep.updateUserIds
      }

      if (nextStep.updateSummary) {
        updates.summary = nextStep.updateSummary
      }
      updates.updatedAt = new Date()

      await db.update(topicTable)
        .set(updates)
        .where(eq(topicTable.id, topicId))
    }

    // Send individual messages if needed
    if (nextStep.messagesToUsers && nextStep.messagesToUsers.length > 0) {
      // Create name to ID mapping
      const nameToIdMap = new Map<string, string>()
      userMap.forEach((name, id) => {
        nameToIdMap.set(name, id)
      })

      for (const messageGroup of nextStep.messagesToUsers) {
        // Determine which userIds to use
        let userIdsToMessage: string[] = []

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
        } else if (messageGroup.userIds) {
          // Fallback to direct userIds if provided
          userIdsToMessage = messageGroup.userIds
        }

        for (const userId of userIdsToMessage) {
          try {
            // Open a DM channel with the user
            const dmChannel = await client.conversations.open({
              users: userId,
            })

            // Send the message
            if (dmChannel.ok && dmChannel.channel?.id) {
              const dmResponse = await client.chat.postMessage({
                channel: dmChannel.channel.id,
                text: messageGroup.text,
              })

              // Save the bot's DM to the database immediately
              if (dmResponse.ok && dmResponse.ts) {
                await db.insert(slackMessageTable).values({
                  topicId: topicId,
                  channelId: dmChannel.channel.id,
                  userId: botUserId || 'bot',
                  text: messageGroup.text,
                  timestamp: tsToDate(dmResponse.ts),
                  raw: dmResponse.message,
                })
              }
            }
          } catch (dmError) {
            console.error(`Failed to send DM to ${userId}:`, dmError)
          }
        }
      }
    }

    // Send group message if needed
    if (nextStep.groupMessage && 'channel' in message) {
      // Create or open an MPIM (multi-party instant message) with all topic users
      if (topic.userIds && topic.userIds.length > 0) {
        try {
          // Open a conversation with multiple users (MPIM)
          const mpimResult = await client.conversations.open({
            users: topic.userIds.join(','), // Comma-separated list of user IDs
          })

          if (mpimResult.ok && mpimResult.channel?.id) {
            // Send the group message to the MPIM
            const groupResponse = await client.chat.postMessage({
              channel: mpimResult.channel.id,
              text: nextStep.groupMessage,
            })

            // Save the bot's group message to the database immediately
            if (groupResponse.ok && groupResponse.ts) {
              await db.insert(slackMessageTable).values({
                topicId: topicId,
                channelId: mpimResult.channel.id,
                userId: botUserId || 'bot',
                text: nextStep.groupMessage,
                timestamp: tsToDate(groupResponse.ts),
                raw: groupResponse.message,
              })
            }
          } else {
            console.error('Failed to open MPIM:', mpimResult.error)
            // Fallback to posting in the original channel
            const groupResponse = await client.chat.postMessage({
              channel: message.channel,
              text: nextStep.groupMessage,
            })

            if (groupResponse.ok && groupResponse.ts) {
              await db.insert(slackMessageTable).values({
                topicId: topicId,
                channelId: message.channel,
                userId: botUserId || 'bot',
                text: nextStep.groupMessage,
                timestamp: tsToDate(groupResponse.ts),
                raw: groupResponse.message,
              })
            }
          }
        } catch (mpimError) {
          console.error('Error creating MPIM:', mpimError)
          // Fallback to posting in the original channel
          const groupResponse = await client.chat.postMessage({
            channel: message.channel,
            text: nextStep.groupMessage,
          })

          if (groupResponse.ok && groupResponse.ts) {
            await db.insert(slackMessageTable).values({
              topicId: topicId,
              channelId: message.channel,
              userId: botUserId || 'bot',
              text: nextStep.groupMessage,
              timestamp: tsToDate(groupResponse.ts),
              raw: groupResponse.message,
            })
          }
        }
      } else {
        console.warn('No userIds found in topic for group message')
        // Fallback to posting in the original channel
        const groupResponse = await client.chat.postMessage({
          channel: message.channel,
          text: nextStep.groupMessage,
        })

        if (groupResponse.ok && groupResponse.ts) {
          await db.insert(slackMessageTable).values({
            topicId: topicId,
            channelId: message.channel,
            userId: botUserId || 'bot',
            text: nextStep.groupMessage,
            timestamp: tsToDate(groupResponse.ts),
            raw: groupResponse.message,
          })
        }
      }
    }

    // Handle completion and mark topic as inactive if requested
    if (nextStep.action === 'complete') {
      console.log('Scheduling workflow completed for topic:', topicId)

      if (nextStep.markTopicInactive) {
        await db.update(topicTable)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(topicTable.id, topicId))
        console.log('Topic marked as inactive:', topicId)
      }
    }
  } catch (error) {
    console.error('Error processing scheduling actions:', error)
  }
}

export async function handleSlackMessage(
  message: SlackEventMiddlewareArgs<'message'>['message'],
  botUserId: string | undefined,
  client: AllMiddlewareArgs['client'],
) {
  // Check if message has required fields
  if ('text' in message && message.text && message.ts && message.channel) {
    // Acquire the global lock before processing
    await messageProcessingLock.acquire()

    console.log(message)

    // For bot messages, we need to check differently since they don't have a user field
    const isBotMessage = 'bot_id' in message && message.bot_id
    const userId = isBotMessage ? message.bot_id! : message.user!

    const isDirectMessage = message.channel_type === 'im'
    const isBotMentioned = message.text.includes(`<@${botUserId}>`)

    try {
      // Step 1: Query all active topics from the DB
      const topics = await db.select().from(topicTable).where(eq(topicTable.isActive, true))

      // Get Slack users for name mapping (including bots to get bot's name)
      const userMap = await getSlackUsers(client)

      // Create slack message object for analysis
      const slackMessage = {
        id: '', // Will be set when inserting
        topicId: '', // Will be set based on analysis
        channelId: message.channel,
        userId: userId,
        text: message.text,
        timestamp: tsToDate(message.ts),
        raw: message,
      }

      // Step 2: Call analyzeTopicRelevance for non-bot messages
      const analysis = await analyzeTopicRelevance(topics, slackMessage, userMap, botUserId)
      console.log('Analysis result:', analysis)

      // Step 3: If message is relevant to existing topic
      if (analysis.relevantTopicId) {
        // Save message to DB related to that topic
        await db.insert(slackMessageTable).values({
          topicId: analysis.relevantTopicId,
          channelId: message.channel,
          userId: userId,
          text: message.text,
          timestamp: tsToDate(message.ts),
          raw: message,
        })

        // Update the topic's updatedAt timestamp
        await db.update(topicTable)
          .set({ updatedAt: new Date() })
          .where(eq(topicTable.id, analysis.relevantTopicId))

        // Process scheduling actions for this topic
        await processSchedulingActions(analysis.relevantTopicId, message, client, botUserId)
      }
      // Step 4: If DM or bot mentioned and could form new topic
      else if ((isDirectMessage || isBotMentioned) && analysis.suggestedNewTopic) {
        // Check if it's a scheduling workflow
        if (analysis.workflowType === 'scheduling') {
          // Create new topic
          const [newTopic] = await db.insert(topicTable).values({
            userIds: [userId],
            summary: analysis.suggestedNewTopic,
            workflowType: analysis.workflowType,
          }).returning()

          // Save message related to new topic
          await db.insert(slackMessageTable).values({
            topicId: newTopic.id,
            channelId: message.channel,
            userId: userId,
            text: message.text,
            timestamp: tsToDate(message.ts),
            raw: message,
          })

          // Process scheduling actions for this new topic
          await processSchedulingActions(newTopic.id, message, client, botUserId)
        } else {
          // Non-scheduling workflow - send canned response in thread
          await client.chat.postMessage({
            channel: message.channel,
            thread_ts: message.ts,
            text: 'Sorry, but I\'m only set up for scheduling requests at the moment. Try something like "plan lunch with the team" or "schedule a meeting for next week".',
          })
        }
      }
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
  }
}
