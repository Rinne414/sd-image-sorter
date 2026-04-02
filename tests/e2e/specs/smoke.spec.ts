import { test, expect, APIRequestContext } from '@playwright/test'

/**
 * Smoke Tests for SD Image Sorter
 *
 * These tests verify basic connectivity and critical paths.
 * Run these first to ensure the application is working.
 */

test.describe('Smoke Tests', () => {
  test('should load the main page', async ({ page }) => {
    await page.goto('/')

    // Verify the page title
    await expect(page).toHaveTitle(/SD Image Sorter/i)

    // Verify main navigation is visible
    await expect(page.locator('.nav-tabs')).toBeVisible()

    // Verify gallery view is loaded by default
    await expect(page.locator('#image-grid')).toBeVisible()
  })

  test('should have all navigation tabs', async ({ page }) => {
    await page.goto('/')

    const tabs = [
      'gallery',
      'auto-separate',
      'manual-sort',
      'censor',
      'prompt-lab',
      'similarity',
      'artist-ident',
    ]

    for (const tab of tabs) {
      const tabElement = page.locator(`[data-view="${tab}"]`)
      await expect(tabElement).toBeVisible()
    }
  })

  test('should navigate between views', async ({ page }) => {
    await page.goto('/')

    // Navigate to Auto-Separate
    await page.locator('[data-view="auto-separate"]').click()
    await expect(page.locator('#scan-path-input')).toBeVisible()

    // Navigate to Manual Sort
    await page.locator('[data-view="manual-sort"]').click()
    await expect(page.locator('#start-sort-button')).toBeVisible()

    // Navigate to Censor
    await page.locator('[data-view="censor"]').click()
    await expect(page.locator('#censor-image-select')).toBeVisible()

    // Navigate to Prompt Lab
    await page.locator('[data-view="prompt-lab"]').click()
    await expect(page.locator('#generate-prompt-btn')).toBeVisible()

    // Navigate to Similarity
    await page.locator('[data-view="similarity"]').click()
    await expect(page.locator('#embed-btn')).toBeVisible()

    // Navigate back to Gallery
    await page.locator('[data-view="gallery"]').click()
    await expect(page.locator('#image-grid')).toBeVisible()
  })

  test('API health check - images endpoint', async ({ request }) => {
    const response = await request.get('/api/images?limit=1')
    expect(response.ok()).toBeTruthy()

    const data = await response.json()
    expect(data).toHaveProperty('images')
    expect(Array.isArray(data.images)).toBeTruthy()
  })

  test('API health check - stats endpoint', async ({ request }) => {
    const response = await request.get('/api/stats')
    expect(response.ok()).toBeTruthy()

    const data = await response.json()
    expect(data).toHaveProperty('total_images')
  })

  test('API health check - generators endpoint', async ({ request }) => {
    const response = await request.get('/api/generators')
    expect(response.ok()).toBeTruthy()

    const data = await response.json()
    expect(data).toHaveProperty('generators')
    expect(Array.isArray(data.generators)).toBeTruthy()
  })

  test('API health check - tags endpoint', async ({ request }) => {
    const response = await request.get('/api/tags?limit=10')
    expect(response.ok()).toBeTruthy()

    const data = await response.json()
    expect(data).toHaveProperty('tags')
    expect(Array.isArray(data.tags)).toBeTruthy()
  })

  test('should handle invalid API routes gracefully', async ({ request }) => {
    const response = await request.get('/api/nonexistent-endpoint')
    expect(response.status()).toBe(404)
  })

  test('should have OpenAPI documentation available', async ({ request }) => {
    const response = await request.get('/docs')
    expect(response.ok()).toBeTruthy()
  })
})

test.describe('Error Handling', () => {
  test('should show validation error for invalid scan path', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-view="auto-separate"]').click()

    // Try to scan with empty path
    await page.locator('#scan-path-input').fill('')
    await page.locator('#scan-button').click()

    // Should show validation error
    await expect(page.locator('.error-message, .validation-error')).toBeVisible({ timeout: 5000 })
  })

  test('should handle 404 for missing image', async ({ request }) => {
    const response = await request.get('/api/images/999999999')
    expect(response.status()).toBe(404)
  })

  test('should handle rate limiting gracefully', async ({ request }) => {
    // Make many rapid requests
    const promises = []
    for (let i = 0; i < 10; i++) {
      promises.push(request.get('/api/images?limit=1'))
    }

    const responses = await Promise.all(promises)

    // All should succeed (within rate limit)
    const successCount = responses.filter((r) => r.ok()).length
    expect(successCount).toBe(10)
  })
})
