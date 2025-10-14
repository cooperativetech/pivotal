import { and, asc, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import type { calendar_v3 } from 'googleapis'

import db from './db/engine'
import { meetingArtifactTable, topicTable } from './db/schema/main'
import type { MeetingArtifact } from './db/schema/main'
import type { TopicWithState } from '@shared/api-types'
import { getTopicWithState } from './utils'

export interface MeetingArtifactUpsertParams {
  topicId: string
  calendarId: string
  event: calendar_v3.Schema$Event
  startTime: Date
  endTime: Date
  summary?: string | null
  originChannelId?: string | null
  originThreadTs?: string | null
}

function extractMeetingCode(event: calendar_v3.Schema$Event): string | null {
  const entryPoints = event.conferenceData?.entryPoints
  if (!entryPoints || entryPoints.length === 0) {
    if (event.hangoutLink) {
      const codeMatch = event.hangoutLink.match(/meet\.google\.com\/(.*)$/)
      if (codeMatch && codeMatch[1]) {
        return codeMatch[1]
      }
    }
    return null
  }

  for (const entry of entryPoints) {
    if (entry.meetingCode) {
      return entry.meetingCode
    }
    if (entry.uri) {
      const codeMatch = entry.uri.match(/meet\.google\.com\/(.*)$/)
      if (codeMatch && codeMatch[1]) {
        return codeMatch[1]
      }
    }
  }
  return null
}

function extractMeetingUri(event: calendar_v3.Schema$Event): string | null {
  if (event.hangoutLink) return event.hangoutLink
  const entryPoints = event.conferenceData?.entryPoints
  if (!entryPoints || entryPoints.length === 0) return null
  const videoEntry = entryPoints.find((entry) => entry.entryPointType === 'video')
  return videoEntry?.uri || entryPoints[0]?.uri || null
}

export async function upsertMeetingArtifact({
  topicId,
  calendarId,
  event,
  startTime,
  endTime,
  summary,
  originChannelId,
  originThreadTs,
}: MeetingArtifactUpsertParams): Promise<void> {
  const eventId = event.id
  if (!eventId) {
    console.warn('[MeetingArtifact] Skipping upsert due to missing event id')
    return
  }

  const meetingCode = extractMeetingCode(event)
  const meetingUri = extractMeetingUri(event)
  const resolvedSummary = summary ?? event.summary ?? null

  const insertValues = {
    topicId,
    calendarEventId: eventId,
    calendarId,
    meetingCode,
    meetingUri,
    summary: resolvedSummary,
    startTime,
    endTime,
    originChannelId,
    originThreadTs,
  }

  const updateValues: Record<string, unknown> = {
    calendarId,
    meetingCode,
    meetingUri,
    summary: resolvedSummary,
    startTime,
    endTime,
    updatedAt: new Date(),
  }

  if (originChannelId) updateValues.originChannelId = originChannelId
  if (originThreadTs) updateValues.originThreadTs = originThreadTs

  await db
    .insert(meetingArtifactTable)
    .values(insertValues)
    .onConflictDoUpdate({
      target: meetingArtifactTable.calendarEventId,
      set: updateValues,
    })
}

export async function deleteMeetingArtifactByEvent(calendarId: string, eventId: string): Promise<void> {
  await db
    .delete(meetingArtifactTable)
    .where(and(
      eq(meetingArtifactTable.calendarId, calendarId),
      eq(meetingArtifactTable.calendarEventId, eventId),
    ))
}

export type PendingMeetingArtifact = MeetingArtifact & {
  slackTeamId: string
}

export async function getPendingMeetingSummaries(): Promise<PendingMeetingArtifact[]> {
  const now = new Date()
  const withinTranscriptCheckWindow = or(
    isNull(meetingArtifactTable.transcriptLastCheckedAt),
    sql`${meetingArtifactTable.transcriptLastCheckedAt} <= ${meetingArtifactTable.endTime} + interval '1 day'`,
  )
  const rows = await db
    .select({
      artifact: meetingArtifactTable,
      slackTeamId: topicTable.slackTeamId,
    })
    .from(meetingArtifactTable)
    .innerJoin(topicTable, eq(meetingArtifactTable.topicId, topicTable.id))
    .where(and(
      isNull(meetingArtifactTable.summaryPostedAt),
      lt(meetingArtifactTable.startTime, now),
      withinTranscriptCheckWindow,
    ))
    .orderBy(asc(meetingArtifactTable.endTime))

  return rows.map(({ artifact, slackTeamId }) => ({
    ...artifact,
    slackTeamId,
  }))
}

export interface MeetingSummaryProcessingUpdate {
  transcriptDocumentId?: string | null
  transcriptUri?: string | null
  transcriptFetchedAt?: Date | null
  transcriptLastCheckedAt?: Date | null
  transcriptAttemptCount?: number
  geminiSummary?: string | null
  geminiModel?: string | null
  actionItemsProcessedAt?: Date | null
  actionItemsCommitSha?: string | null
  actionItemsError?: string | null
}

export async function updateMeetingSummaryProcessing(
  id: string,
  updates: MeetingSummaryProcessingUpdate,
): Promise<void> {
  const setValues: Record<string, unknown> = {}

  if ('transcriptDocumentId' in updates) setValues.transcriptDocumentId = updates.transcriptDocumentId
  if ('transcriptUri' in updates) setValues.transcriptUri = updates.transcriptUri
  if ('transcriptFetchedAt' in updates) setValues.transcriptFetchedAt = updates.transcriptFetchedAt
  if ('transcriptLastCheckedAt' in updates) setValues.transcriptLastCheckedAt = updates.transcriptLastCheckedAt
  if ('transcriptAttemptCount' in updates && typeof updates.transcriptAttemptCount === 'number') {
    setValues.transcriptAttemptCount = updates.transcriptAttemptCount
  }
  if ('geminiSummary' in updates) setValues.geminiSummary = updates.geminiSummary
  if ('geminiModel' in updates) setValues.geminiModel = updates.geminiModel
  if ('actionItemsProcessedAt' in updates) setValues.actionItemsProcessedAt = updates.actionItemsProcessedAt
  if ('actionItemsCommitSha' in updates) setValues.actionItemsCommitSha = updates.actionItemsCommitSha
  if ('actionItemsError' in updates) setValues.actionItemsError = updates.actionItemsError

  if (Object.keys(setValues).length === 0) {
    return
  }

  setValues.updatedAt = new Date()

  await db
    .update(meetingArtifactTable)
    .set(setValues)
    .where(eq(meetingArtifactTable.id, id))
}

export async function markMeetingSummaryPosted(
  id: string,
  channelId: string,
  slackTs: string,
  postedAt: Date = new Date(),
): Promise<void> {
  await db
    .update(meetingArtifactTable)
    .set({
      summaryPostedAt: postedAt,
      summarySlackChannelId: channelId,
      summarySlackTs: slackTs,
      updatedAt: new Date(),
    })
    .where(eq(meetingArtifactTable.id, id))
}

export interface MeetingLookupOptions {
  userIds: string[],
  direction?: 'upcoming' | 'past',
  summaryContains?: string | null,
  limit?: number,
}

export interface MeetingLookupResult {
  artifact: MeetingArtifact,
  topic: TopicWithState,
}

export async function findMeetingsForUsers({
  userIds,
  direction = 'upcoming',
  summaryContains,
  limit = 3,
}: MeetingLookupOptions): Promise<MeetingLookupResult[]> {
  if (userIds.length === 0) return []

  const now = new Date()
  const fetchLimit = Math.max(limit * 5, 10)

  const baseQuery = db.select().from(meetingArtifactTable)
  const artifacts = await (direction === 'past'
    ? baseQuery.where(lt(meetingArtifactTable.startTime, now)).orderBy(desc(meetingArtifactTable.startTime))
    : baseQuery.where(gt(meetingArtifactTable.startTime, now)).orderBy(asc(meetingArtifactTable.startTime)))
    .limit(fetchLimit)
  const summaryNeedle = summaryContains?.toLowerCase() ?? null
  const results: MeetingLookupResult[] = []

  for (const artifact of artifacts) {
    if (results.length >= limit) break

    let topic: TopicWithState
    try {
      topic = await getTopicWithState(artifact.topicId)
    } catch (error) {
      console.warn('[MeetingArtifact] Failed to load topic state for', artifact.topicId, error)
      continue
    }

    const matchesUser = topic.state.userIds.some((id) => userIds.includes(id))
    if (!matchesUser) continue

    if (summaryNeedle) {
      const combined = `${artifact.summary ?? ''} ${topic.state.summary ?? ''}`.toLowerCase()
      if (!combined.includes(summaryNeedle)) continue
    }

    results.push({ artifact, topic })
  }

  return results
}
