import { and, asc, eq, gt, isNull, lt } from 'drizzle-orm'
import type { calendar_v3 } from 'googleapis'

import db from './db/engine'
import { meetingArtifactTable } from './db/schema/main'
import type { MeetingArtifact } from './db/schema/main'

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

export async function getPendingMeetingSummaries(limit: number = 10): Promise<MeetingArtifact[]> {
  const now = new Date()
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)
  const rows = await db
    .select()
    .from(meetingArtifactTable)
    .where(and(
      isNull(meetingArtifactTable.summaryPostedAt),
      lt(meetingArtifactTable.startTime, now),
      gt(meetingArtifactTable.endTime, oneHourAgo),
    ))
    .orderBy(asc(meetingArtifactTable.endTime))
    .limit(limit)

  return rows
}

export interface MeetingSummaryProcessingUpdate {
  transcriptDocumentId?: string | null
  transcriptUri?: string | null
  transcriptFetchedAt?: Date | null
  transcriptLastCheckedAt?: Date | null
  transcriptAttemptCount?: number
  geminiSummary?: string | null
  geminiModel?: string | null
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
