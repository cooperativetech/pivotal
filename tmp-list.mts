import { google } from 'googleapis'

async function main() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.PV_GOOGLE_CLIENT_ID,
    process.env.PV_GOOGLE_CLIENT_SECRET,
  )
  oauth2Client.setCredentials({ refresh_token: process.env.PV_GOOGLE_BOT_REFRESH_TOKEN })
  const drive = google.drive({ version: 'v3', auth: oauth2Client })
  const res = await drive.files.list({
    q: "mimeType = 'application/vnd.google-apps.document' and trashed = false and createdTime >= '2025-09-15T23:18:00Z' and createdTime <= '2025-09-16T05:18:00Z'",
    fields: 'files(id,name,createdTime,modifiedTime,webViewLink)',
    orderBy: 'createdTime desc',
    pageSize: 50,
  })
  for (const file of res.data.files ?? []) {
    console.log(file.id, file.name, file.createdTime, file.webViewLink)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
