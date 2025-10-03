import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from 'playwright'

function buildBrowserlessWsEndpoint(): string | null {
  const envCandidates = [
    process.env.PV_BROWSERLESS_WS_ENDPOINT,
    process.env.PV_BROWSERLESS_PLAYWRIGHT_WS,
    process.env.BROWSERLESS_WS_ENDPOINT,
    process.env.BROWSERLESS_PLAYWRIGHT_WS,
    process.env.PLAYWRIGHT_WS_ENDPOINT,
  ]

  const baseEndpoint = envCandidates.find((value) => typeof value === 'string' && value.length > 0)
  if (!baseEndpoint) return null

  const token = process.env.PV_BROWSERLESS_API_TOKEN || process.env.BROWSERLESS_API_TOKEN || process.env.BROWSERLESS_TOKEN

  try {
    const endpointUrl = new URL(baseEndpoint)
    if (token && !endpointUrl.searchParams.get('token')) {
      endpointUrl.searchParams.set('token', token)
    }
    return endpointUrl.toString()
  } catch (error) {
    console.warn('[MeetAutomation] Invalid Browserless endpoint URL provided:', error)
    return null
  }
}

async function createBrowserContext(): Promise<{ browser?: Browser, context: BrowserContext, page: Page }> {
  const envForceValue = (process.env.PV_BROWSERLESS_FORCE_LOCAL ?? process.env.PLAYWRIGHT_FORCE_LOCAL ?? '').toLowerCase()
  let shouldForceLocal = ['true', '1', 'yes'].includes(envForceValue)

  if (!shouldForceLocal && process.env.PV_BROWSERLESS_FORCE_LOCAL === undefined && process.env.PLAYWRIGHT_FORCE_LOCAL === undefined) {
    // Default to local launch unless explicitly opted into Browserless
    shouldForceLocal = true
  }

  const browserlessEndpoint = shouldForceLocal ? null : buildBrowserlessWsEndpoint()
  if (browserlessEndpoint) {
    console.log('[MeetAutomation] Connecting to Browserless endpoint')
    const browser = await chromium.connect(browserlessEndpoint, { timeout: 60000 })
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    return { browser, context, page }
  }

  if (shouldForceLocal) {
    console.log('[MeetAutomation] Forcing local Chromium launch (PV_BROWSERLESS_FORCE_LOCAL set)')
  } else {
    console.log('[MeetAutomation] Launching local Chromium context')
  }

  const headlessSetting = process.env.PV_PLAYWRIGHT_HEADLESS ?? process.env.PLAYWRIGHT_HEADLESS
  const headless = (headlessSetting ?? 'true').toLowerCase() !== 'false'

  const context = await chromium.launchPersistentContext('/tmp/playwright-chrome-data', {
    headless,
    timeout: 60000,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const pages = context.pages()
  const page = pages.length > 0 ? pages[0] : await context.newPage()
  return { context, page }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function escapeRegex(text: string): string {
  return text.replace(/[-/\\^$*+?.()|[\]{}]/g, (match) => `\\${match}`)
}

async function findFirstVisible(locators: Array<Locator | null>, timeout = 5000, pollInterval = 200): Promise<Locator | null> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const locator of locators) {
      if (!locator) continue
      try {
        if (await locator.isVisible()) {
          return locator
        }
      } catch {
        // ignore and continue polling
      }
    }
    await delay(pollInterval)
  }
  return null
}

async function waitForVisible(locator: Locator, timeout = 10000): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

async function isToggleEnabled(locator: Locator): Promise<boolean> {
  const ariaChecked = await locator.getAttribute('aria-checked')
  if (ariaChecked !== null) {
    return ariaChecked === 'true'
  }

  try {
    const result = await locator.evaluate<boolean>((element) => {
      const node = element as HTMLInputElement
      if (typeof node.checked === 'boolean') {
        return node.checked
      }

      const ariaPressed = element.getAttribute('aria-pressed')
      return ariaPressed === 'true'
    })
    return result
  } catch {
    return false
  }
}

async function ensureToggleEnabled(locator: Locator): Promise<boolean> {
  if (await isToggleEnabled(locator)) return true
  await locator.click({ timeout: 10000 })
  await delay(200)
  return isToggleEnabled(locator)
}

interface HostControlsScope {
  frame: Frame | null
  container: Locator
}

async function resolveHostControlsScope(page: Page, timeout = 10000): Promise<HostControlsScope | null> {
  // Try iframe-based host controls first
  const frameLocator = page.locator('iframe[title*="Video call options" i]').first()
  if (await waitForVisible(frameLocator, timeout)) {
    const handle = await frameLocator.elementHandle()
    if (handle) {
      try {
        const frame = await handle.contentFrame()
        if (frame) {
          return { frame, container: frame.locator('body') }
        }
      } catch {
        // fall back to container-based access
      }
    }
    return { frame: null, container: frameLocator }
  }

  const dialogLocator = await findFirstVisible([
    page.locator('[role="dialog"][aria-label*="Video call options" i]').first(),
    page.locator('[role="dialog"]:has-text("Host controls")').first(),
  ], timeout)

  if (dialogLocator) {
    return { frame: null, container: dialogLocator }
  }

  return null
}

async function tryAddCoHostsViaHostControls(
  page: Page,
  scope: HostControlsScope,
  emails: string[],
  errors: string[],
): Promise<{ handled: string[], remaining: string[] }> {
  const uniqueEmails = [...new Set(emails.map((email) => email.trim()).filter(Boolean))]
  const handled: string[] = []
  const pending = new Set(uniqueEmails)

  const scopeFrame = scope.frame
  const baseLocator = scopeFrame ? scopeFrame.locator('body') : scope.container
  const roleScope = scopeFrame ?? page

  // Step 1: First, we should be on "Host controls" tab by default
  // Enable "Host management" toggle
  console.log('[MeetAutomation] Looking for Host management toggle')
  const hostManagementToggle = await findFirstVisible([
    baseLocator.locator('input[type="checkbox"][aria-label*="Host management" i]').first(),
    baseLocator.locator('[role="switch"][aria-label*="Host management" i]').first(),
    baseLocator.locator('label:has-text("Host management") input[type="checkbox"]').first(),
    baseLocator.locator('label:has-text("Host management") [role="switch"]').first(),
  ], 5000)

  if (hostManagementToggle) {
    console.log('[MeetAutomation] Found Host management toggle, enabling it')
    try {
      const enabled = await ensureToggleEnabled(hostManagementToggle)
      if (!enabled) {
        errors.push('Failed to enable Host management in host controls')
      } else {
        console.log('[MeetAutomation] Host management enabled')
        await delay(200)
      }
    } catch (error) {
      const message = `Error toggling Host management: ${String(error)}`
      console.error('[MeetAutomation]', message)
      errors.push(message)
    }
  } else {
    console.log('[MeetAutomation] Host management toggle not found')
  }

  // Step 2: Click "Guests" in the sidebar
  console.log('[MeetAutomation] Looking for Guests sidebar button')
  const guestsNavButton = await findFirstVisible([
    roleScope.getByRole('tab', { name: /Guests/i }).first(),
    roleScope.getByRole('button', { name: /Guests/i }).first(),
    roleScope.getByRole('link', { name: /Guests/i }).first(),
    baseLocator.locator('button:has-text("Guests")').first(),
    baseLocator.locator('[role="tab"]:has-text("Guests")').first(),
    baseLocator.locator('[role="menuitem"]:has-text("Guests")').first(),
  ], 5000)

  if (guestsNavButton) {
    console.log('[MeetAutomation] Found Guests button, clicking it')
    try {
      await guestsNavButton.click({ timeout: 5000 })
      await delay(200)
      console.log('[MeetAutomation] Clicked Guests tab')
    } catch (error) {
      console.log('[MeetAutomation] Failed to switch to Guests tab:', error)
      errors.push('Failed to click Guests tab')
    }
  } else {
    console.log('[MeetAutomation] Guests navigation button not found')
    errors.push('Could not find Guests tab in sidebar')
    return { handled, remaining: [...pending] }
  }

  // Check if any emails are already added
  for (const email of uniqueEmails) {
    const existingChip = baseLocator.getByText(email, { exact: true }).first()
    if (await existingChip.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`[MeetAutomation] ${email} already listed in host controls`)
      handled.push(email)
      pending.delete(email)
    }
  }

  if (pending.size === 0) {
    return { handled, remaining: [] }
  }

  // Step 3: Find the Co-hosts section in the Guests tab
  console.log('[MeetAutomation] Looking for Co-hosts section')
  const coHostsSection = await findFirstVisible([
    baseLocator.locator('text="Co-hosts"').first(),
    baseLocator.locator('[role="group"]:has-text("Co-hosts")').first(),
    baseLocator.locator('section:has-text("Co-host")').first(),
    baseLocator.locator('[aria-label*="Co-host" i]').first(),
    baseLocator.locator('div:has-text("Co-hosts")').first(),
  ], 5000)

  if (!coHostsSection) {
    console.log('[MeetAutomation] Co-hosts section not found')
    await page.screenshot({ path: '/tmp/meet-debug-no-cohosts-section.png' })
    errors.push('Could not find Co-hosts section in Guests tab')
    return { handled, remaining: [...pending] }
  }

  console.log('[MeetAutomation] Found Co-hosts section')

  // Step 4: Look for "Add co-host" input field
  console.log('[MeetAutomation] Looking for Add co-host input')
  const addInputCandidates: Array<Locator | null> = [
    baseLocator.getByRole('combobox', { name: /co-host/i }).first(),
    baseLocator.getByRole('textbox', { name: /co-host/i }).first(),
    baseLocator.locator('input[aria-label*="co-host" i]').first(),
    baseLocator.locator('input[placeholder*="co-host" i]').first(),
    baseLocator.locator('[role="combobox"]').filter({ hasText: /co-host/i }).first(),
    baseLocator.locator('input[type="text"]').nth(0),
  ]

  const addInput = await findFirstVisible(addInputCandidates, 8000)
  if (!addInput) {
    console.log('[MeetAutomation] Add co-host input not found inside Guests pane')
    await page.screenshot({ path: '/tmp/meet-debug-no-input.png' })
    errors.push('Could not find Add co-host input field')
    return { handled, remaining: [...pending] }
  }

  console.log('[MeetAutomation] Found Add co-host input')

  // Step 5: Type each email into the co-host input
  for (const email of uniqueEmails) {
    try {
      const existingChip = baseLocator.getByText(email, { exact: true }).first()
      if (await existingChip.isVisible({ timeout: 1500 }).catch(() => false)) {
        console.log(`[MeetAutomation] ${email} already added as co-host`)
        handled.push(email)
        pending.delete(email)
        continue
      }

      console.log(`[MeetAutomation] Adding ${email} via Guests tab co-host input`)

      // Click the input to focus it
      await addInput.click({ timeout: 5000 })
      await delay(150)

      // Clear any existing text
      await addInput.fill('')
      await delay(100)

      // Type the email
      console.log(`[MeetAutomation] Typing email: ${email}`)
      await addInput.fill(email)
      await delay(200)

      // Look for dropdown suggestions
      console.log('[MeetAutomation] Looking for dropdown option')
      const suggestion = await findFirstVisible([
        page.getByRole('option', { name: new RegExp(escapeRegex(email), 'i') }).first(),
        page.locator(`[role="option"]:has-text("${email}")`).first(),
        page.locator(`[role="menuitem"]:has-text("${email}")`).first(),
        baseLocator.getByRole('option', { name: new RegExp(escapeRegex(email), 'i') }).first(),
        baseLocator.locator(`[role="option"]:has-text("${email}")`).first(),
      ], 4000)

      if (suggestion) {
        console.log(`[MeetAutomation] Found dropdown option for ${email}, clicking it`)
        await suggestion.click({ timeout: 5000 })
        await delay(200)
      } else {
        console.log('[MeetAutomation] No dropdown option found, pressing Enter')
        await addInput.press('Enter')
        await delay(200)
      }

      // Verify the email was added by looking for it in the list
      const chip = baseLocator.getByText(email, { exact: true }).first()
      if (await chip.isVisible({ timeout: 4000 }).catch(() => false)) {
        console.log(`[MeetAutomation] Confirmed ${email} listed as co-host`)
        handled.push(email)
        pending.delete(email)
      } else {
        console.log(`[MeetAutomation] ${email} not visible after entry, taking screenshot`)
        await page.screenshot({ path: `/tmp/meet-debug-after-add-${email.replace(/[^a-z0-9]/gi, '_')}.png` })
        errors.push(`Could not verify ${email} was added as co-host`)
      }
    } catch (error) {
      const message = `Failed to add ${email} via Guests tab: ${String(error)}`
      console.error(`[MeetAutomation] ${message}`)
      errors.push(message)
    }
  }

  // Step 6: Click Save button in the Host controls dialog
  console.log('[MeetAutomation] Looking for Save button in Host controls dialog')
  await page.screenshot({ path: '/tmp/meet-debug-before-save.png' })

  const saveButton = await findFirstVisible([
    roleScope.getByRole('button', { name: /^Save$/i }).first(),
    baseLocator.locator('button:has-text("Save")').first(),
    page.locator('button:has-text("Save")').first(),
  ], 5000)

  if (saveButton) {
    console.log('[MeetAutomation] Found Save button, clicking it')
    try {
      await saveButton.click({ timeout: 5000 })
      await delay(400)
      console.log('[MeetAutomation] Clicked Save button')
    } catch (error) {
      console.log('[MeetAutomation] Failed to click Save button in Meet options:', error)
      errors.push('Failed to click Save button in Host controls dialog')
    }
  } else {
    console.log('[MeetAutomation] No Save button found in Meet options overlay')
    await page.screenshot({ path: '/tmp/meet-debug-no-save-button.png' })
    errors.push('Could not find Save button in Host controls dialog')
  }

  return { handled, remaining: [...pending] }
}


/**
 * Add co-hosts to a Google Meet using headless browser automation
 * This is a workaround until we get access to the Google Workspace Developer Preview
 *
 * @param meetLink - The Google Meet link (e.g., https://meet.google.com/abc-defg-hij)
 * @param cohostEmails - Array of email addresses to add as co-hosts
 * @param organizerEmail - Email of the meeting organizer (service account)
 * @param organizerPassword - Password for the organizer account (if using user account instead of service account)
 * @param eventId - The Google Calendar event ID
 */
export async function addCoHostsViaAutomation(
  meetLink: string,
  cohostEmails: string[],
  organizerEmail: string,
  organizerPassword?: string,
  eventId?: string,
): Promise<{ success: boolean, errors: string[] }> {
  const errors: string[] = []
  const targetEmails = [...new Set(cohostEmails.map((email) => email.trim()).filter(Boolean))]

  if (targetEmails.length === 0) {
    return { success: true, errors: [] }
  }

  console.log('[MeetAutomation] Adding co-hosts via headless browser:', targetEmails)
  console.log('[MeetAutomation] Target meet link:', meetLink)

  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let page: Page | undefined
  try {
    console.log('[MeetAutomation] Preparing browser context')
    const created = await createBrowserContext()
    browser = created.browser
    context = created.context
    page = created.page
    console.log('[MeetAutomation] Browser context ready')

    if (!page) {
      throw new Error('Failed to initialize browser page')
    }

    // Check if we're already signed in by trying to go to Google
    console.log('[MeetAutomation] Checking sign-in status')
    await page.goto('https://accounts.google.com', { timeout: 120000 })
    await Promise.race([
      page.waitForSelector('input[type="email"]', { timeout: 15000 }).catch(() => null),
      page.waitForSelector('input[type="password"]', { timeout: 15000 }).catch(() => null),
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null),
    ])

    // If we see an email input, we need to sign in
    const emailInput = page.locator('input[type="email"]')
    if (await emailInput.isVisible({ timeout: 20000 }).catch(() => false)) {
      console.log('[MeetAutomation] Not signed in, signing in as:', organizerEmail)
      await emailInput.fill(organizerEmail)
      await page.click('button:has-text("Next")')

      if (organizerPassword) {
        console.log('[MeetAutomation] Waiting for password field')
        await page.waitForSelector('input[type="password"]', { timeout: 60000 })
        await page.fill('input[type="password"]', organizerPassword)
        await page.click('button:has-text("Next")')
        console.log('[MeetAutomation] Waiting for account redirect after password submit')
        await Promise.race([
          page.waitForURL((url) => !/ServiceLogin|signin|password/i.test(url.href), { timeout: 20000 }).catch(() => null),
          page.waitForSelector('input[type="password"]', { state: 'detached', timeout: 20000 }).catch(() => null),
          page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null),
          delay(3000),
        ])
      } else {
        errors.push('No password provided for organizer account')
        return { success: false, errors }
      }
    } else {
      console.log('[MeetAutomation] Already signed in, continuing')
    }

    // Navigate to Google Calendar event (if we have eventId, use that, otherwise extract from meetLink)
    let calendarUrl = 'https://calendar.google.com'
    if (eventId) {
      // The event ID needs to be base64 encoded with the calendar email
      // Format: base64(eventId + ' ' + calendarEmail)
      const eventString = `${eventId} ${organizerEmail}`
      const encodedEventId = Buffer.from(eventString).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      calendarUrl = `https://calendar.google.com/calendar/u/0/r/eventedit/${encodedEventId}`
      console.log('[MeetAutomation] Navigating to Google Calendar event:', calendarUrl)
    } else {
      console.log('[MeetAutomation] No event ID provided, navigating to calendar home')
    }
    try {
      await page.goto(calendarUrl, { waitUntil: 'domcontentloaded', timeout: 120000 })
    } catch (error) {
      console.warn('[MeetAutomation] Calendar navigation timed out waiting for domcontentloaded, retrying without wait condition', error)
      try {
        await page.goto(calendarUrl, { timeout: 120000 })
      } catch (fallbackError) {
        const message = `Failed to load calendar event page: ${String(fallbackError)}`
        errors.push(message)
        throw fallbackError
      }
    }

    // Take a screenshot for debugging
    await page.screenshot({ path: '/tmp/meet-debug-1-calendar.png' })
    console.log('[MeetAutomation] Screenshot saved to /tmp/meet-debug-1-calendar.png')

    // Wait for the calendar event page to load
    console.log('[MeetAutomation] Waiting for calendar event page to load')
    await Promise.race([
      page.waitForSelector('input[aria-label*="title" i], input[placeholder*="Add title" i]', { timeout: 15000 }).catch(() => null),
      page.waitForSelector('[data-eventid], [data-eventchip]', { timeout: 15000 }).catch(() => null),
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null),
    ])

    // Check if we're on the event edit page or need to navigate there
    // Look for event title or edit form
    const eventTitleInput = page.locator('input[aria-label*="title" i], input[placeholder*="Add title" i]').first()
    const isOnEditPage = await eventTitleInput.isVisible({ timeout: 5000 }).catch(() => false)

    if (!isOnEditPage) {
      console.log('[MeetAutomation] Not on edit page, trying to find and click the event')
      // We might be on the calendar view, need to find the event and click it
      // Try to find the event by searching for the Meet link or event title
      const eventElement = page.locator('[data-eventid], [data-eventchip]').first()
      if (await eventElement.isVisible({ timeout: 10000 }).catch(() => false)) {
        console.log('[MeetAutomation] Found event, clicking it')
        await eventElement.click()
        await page.waitForTimeout(1500)

        // Now click edit button
        const editButton = page.locator('button:has-text("Edit"), [aria-label*="Edit" i]').first()
        if (await editButton.isVisible({ timeout: 10000 }).catch(() => false)) {
          console.log('[MeetAutomation] Clicking Edit button')
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
            editButton.click(),
          ])
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null)
        }
      }
    }

    await page.screenshot({ path: '/tmp/meet-debug-1b-after-wait.png' })
    console.log('[MeetAutomation] Screenshot saved after wait')

    // Scroll down to see more of the page
    await page.evaluate(() => window.scrollBy(0, 300))
    await page.waitForTimeout(800)

    await page.screenshot({ path: '/tmp/meet-debug-1c-scrolled.png' })
    console.log('[MeetAutomation] Screenshot after scrolling')

    console.log('[MeetAutomation] Locating Google Meet call options button')
    const hostOptionsButton = page.locator('button[aria-label*="Video call options" i], button[aria-label*="Meeting options" i], button[aria-label*="Host controls" i]').first()
    let hostControlsOpened = false

    if (await hostOptionsButton.isVisible({ timeout: 15000 }).catch(() => false)) {
      console.log('[MeetAutomation] Clicking video call options button')
      await hostOptionsButton.click()
      hostControlsOpened = true
    } else {
      console.log('[MeetAutomation] Video call options button not found, falling back to Meet link click')
      const meetLinkLocator = page.locator('text="meet.google.com"').first()
      if (await meetLinkLocator.isVisible({ timeout: 10000 }).catch(() => false)) {
        await meetLinkLocator.scrollIntoViewIfNeeded()
        await page.waitForTimeout(400)
        await meetLinkLocator.click({ timeout: 10000 })
        hostControlsOpened = true
      } else {
        console.log('[MeetAutomation] Could not find Meet link on event page')
        await page.screenshot({ path: '/tmp/meet-debug-2-no-meet-link.png' })
        errors.push('Could not find Google Meet controls on calendar event')
        return { success: false, errors }
      }
    }

    if (hostControlsOpened) {
      await page.waitForTimeout(800)
      await page.screenshot({ path: '/tmp/meet-debug-2-after-click.png' })
      console.log('[MeetAutomation] Screenshot saved after opening Meet options trigger')
    }

    const hostScope = await resolveHostControlsScope(page)
    if (hostScope) {
      console.log('[MeetAutomation] Host controls detected, attempting dialog-based co-host assignment')
      await page.screenshot({ path: '/tmp/meet-debug-3-host-controls-opened.png' })

      const { handled, remaining } = await tryAddCoHostsViaHostControls(page, hostScope, targetEmails, errors)

      if (handled.length > 0) {
        console.log('[MeetAutomation] Successfully added co-hosts:', handled)
      }
      if (remaining.length > 0) {
        console.log('[MeetAutomation] Failed to add some co-hosts:', remaining)
        errors.push(`Failed to add co-hosts: ${remaining.join(', ')}`)
      }

      await page.screenshot({ path: '/tmp/meet-debug-4-after-adding-cohosts.png' })
    } else {
      console.log('[MeetAutomation] Host controls panel not visible after opening Meet options')
      await page.screenshot({ path: '/tmp/meet-debug-3-no-host-controls.png' })
      errors.push('Host controls dialog did not open')
    }

    return {
      success: errors.length === 0,
      errors,
    }
  } catch (error) {
    const errorMsg = `Automation error: ${String(error)}`
    console.error(`[MeetAutomation] ${errorMsg}`)
    errors.push(errorMsg)
    return { success: false, errors }
  } finally {
    if (context) {
      console.log('[MeetAutomation] Closing browser context...')
      await context.close()
      console.log('[MeetAutomation] Browser context closed')
    }
    if (browser) {
      console.log('[MeetAutomation] Closing browser connection...')
      await browser.close().catch(() => {})
    }
  }
}
