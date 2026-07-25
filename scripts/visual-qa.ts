import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'

import {
  chromium,
  type Browser,
  type Page,
  type ViewportSize,
} from '@playwright/test'

import { startManagedPreview } from './managed-preview'

type ReducedMotion = 'no-preference' | 'reduce'

const outputDir = process.env.OUTPUT_DIR ?? '/tmp/focus-gate-qa'
const chromePath =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const errors: string[] = []

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(900)
}

async function assertLayout(page: Page, label: string): Promise<void> {
  const result = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const documentOverflow =
      document.documentElement.scrollWidth - viewportWidth
    const overflow = [...document.body.querySelectorAll('*')]
      .filter((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return !(element instanceof SVGElement) &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          rect.width > 0 &&
          (rect.left < -1 || rect.right > viewportWidth + 1)
      })
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName,
        text: element.textContent?.trim().slice(0, 80),
        rect: element.getBoundingClientRect().toJSON(),
      }))
    const clipped = [...document.body.querySelectorAll('*')]
      .filter((element) => {
        const style = getComputedStyle(element)
        return !(element instanceof SVGElement) &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          ['hidden', 'clip'].includes(style.overflowX) &&
          element.scrollWidth - element.clientWidth > 1
      })
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName,
        text: element.textContent?.trim().slice(0, 80),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
    return { documentOverflow, overflow, clipped }
  })

  if (
    result.documentOverflow > 1 ||
    result.overflow.length > 0 ||
    result.clipped.length > 0
  ) {
    errors.push(
      `${label}: horizontal overflow ${JSON.stringify(result)}`,
    )
  }
}

async function capture(
  page: Page,
  label: string,
  fullPage = false,
): Promise<void> {
  await settle(page)
  await assertLayout(page, label)
  await page.screenshot({ path: `${outputDir}/${label}.png`, fullPage })
}

async function runFlow(
  browser: Browser,
  baseUrl: string,
  allowedHosts: ReadonlySet<string>,
  viewport: ViewportSize,
  prefix: string,
  reducedMotion: ReducedMotion,
): Promise<void> {
  const context = await browser.newContext({ viewport, reducedMotion })
  const page = await context.newPage()
  const externalRequests: string[] = []
  const consoleErrors: string[] = []

  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!allowedHosts.has(url.hostname)) {
      externalRequests.push(request.url())
    }
  })
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await capture(page, `${prefix}-01-prepare`, true)

    await page.getByRole('button', { name: '开始守门检查' }).click()
    await page
      .getByRole('button', { name: '我已开启 macOS 专注模式' })
      .click()
    await capture(page, `${prefix}-02-preflight`, true)
    await page.getByRole('button', { name: '进入专注之门' }).click()
    if (reducedMotion === 'no-preference') {
      await page.waitForTimeout(390)
      await assertLayout(page, `${prefix}-03-gate-closing`)
      await page.screenshot({
        path: `${outputDir}/${prefix}-03-gate-closing.png`,
      })
    }
    await capture(page, `${prefix}-03-guarding`)

    await page.getByRole('button', { name: '模拟合格敲门' }).click()
    await capture(page, `${prefix}-04-knock`, true)

    await page.getByRole('button', { name: '保存回复草稿' }).click()
    await page.getByRole('button', { name: '结束本次专注' }).click()
    await page.waitForTimeout(1300)
    await capture(page, `${prefix}-05-reentry`, true)

    await page.getByRole('button', { name: '打开交接单' }).click()
    await capture(page, `${prefix}-06-digest`, true)
  } finally {
    if (externalRequests.length) {
      errors.push(
        `${prefix}: external requests ${externalRequests.join(', ')}`,
      )
    }
    if (consoleErrors.length) {
      errors.push(
        `${prefix}: console errors ${consoleErrors.join(' | ')}`,
      )
    }
    await context.close()
  }
}

const target = await startManagedPreview({
  externalUrl: process.env.BASE_URL,
})

try {
  const baseUrl = target.baseUrl
  const allowedHosts = new Set([
    '127.0.0.1',
    'localhost',
    new URL(baseUrl).hostname,
  ])

  await mkdir(outputDir, { recursive: true })

  let browser: Browser | undefined
  try {
    browser = await chromium.launch({
      ...(existsSync(chromePath) ? { executablePath: chromePath } : {}),
      headless: true,
    })
    await runFlow(
      browser,
      baseUrl,
      allowedHosts,
      { width: 1440, height: 900 },
      'desktop',
      'no-preference',
    )
    await runFlow(
      browser,
      baseUrl,
      allowedHosts,
      { width: 390, height: 844 },
      'mobile',
      'reduce',
    )
  } finally {
    await browser?.close()
  }

  if (errors.length) {
    throw new Error(errors.join('\n'))
  }

  console.log(`Visual QA passed. Screenshots: ${outputDir}`)
} finally {
  await target.stop()
}
