const { App } = await import('@slack/bolt')
import db from './db/engine'
import { topicTable, slackMessageTable } from './db/schema/main'
import { analyzeTopicRelevance } from './anthropic-api'
import { eq } from 'drizzle-orm'

const app = new App({
  token: process.env.PV_SLACK_BOT_TOKEN,
  appToken: process.env.PV_SLACK_APP_TOKEN,
  socketMode: true,
})

app.message(async ({ message, context, client }) => {
  if ('text' in message && message.text && message.user && message.ts && message.channel) {
    console.log(message)
    const isDirectMessage = message.channel_type === 'im'
    const isBotMentioned = message.text.includes(`<@${context.botUserId}>`)

    try {
      // Step 1: Query all existing topics from the DB
      const topics = await db.select().from(topicTable)

      // Create slack message object for analysis
      const slackMessage = {
        id: '', // Will be set when inserting
        topicId: '', // Will be set based on analysis
        channelId: message.channel,
        userId: message.user,
        text: message.text,
        timestamp: new Date(parseFloat(message.ts) * 1000),
        raw: message,
      }

      // Step 2: Call analyzeTopicRelevance
      const analysis = await analyzeTopicRelevance(topics, slackMessage)
      console.log('Analysis result:', analysis)

      // Step 3: If message is relevant to existing topic
      if (analysis.relevantTopicId) {
        // Save message to DB related to that topic
        await db.insert(slackMessageTable).values({
          topicId: analysis.relevantTopicId,
          channelId: message.channel,
          userId: message.user,
          text: message.text,
          timestamp: new Date(parseFloat(message.ts) * 1000),
          raw: message,
        })

        // Add thumbs up reaction
        await client.reactions.add({
          channel: message.channel,
          name: 'thumbsup',
          timestamp: message.ts,
        })

        // Update the topic's updatedAt timestamp
        await db.update(topicTable)
          .set({ updatedAt: new Date() })
          .where(eq(topicTable.id, analysis.relevantTopicId))
      }
      // Step 4: If DM or bot mentioned and could form new topic
      else if ((isDirectMessage || isBotMentioned) && analysis.suggestedNewTopic) {
        // Check if it's a scheduling workflow
        if (analysis.workflowType === 'scheduling') {
          // Create new topic
          const [newTopic] = await db.insert(topicTable).values({
            userIds: [message.user],
            summary: analysis.suggestedNewTopic,
            workflowType: analysis.workflowType,
          }).returning()

          // Save message related to new topic
          await db.insert(slackMessageTable).values({
            topicId: newTopic.id,
            channelId: message.channel,
            userId: message.user,
            text: message.text,
            timestamp: new Date(parseFloat(message.ts) * 1000),
            raw: message,
          })

          // Reply in thread to the original message
          await client.chat.postMessage({
            channel: message.channel,
            thread_ts: message.ts,
            text: `Created new topic: ${analysis.suggestedNewTopic}`,
          })
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
    }
  }
})

await app.start(3000)
app.logger.info('Slack bot is running on port 3000')

export {}
