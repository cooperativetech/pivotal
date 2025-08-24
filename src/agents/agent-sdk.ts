import OpenAI from 'openai'
import {
  Agent,
  RunContext,
  run,
  tool,
  ModelBehaviorError,
  BatchTraceProcessor,
  setDefaultOpenAIClient,
  setOpenAIAPI,
  setTraceProcessors,
} from '@openai/agents'
import { Langfuse } from 'langfuse'

import { LangfuseTracingExporter } from './langfuse-tracing-exporter'

// Set up global agent configuration
const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.PV_OPENROUTER_API_KEY,
})

// Set up langfuse for tracing
const langfuse = new Langfuse({
  publicKey: process.env.PV_LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.PV_LANGFUSE_SECRET_KEY,
  baseUrl: 'https://us.cloud.langfuse.com',
})
const tracingExporter = new LangfuseTracingExporter(langfuse)
const traceProcessor = new BatchTraceProcessor(tracingExporter, { maxBatchSize: 1 })

setDefaultOpenAIClient(client)
setOpenAIAPI('chat_completions')
setTraceProcessors([traceProcessor])

// Re-export openai agent sdk types
export { Agent, RunContext, run, tool, ModelBehaviorError }
