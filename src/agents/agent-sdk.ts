import OpenAI from 'openai'
import {
  Agent,
  RunContext,
  run,
  tool,
  setDefaultOpenAIClient,
  setOpenAIAPI,
  setTracingDisabled,
  ModelBehaviorError,
} from '@openai/agents'
import { observeOpenAI } from 'langfuse'

// Set up global agent configuration
const client = observeOpenAI(
  new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.PV_OPENROUTER_API_KEY,
  }),
  {
    clientInitParams: {
      publicKey: process.env.PV_LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.PV_LANGFUSE_SECRET_KEY,
      baseUrl: 'https://us.cloud.langfuse.com',
    },
  },
)
setDefaultOpenAIClient(client)
setOpenAIAPI('chat_completions')
setTracingDisabled(true)


// Re-export openai agent sdk types
export { Agent, RunContext, run, tool, ModelBehaviorError }
