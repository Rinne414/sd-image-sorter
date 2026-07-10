import { test, expect } from '../fixtures/click-ledger'

/**
 * v3.4.1 AI job queue (Debt-16 / TODO #19): starting an AI tagging job while
 * another AI job runs no longer fails with a 409 toast — the backend queues
 * the job (200 + {"status":"queued"}) and the frontend shows a queued toast
 * plus "Queued #N / 排队中 #N" progress text until the dispatcher starts it.
 *
 * Uses the same route-mock pattern as smoke.spec.ts / tagger-runtime.spec.ts
 * so no real AI job needs to run.
 */

test.describe('AI job queue', () => {
  test('queued gallery tag start shows queued toast and queued progress text', async ({ page }) => {
    // Stateful mock: before the user clicks Start, /api/tag/progress must
    // report an empty queue — otherwise the page-load resume path
    // (resumeTaggingProgress) correctly adopts the queued entry as its own
    // and locks #btn-start-tag before the test can click it.
    let startRequested = false
    await page.route('**/api/tag/start', async (route) => {
      startRequested = true
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'queued',
          pipeline_queued: true,
          queue_id: 'q1',
          queue_position: 1,
          queue_length: 1,
          message: 'Queued — starts automatically after the current AI job finishes. 已加入队列，当前 AI 任务完成后自动开始。',
          pipeline_owner: 'unified-tagging',
          pipeline_mode: 'gallery-tag',
        }),
      })
    })
    await page.route('**/api/tag/progress', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'idle',
          pipeline_owner: 'unified-tagging',
          pipeline_mode: 'gallery-tag',
          pipeline_queue: {
            total_queued: startRequested ? 1 : 0,
            queued: startRequested
              ? [
                  {
                    queue_id: 'q1',
                    kind: 'gallery-tag',
                    position: 1,
                    enqueued_at: new Date().toISOString(),
                  },
                ]
              : [],
            last_start_error: null,
          },
        }),
      })
    })

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#btn-tag')).toBeVisible()

    await page.locator('#btn-tag').click()
    await expect(page.locator('#tag-modal.visible')).toBeVisible()
    await page.locator('#btn-start-tag').click()

    // Queued toast (language-agnostic: en or zh-CN).
    await expect(page.locator('#toast-container .toast').last())
      .toContainText(/Queued|已加入队列/)

    // Poller renders the queued position instead of tearing down on idle.
    await expect(page.locator('#tag-progress-text'))
      .toContainText(/Queued #1|排队中 #1/)
  })
})
