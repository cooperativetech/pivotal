/**
 * Langfuse TracingExporter implementation for @openai/agents
 * Converts OpenAI agent traces and spans to Langfuse observability format
 */

import { Langfuse } from 'langfuse'
import type {
  LangfuseTraceClient,
  LangfuseSpanClient,
  LangfuseGenerationClient,
} from 'langfuse'

import {
  TracingExporter,
  Trace,
  Span,
} from '@openai/agents'
import type {
  SpanData,
  GenerationSpanData,
} from '@openai/agents-core/tracing/spans'

const PLACEHOLDER_NAME = 'trace'

/**
 * TracingExporter implementation that sends OpenAI agent traces to Langfuse
 */
export class LangfuseTracingExporter implements TracingExporter {
  private langfuse: Langfuse
  private enableDebugLogging: boolean

  // Maps to track relationships between OpenAI and Langfuse objects
  private traceMap: Map<string, LangfuseTraceClient> = new Map()
  private traceNameMap: Map<string, string> = new Map()
  private spanMap: Map<string, LangfuseSpanClient | LangfuseGenerationClient> = new Map()

  constructor(langfuse: Langfuse, enableDebugLogging: boolean = false) {
    this.langfuse = langfuse
    this.enableDebugLogging = enableDebugLogging
  }

  /**
   * Export traces and spans to Langfuse
   */
  async export(items: (Trace | Span<SpanData>)[], signal?: AbortSignal): Promise<void> {
    try {
      // Process items in order to maintain relationships
      for (const item of items) {
        if (signal?.aborted) {
          throw new Error('Export aborted')
        }

        if (item.type === 'trace') {
          this.exportTrace(item)
        } else if (item.type === 'trace.span') {
          this.exportSpan(item)
        }
      }

      // Flush to ensure all data is sent
      await this.langfuse.flushAsync()

      if (this.enableDebugLogging) {
        console.log(`[Langfuse] Exported ${items.length} items`)
      }
    } catch (error) {
      console.error('[Langfuse] Export error:', error)
      throw error
    }
  }

  /**
   * Export a trace to Langfuse
   */
  private exportTrace(trace: Trace) {
    // Create Langfuse trace
    const langfuseTrace = this.langfuse.trace({
      id: trace.traceId,
      name: PLACEHOLDER_NAME,
      sessionId: trace.groupId,
      metadata: trace.metadata,
    })

    // Store mapping
    this.traceMap.set(trace.traceId, langfuseTrace)
    this.traceNameMap.set(trace.traceId, PLACEHOLDER_NAME)

    if (this.enableDebugLogging) {
      console.log(`[Langfuse] Created trace: ${trace.traceId}`)
    }
  }

  /**
   * Export a span to Langfuse
   */
  private exportSpan(span: Span<SpanData>) {
    // Get parent trace or span
    const parentTrace = this.traceMap.get(span.traceId)
    const parentSpan = span.parentId ? this.spanMap.get(span.parentId) : undefined

    // Create a default trace if none exists
    if (!parentTrace && !parentSpan) {
      const defaultTraceName = 'auto-created-trace'
      const defaultTrace = this.langfuse.trace({
        id: span.traceId,
        name: defaultTraceName,
      })
      this.traceMap.set(span.traceId, defaultTrace)
      this.traceNameMap.set(span.traceId, defaultTraceName)
    }

    // Update placeholder trace name with name of first agent span
    if (
      parentTrace &&
      this.traceNameMap.get(span.traceId) === PLACEHOLDER_NAME &&
      span.spanData.type === 'agent'
    ) {
      const newName = `trace-${span.spanData.name}`
      parentTrace.update({ name: newName })
      this.traceNameMap.set(span.traceId, newName)
    }

    // Determine if this should be a generation or regular span
    if (span.spanData.type === 'generation') {
      this.createLangfuseGeneration(span as Span<GenerationSpanData>)
    } else {
      this.createLangfuseSpan(span)
    }
  }

  /**
   * Create a Langfuse generation for LLM spans
   */
  private createLangfuseGeneration(span: Span<GenerationSpanData>) {
    const parent = this.traceMap.get(span.traceId)
    if (!parent) throw new Error(`No trace found for span.traceId: ${span.traceId}`)
    const data = span.spanData

    // Try to get usage from data.output[0].usage
    const usage = (
      (Array.isArray(data.output) && data.output[0]?.usage) ?
      data.output[0].usage as {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
      } : null
    )

    // Create dataWithoutIO for metadata
    const dataWithoutIO = { ...data }
    delete dataWithoutIO.input
    delete dataWithoutIO.output

    const generation = parent.generation({
      id: span.spanId,
      name: data.type,
      startTime: span.startedAt ? new Date(span.startedAt) : null,
      endTime: span.endedAt ? new Date(span.endedAt) : null,
      model: data.model,
      modelParameters: data.model_config,
      input: data.input,
      output: data.output,
      usage: usage ? {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      } : undefined,
      metadata: {
        rawData: dataWithoutIO,
        error: span.error,
      },
      level: span.error ? 'ERROR' : 'DEFAULT',
      statusMessage: span.error?.message,
    })

    this.spanMap.set(span.spanId, generation)

    if (this.enableDebugLogging) {
      console.log(`[Langfuse] Created generation: ${span.spanId}`)
    }
  }

  /**
   * Create a Langfuse span for non-LLM spans
   */
  private createLangfuseSpan(span: Span<SpanData>) {
    const parent = this.traceMap.get(span.traceId)
    if (!parent) throw new Error(`No trace found for span.traceId: ${span.traceId}`)
    const data = span.spanData

    // Create dataWithoutIO for metadata
    const dataWithoutIO = { ...data }
    if ('input' in dataWithoutIO) delete dataWithoutIO.input
    if ('output' in dataWithoutIO) delete dataWithoutIO.output

    const langfuseSpan = parent.span({
      id: span.spanId,
      name: `${data.type}${'name' in data ? '-' + data.name : ''}`,
      startTime: span.startedAt ? new Date(span.startedAt) : null,
      endTime: span.endedAt ? new Date(span.endedAt) : null,
      input: 'input' in data ? data.input : null,
      output: 'output' in data ? data.output : null,
      metadata: {
        rawData: dataWithoutIO,
        error: span.error,
      },
      level: span.error ? 'ERROR' : 'DEFAULT',
      statusMessage: span.error?.message,
    })

    this.spanMap.set(span.spanId, langfuseSpan)

    if (this.enableDebugLogging) {
      console.log(`[Langfuse] Created span: ${span.spanId} (${data.type})`)
    }
  }
}
