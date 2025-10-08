import { CronJob } from 'cron'
import { google } from 'googleapis'
import type { calendar_v3, docs_v1, drive_v3 } from 'googleapis'

import type { MeetingArtifact } from './db/schema/main'
import {
  getPendingMeetingSummaries,
  markMeetingSummaryPosted,
  updateMeetingSummaryProcessing,
  type PendingMeetingArtifact,
} from './meeting-artifacts'
import { processActionItemsForArtifact, buildActionItemsMessage } from './action-items-processor'
import { getSlackClientForTeam } from './integrations/slack'

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
]

const DOC_SCOPES = [
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/drive',
]

const DEFAULT_FETCH_LIMIT = 5
const POST_TEXT_CHAR_LIMIT = 3500
const MINUTES_AFTER_END_BEFORE_PROCESSING = 3

function buildServiceAccountJwt(scopes: string[]) {
  const clientEmail = process.env.PV_GOOGLE_SERVICE_ACCOUNT_EMAIL
  const privateKey = process.env.PV_GOOGLE_SERVICE_ACCOUNT_KEY
  const subject = process.env.PV_GOOGLE_SERVICE_ACCOUNT_SUBJECT

  if (!clientEmail || !privateKey || !subject) {
    console.warn('[MeetingSummaryWorker] Missing Google service account credentials.')
    return null
  }

  const normalizedKey = privateKey.includes('\\n')
    ? privateKey.replace(/\\n/g, '\n')
    : privateKey

  return new google.auth.JWT({
    email: clientEmail,
    key: normalizedKey,
    subject,
    scopes,
  })
}

let cachedCalendarClient: calendar_v3.Calendar | null = null
function getCalendarClient(): calendar_v3.Calendar | null {
  if (cachedCalendarClient) return cachedCalendarClient
  const auth = buildServiceAccountJwt(CALENDAR_SCOPES)
  if (!auth) return null
  cachedCalendarClient = google.calendar({ version: 'v3', auth })
  return cachedCalendarClient
}

let cachedDocsClient: docs_v1.Docs | null = null
function getDocsClient(): docs_v1.Docs | null {
  if (cachedDocsClient) return cachedDocsClient
  const auth = buildServiceAccountJwt(DOC_SCOPES)
  if (!auth) return null
  cachedDocsClient = google.docs({ version: 'v1', auth })
  return cachedDocsClient
}

let cachedDriveClient: drive_v3.Drive | null = null
function getDriveClient(): drive_v3.Drive | null {
  if (cachedDriveClient) return cachedDriveClient
  const auth = buildServiceAccountJwt(DOC_SCOPES)
  if (!auth) return null
  cachedDriveClient = google.drive({ version: 'v3', auth })
  return cachedDriveClient
}

function extractDocIdFromAttachment(attachment: calendar_v3.Schema$EventAttachment | undefined): { docId: string | null, link: string | null } {
  if (!attachment) return { docId: null, link: null }
  if (attachment.fileId) {
    return { docId: attachment.fileId, link: attachment.fileUrl || null }
  }
  if (attachment.fileUrl) {
    const url = attachment.fileUrl
    const match = url.match(/\/document\/d\/(.+?)\//)
    if (match && match[1]) {
      return { docId: match[1], link: url }
    }
  }
  return { docId: null, link: attachment.fileUrl || null }
}

function chooseSummaryAttachment(event: calendar_v3.Schema$Event): calendar_v3.Schema$EventAttachment | undefined {
  const attachments = event.attachments || []
  const docAttachments = attachments.filter((attachment) => (
    (attachment.mimeType?.includes('application/vnd.google-apps.document') ?? false)
  ))

  const summaryAttachment = docAttachments.find((attachment) => {
    const title = attachment.title?.toLowerCase() ?? ''
    return title.includes('summary') || title.includes('notes')
  })

  if (summaryAttachment) return summaryAttachment

  const transcriptAttachment = docAttachments.find((attachment) => {
    const title = attachment.title?.toLowerCase() ?? ''
    return title.includes('transcript')
  })

  return transcriptAttachment
}

function paragraphElementsToString(elements: docs_v1.Schema$ParagraphElement[] | undefined): string {
  if (!elements) return ''
  let text = ''
  for (const element of elements) {
    const run = element.textRun
    if (run?.content) {
      text += run.content
    }
  }
  return text
}

function structuralElementsToLines(elements: docs_v1.Schema$StructuralElement[] | undefined): string[] {
  const lines: string[] = []
  if (!elements) return lines

  for (const element of elements) {
    if (element.paragraph) {
      const paragraph = element.paragraph
      const rawText = paragraphElementsToString(paragraph.elements)
      const normalized = rawText.replace(/\n/g, '').trimEnd()
      if (!normalized) {
        lines.push('')
        continue
      }

      if (paragraph.bullet) {
        lines.push(`• ${normalized.trim()}`)
      } else {
        lines.push(normalized)
      }
    } else if (element.table) {
      for (const row of element.table.tableRows ?? []) {
        const cells = row.tableCells ?? []
        const cellTexts = cells.map((cell) => structuralElementsToLines(cell.content))
        const flattened = cellTexts.map((cellLines) => cellLines.join(' ').trim())
        lines.push(flattened.join(' | '))
      }
      lines.push('')
    }
  }

  return lines
}

function documentToPlainText(doc: docs_v1.Schema$Document | undefined): string {
  if (!doc) return ''
  const lines = structuralElementsToLines(doc.body?.content)

  const compressed: string[] = []
  let lastBlank = false
  for (const line of lines) {
    if (!line.trim()) {
      if (!lastBlank) {
        compressed.push('')
        lastBlank = true
      }
      continue
    }
    compressed.push(line)
    lastBlank = false
  }

  return compressed.join('\n').trim()
}

function escapeSlackText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function truncateForSlack(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1).trimEnd()}…`
}

async function fetchSummaryForArtifact(artifact: MeetingArtifact): Promise<{ text: string | null, link: string | null, docId: string | null }> {
  const calendar = getCalendarClient()
  if (!calendar) {
    console.warn('[MeetingSummaryWorker] Calendar client unavailable.')
    return { text: null, link: null, docId: null }
  }

  try {
    const eventRes = await calendar.events.get({
      calendarId: artifact.calendarId,
      eventId: artifact.calendarEventId,
    })

    const event = eventRes.data
    const attachment = chooseSummaryAttachment(event)
    const { docId, link } = extractDocIdFromAttachment(attachment)

    if (!docId) {
      console.warn(`[MeetingSummaryWorker] No Gemini summary attachment found for event ${artifact.calendarEventId}.`)
      return { text: null, link, docId: null }
    }

    const docsClient = getDocsClient()
    if (!docsClient) {
      console.warn('[MeetingSummaryWorker] Docs client unavailable.')
      return { text: null, link, docId }
    }

    const docRes = await docsClient.documents.get({ documentId: docId })
    const summaryText = documentToPlainText(docRes.data)

    return {
      text: summaryText || null,
      link: link || (attachment?.fileUrl ?? null),
      docId,
    }
  } catch (error) {
    console.error(`[MeetingSummaryWorker] Failed to fetch summary for event ${artifact.calendarEventId}:`, error)
    return { text: null, link: null, docId: null }
  }
}

function buildSummaryMessage(summary: string | null, link: string | null, artifact: MeetingArtifact): string {
  const header = `*Gemini summary: ${artifact.summary || 'Meeting'}*`
  const cleanSummary = summary ? escapeSlackText(summary).trim() : ''
  const truncated = cleanSummary ? truncateForSlack(cleanSummary, POST_TEXT_CHAR_LIMIT) : ''
  const linkText = link ? `Full summary & transcript: ${link}` : ''

  if (!truncated) {
    return linkText || `${header}\n(No summary text available)`
  }

  if (link && truncated.includes(link)) {
    return `${header}\n\n${truncated}`
  }

  const sections = [header, truncated]
  if (linkText) sections.push(linkText)
  return sections.join('\n\n')
}

async function processArtifact(artifact: PendingMeetingArtifact): Promise<void> {
  const cutoff = Date.now() - MINUTES_AFTER_END_BEFORE_PROCESSING * 60 * 1000
  if (artifact.endTime.getTime() > cutoff) {
    return
  }

  if (!artifact.originChannelId) {
    await updateMeetingSummaryProcessing(artifact.id, {
      transcriptLastCheckedAt: new Date(),
      transcriptAttemptCount: artifact.transcriptAttemptCount + 1,
    })
    console.warn(`[MeetingSummaryWorker] Missing origin channel for meeting artifact ${artifact.id}, skipping.`)
    return
  }

  const { text, link, docId } = await fetchSummaryForArtifact(artifact)
  const now = new Date()

  if (!text && !link) {
    await updateMeetingSummaryProcessing(artifact.id, {
      transcriptLastCheckedAt: now,
      transcriptAttemptCount: artifact.transcriptAttemptCount + 1,
    })
    return
  }

  await updateMeetingSummaryProcessing(artifact.id, {
    transcriptDocumentId: docId,
    transcriptUri: link,
    transcriptFetchedAt: text ? now : artifact.transcriptFetchedAt ?? now,
    transcriptLastCheckedAt: now,
    transcriptAttemptCount: artifact.transcriptAttemptCount + 1,
    geminiSummary: text,
  })

  if (docId) {
    const driveClient = getDriveClient()
    if (driveClient) {
      try {
        await driveClient.permissions.create({
          fileId: docId,
          requestBody: {
            type: 'anyone',
            role: 'reader',
            allowFileDiscovery: false,
          },
          fields: 'id',
          supportsAllDrives: true,
          sendNotificationEmail: false,
        })
        console.log(`[MeetingSummaryWorker] Set sharing to anyone-with-link for doc ${docId}`)
      } catch (error) {
        console.warn(`[MeetingSummaryWorker] Failed to update sharing for doc ${docId}:`, error)
      }
    }
  }

  // Process action items if transcript text is available
  let actionItemsResult = null
  if (text && !artifact.actionItemsProcessedAt) {
    try {
      actionItemsResult = await processActionItemsForArtifact(artifact, text)
    } catch (error) {
      console.error(`[MeetingSummaryWorker] Action items processing failed for artifact ${artifact.id}:`, error)
    }
  }

  const message = buildSummaryMessage(text, link, artifact)

  const slackClient = await getSlackClientForTeam(artifact.slackTeamId)

  if (!slackClient) {
    console.warn(`[MeetingSummaryWorker] No Slack client available for team ${artifact.slackTeamId}, skipping post for artifact ${artifact.id}.`)
    return
  }

  try {
    const res = await slackClient.chat.postMessage({
      channel: artifact.originChannelId,
      text: message,
      thread_ts: artifact.originThreadTs || undefined,
      unfurl_links: false,
      unfurl_media: false,
    })

    if (!res.ok || !res.ts) {
      console.error(`[MeetingSummaryWorker] Failed to post summary for artifact ${artifact.id}:`, res)
      return
    }

    // Post action items as separate message in same thread
    if (actionItemsResult) {
      const actionItemsMessage = buildActionItemsMessage(actionItemsResult)
      try {
        await slackClient.chat.postMessage({
          channel: artifact.originChannelId,
          text: actionItemsMessage,
          thread_ts: artifact.originThreadTs || res.ts,
          unfurl_links: false,
          unfurl_media: false,
        })
      } catch (error) {
        console.error(`[MeetingSummaryWorker] Failed to post action items for artifact ${artifact.id}:`, error)
      }
    }

    await markMeetingSummaryPosted(artifact.id, artifact.originChannelId, res.ts)
  } catch (error) {
    console.error(`[MeetingSummaryWorker] Slack post failed for artifact ${artifact.id}:`, error)
  }
}

let isProcessing = false

async function checkMeetingSummaries(): Promise<void> {
  if (isProcessing) return
  isProcessing = true
  try {
    const pending = await getPendingMeetingSummaries(DEFAULT_FETCH_LIMIT)
    if (!pending.length) return

    for (const artifact of pending) {
      await processArtifact(artifact)
    }
  } catch (error) {
    console.error('[MeetingSummaryWorker] Error while checking meeting summaries:', error)
  } finally {
    isProcessing = false
  }
}

export async function runMeetingSummaryWorkerOnce(): Promise<void> {
  await checkMeetingSummaries()
}

export function startMeetingSummaryCron(): void {
  const job = new CronJob('*/5 * * * *', () => {
    void checkMeetingSummaries()
  })
  job.start()
}
