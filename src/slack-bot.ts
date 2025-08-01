const { App } = await import('@slack/bolt')

const app = new App({
  token: process.env.PV_SLACK_BOT_TOKEN,
  appToken: process.env.PV_SLACK_APP_TOKEN,
  socketMode: true,
})

app.message(async ({ message, say, context }) => {
  if ('text' in message && message.text) {
    console.log(message)
    const isDirectMessage = message.channel_type === 'im'
    const isBotMentioned = message.text.includes(`<@${context.botUserId}>`)
    if (isDirectMessage || isBotMentioned) {
      await say(`I've been called on! You said ${message.text}`)
    } else {
      await say(`I'm listening. You said ${message.text}`)
    }
  }
})

await app.start(3000)
app.logger.info('Slack bot is running on port 3000')

export {}
