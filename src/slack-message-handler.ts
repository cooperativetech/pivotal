import type { GenericMessageEvent, BotMessageEvent } from '@slack/types'
import type { UsersListResponse, WebClient } from '@slack/web-api'
import db from './db/engine'
import type { SlackMessage, SlackUser, SlackUserInsert } from './db/schema/main'
import { topicTable, topicStateTable, slackMessageTable, slackUserTable, slackChannelTable } from './db/schema/main'
import { workflowAgentMap, analyzeTopicRelevance, runConversationAgent } from './agents'
import { and, eq, ne, sql } from 'drizzle-orm'
import { tsToDate, getTopicWithState, getTopics, updateTopicState } from './utils'
import { shouldShowCalendarButtons, addPromptedUser, generateGoogleAuthUrl } from './calendar-service'

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

export async function processSchedulingActions(
  topicId: string,
  message: SlackMessage,
  client: WebClient,
): Promise<SlackMessage[]> {
  const createdMessages: SlackMessage[] = []
  try {
    // Get the topic details
    let topic = await getTopicWithState(topicId)

    // Check if it's a valid workflow type, i.e. not 'other'
    const workflowAgent = workflowAgentMap.get(topic.workflowType)
    if (!workflowAgent) {
      return createdMessages
    }

    // Check if this is a group message (not DM) by looking at the channel's user list
    const [channel] = await db.select()
      .from(slackChannelTable)
      .where(eq(slackChannelTable.id, message.channelId))
    if (!channel) {
      throw new Error(`Channel ${message.channelId} not found in database`)
    }

    // Don't act on group messages unless bot is explicitly @mentioned
    const isDirectMessage = channel.userIds.length === 1
    const isBotMentioned = message.text.includes(`<@${topic.botUserId}>`)
    if (!isDirectMessage && !isBotMentioned) {
      try {
        await client.reactions.add({
          channel: message.channelId,
          name: 'thumbsup',
          timestamp: message.rawTs,
        })
      } catch (reactionError) {
        console.error('Error adding thumbs up reaction:', reactionError)
      }
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

    // Use conversation agent to determine actions
    const nextStep = await runConversationAgent(
      workflowAgent,
      message,
      topic,
      previousMessages,
      userMap,
    )
    console.log('Next workflow step:', nextStep)

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


    if (message.autoMessageId) {
      console.log('Skipping sending reply to AutoMessage')
    } else if (nextStep.replyMessage && nextStep.replyMessage.trim()) {
      // Only send the reply message if it's not empty
      const response = await client.chat.postMessage({
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
    topic = await getTopicWithState(topicId)

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

              let blocks = undefined

              // Check if AI requested calendar buttons for this message
              if (messageGroup.includeCalendarButtons) {
                // Check if this user should get calendar connection buttons
                const shouldShow = await shouldShowCalendarButtons(topicId, userId)

                if (shouldShow) {
                  // Generate OAuth URL for direct linking
                  const authUrl = generateGoogleAuthUrl(topicId, userId)

                  // Add calendar connection buttons using Block Kit format
                  blocks = [
                    {
                      type: 'section',
                      text: {
                        type: 'mrkdwn',
                        text: 'To help with scheduling, you can connect your Google Calendar:',
                      },
                    },
                    {
                      type: 'actions',
                      elements: [
                        {
                          type: 'button',
                          text: {
                            type: 'plain_text',
                            text: 'Connect Google Calendar',
                          },
                          style: 'primary',
                          url: authUrl, // Direct URL link for seamless UX
                        },
                        {
                          type: 'button',
                          text: {
                            type: 'plain_text',
                            text: 'Not now',
                          },
                          action_id: 'calendar_not_now',
                        },
                        {
                          type: 'button',
                          text: {
                            type: 'plain_text',
                            text: "Don't ask this again",
                          },
                          action_id: 'dont_ask_calendar_again',
                        },
                      ],
                    },
                  ]

                  // Record that we've prompted this user for calendar connection
                  await addPromptedUser(topicId, userId, message.id)
                }
              }

              // Send the message with optional blocks
              const dmResponse = await client.chat.postMessage({
                channel: dmChannel.channel.id,
                text: messageGroup.text,
                ...(blocks && { blocks }),
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
      if (topic.state.userIds && topic.state.userIds.length > 0) {
        try {
          // Open a conversation with multiple users (MPIM)
          const mpimResult = await client.conversations.open({
            users: topic.state.userIds.join(','), // Comma-separated list of user IDs
          })

          if (mpimResult.ok && mpimResult.channel?.id) {
            // Create or update slackChannel record for MPIM in the DB
            // Only include actual users, not the bot
            await upsertSlackChannel(mpimResult.channel.id, [...topic.state.userIds])

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

    // Handle finalized event - create calendar invite (bot-only, no fallback)
    if (nextStep.finalizedEvent) {
      console.log('Creating calendar invite for finalized event:', nextStep.finalizedEvent)

      // Determine the leader/organizer - use the first user in the topic who has calendar connected
      // If no one has calendar connected, skip calendar invite creation
      let organizerUserId: string | null = null
      for (const userId of topic.state.userIds) {
        const userContext = await getUserContext(userId)
        if (userContext.googleAccessToken && userContext.googleAccessToken !== 'fake-token-for-eval') {
          organizerUserId = userId
          break
        }
      }

      if (organizerUserId) {
        const calendarResult = await createCalendarInviteFromLeader(
          topic,
          nextStep.finalizedEvent,
        )
      }

      if (calendarResult) {
        // Send a message with only the Google Meet link
        const actionWord = existing ? 'updated' : 'created'
        let calendarMessage = `Calendar invite ${actionWord}! 📅`
        if (calendarResult.meetLink) {
          calendarMessage += `\nGoogle Meet link: ${calendarResult.meetLink}`
        }

        const targetChannel = message.channelId
        const calendarResponse = await client.chat.postMessage({
          channel: targetChannel,
          thread_ts: message.rawTs,
          text: calendarMessage,
        })

        if (calendarResponse.ok && calendarResponse.ts) {
          const [createdMessage] = await db.insert(slackMessageTable).values({
            topicId: topicId,
            channelId: targetChannel,
            userId: topic.botUserId,
            text: calendarMessage,
            timestamp: tsToDate(calendarResponse.ts),
            rawTs: calendarResponse.ts,
            threadTs: message.rawTs,
            raw: calendarResponse.message,
          }).returning()
          createdMessages.push(createdMessage)
        }
      } else {
        console.log('No calendar invite created - bot credentials missing or failed')
      }
    }

    // Mark topic as inactive if requested
    if (nextStep.markTopicInactive) {
      await updateTopicState(topic, { isActive: false }, message.id)
      console.log('Workflow topic marked as inactive:', topicId)
    }
  } catch (error) {
    console.error('Error processing topic actions:', error)
  }
  return createdMessages
}

async function getOrCreateTopic(
  message: SlackMessage,
  botUserId: string,
  client: WebClient,
  ignoreExistingTopics: boolean = false,
): Promise<string | null> {
  // Check if this message is a DM by looking at the channel's user list
  const [channel] = await db.select()
    .from(slackChannelTable)
    .where(eq(slackChannelTable.id, message.channelId))
  if (!channel) {
    throw new Error(`Channel ${message.channelId} not found in database`)
  }

  const isDirectMessage = channel.userIds.length === 1
  const isBotMentioned = message.text.includes(`<@${botUserId}>`)

  // Get Slack users for name mapping (including bots to get bot's name)
  const userMap = await getSlackUsers(client)

  // Step 1: Query all of this bot's active topics from the DB
  const topics = ignoreExistingTopics ? [] : await getTopics(botUserId, true)

  // Step 2: Call analyzeTopicRelevance
  const analysis = await analyzeTopicRelevance(topics, message, userMap, botUserId)
  console.log('Analysis result:', analysis)

  // Step 3: If message is relevant to existing topic
  if (analysis.relevantTopicId) {
    return analysis.relevantTopicId
  }

  // Step 4: If DM or bot mentioned and could form new topic
  if ((isDirectMessage || isBotMentioned) && analysis.suggestedNewTopic) {
    // Check if it's a valid workflow type, i.e. not 'other'
    if (analysis.workflowType && workflowAgentMap.has(analysis.workflowType)) {
      // Extract mentioned users from the message text
      const mentionedUserIds = new Set<string>([message.userId]) // Start with the sender

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
        botUserId: botUserId,
        workflowType: analysis.workflowType,
      }).returning()

      // Create initial state for the new topic
      await db.insert(topicStateTable).values({
        topicId: newTopic.id,
        userIds: Array.from(mentionedUserIds),
        summary: analysis.suggestedNewTopic,
        createdByMessageId: message.id,
      })

      return newTopic.id
    } else {
      // Invalid workflow - send canned response in thread
      await client.chat.postMessage({
        channel: message.channelId,
        thread_ts: message.rawTs,
        text: 'Sorry, but I\'m only set up for scheduling or meeting preparation requests at the moment. Try something like "plan lunch with the team" or "help us prepare for our standup tomorrow".',
      })
      return null
    }
  }

  return null
}

async function saveMessageToDummyTopic(
  botUserId: string,
  message: SlackAPIMessage,
  autoMessageId: string | null,
  client: WebClient,
): Promise<SlackMessage> {
  const DUMMY_SUMMARY = 'dummy topic for uncategorized messages'

  // Check if a dummy topic exists for this bot user
  const [existingDummyRow] = await db.select()
    .from(topicTable)
    .innerJoin(topicStateTable, eq(topicTable.id, topicStateTable.topicId))
    .where(and(
      eq(topicTable.botUserId, botUserId),
      eq(topicTable.workflowType, 'other'),
      eq(topicStateTable.summary, DUMMY_SUMMARY),
    ))

  // Create a new dummy topic if one was not found
  const dummyTopicId = (
    existingDummyRow ?
    existingDummyRow.topic.id :
    (await db
      .insert(topicTable)
      .values({
        botUserId: botUserId,
        workflowType: 'other',
      })
      .returning()
    )[0].id
  )

  const userId = ('bot_id' in message && message.bot_id) ? message.bot_id : message.user!

  // Make sure to create a DB slackChannel for the message, unless it's coming from an AutoMessage
  if (!autoMessageId) {
    // Fetch channel members from Slack API, handling pagination if needed
    let allMemberIds: string[] = []
    let cursor: string | undefined = ''
    while (true) {
      const result = await client.conversations.members({
        channel: message.channel,
        cursor,
      })
      if (result.ok && result.members) {
        allMemberIds = allMemberIds.concat(result.members)
      }
      cursor = result.response_metadata?.next_cursor
      if (!cursor) {
        break
      }
    }
    if (allMemberIds.length === 0) {
      throw new Error(`Failed to fetch channel members for ${message.channel}`)
    }

    // Filter out the bot from the member list, and upsert the slack channel
    const nonBotMemberIds = allMemberIds.filter((memberId) => memberId !== botUserId)
    await upsertSlackChannel(message.channel, nonBotMemberIds)
  }

  // Save message to DB related to the dummy topic
  const [slackMessage] = await db.insert(slackMessageTable).values({
    topicId: dummyTopicId,
    channelId: message.channel,
    userId: userId,
    text: message.text!,
    timestamp: tsToDate(message.ts),
    rawTs: message.ts,
    threadTs: ('thread_ts' in message && message.thread_ts) ? message.thread_ts : null,
    raw: message,
    autoMessageId: autoMessageId,
  }).returning()


  // If we created a new dummy topic, insert the dummy topic state
  if (!existingDummyRow) {
    await db.insert(topicStateTable).values({
      topicId: dummyTopicId,
      summary: DUMMY_SUMMARY,
      userIds: [],
      createdByMessageId: slackMessage.id,
    })
  }

  return slackMessage
}

interface MessageProcessingRes {
  topicId: string,
  savedReqMessage: SlackMessage,
  resMessages: SlackMessage[],
}

export async function handleSlackMessage(
  apiMessage: SlackAPIMessage,
  botUserId: string,
  client: WebClient,
  presetTopicId: string | null = null,
  ignoreExistingTopics: boolean = false,
  autoMessageId: string | null = null,
): Promise<MessageProcessingRes | null> {
  // Check if message has required fields
  if (!('text' in apiMessage && apiMessage.text && apiMessage.ts && apiMessage.channel)) {
    return null
  }

  // Acquire the global lock before processing
  try {
    await messageProcessingLock.acquire()
  } catch {
    console.log('Clearing queue, skipping handleSlackMessage for apiMessage:', apiMessage)
    return null
  }
  console.log('Processing message:', apiMessage)

  try {
    // Save the message to the dummy topic by default
    const message = await saveMessageToDummyTopic(botUserId, apiMessage, autoMessageId, client)

    // Route message to topic (creates topic if necessary)
    const topicId = presetTopicId ? presetTopicId : await getOrCreateTopic(message, botUserId, client, ignoreExistingTopics)

    // If getOrCreateTopic returns null or the dummy topic, leave the message
    // saved to the dummy topic and return
    if (!topicId || topicId === message.topicId) {
      return null
    }

    const [savedReqMessage] = await db.update(slackMessageTable)
      .set({ topicId })
      .where(eq(slackMessageTable.id, message.id))
      .returning()

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
        channel: apiMessage.channel,
        name: 'x',
        timestamp: apiMessage.ts,
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
