import { expect, test, type Page, type Route } from '@playwright/test'

type ProjectItem = {
  position: number
  item_type?: 'library'
  source_image_id: number
  image_id: number | null
  missing: boolean
}

type LocalProjectItem = {
  position: number
  item_type: 'local'
  ds_id: string
  path: string
  size: number
  mtime_ns: string
  device: string
  inode: string
  source_status: 'available' | 'missing' | 'changed'
  sidecar_caption: string | null
}

type DatasetProject = {
  id: number
  name: string
  revision: number
  archived_at: string | null
  created_at: string
  updated_at: string
  settings: DatasetProjectSettings
  items: Array<ProjectItem | LocalProjectItem>
  missing_image_ids: number[]
}

type DatasetProjectSettings = {
  settings_version: 1
  target_model: '' | 'sdxl' | 'flux' | 'krea2' | 'anima'
  caption_render: {
    trigger: string
    common_tags: string[]
    blacklist: string[]
    normalize_tag_underscores: boolean
    content_mode: 'template'
    prefix: string
    template: {
      template_override: string
      replace_rules: Record<string, string>
      max_tags: number
    }
  }
  naming: {
    preset: 'keep' | 'renumber' | 'custom'
    custom_pattern: string
  }
  output: {
    mode: 'folder' | 'beside_image'
    folder: string
    image_op: 'copy' | 'move'
    overwrite_policy: 'unique' | 'overwrite' | 'skip'
  }
  trainer: {
    config: 'none' | 'kohya_toml' | 'anima_lora_toml'
    contract_version: string | null
    mask_export: 'none' | 'onetrainer' | 'kohya' | 'anima_lora'
    repeats: number
    batch: number
    resolution: number
    keep_tokens: number
  }
  subject_crop: {
    enabled: boolean
    alpha_threshold: number
    padding_percent: number
    background_mode: 'keep_background' | 'transparent_rgba' | 'solid_color'
    solid_color: string
  }
  bucket_resize: {
    enabled: boolean
    subject_aware: boolean
    alpha_threshold: number
  }
  watermark_removal: {
    enabled: boolean
    method: 'telea' | 'ns'
    radius: number
    padding_percent: number
    regions: Array<{ x: number; y: number; width: number; height: number }>
  }
  planning: {
    epochs: number
  }
}

type TrainingCaptionContent = {
  content_version: 1
  booru_caption: string
  nl_caption: string
  caption_type: 'booru' | 'nl' | 'both'
}

type AnnotationRevision = {
  id: number
  subject_id: number
  annotation_kind: 'training_caption'
  parent_revision_id: number | null
  restored_from_revision_id: number | null
  content: TrainingCaptionContent
  content_sha256: string
  source: 'legacy_snapshot' | 'manual' | 'metadata' | 'wd14' | 'vlm'
    | 'translation' | 'sidecar_import' | 'restore'
  provider: string | null
  model: string | null
  author_class: 'system' | 'user' | 'ai' | 'import'
  created_at: string
}

type AnnotationHead = {
  subject_id: number
  subject_key: string
  item: { item_type: 'library'; image_id: number } | { item_type: 'local'; path: string }
  generation: number
  active_revision: AnnotationRevision
  reviewed_revision_id: number | null
  export_revision_id: number | null
}

const NOW = '2026-07-26T12:00:00+00:00'

function defaultProjectSettings(): DatasetProjectSettings {
  return {
    settings_version: 1,
    target_model: '',
    caption_render: {
      trigger: '',
      common_tags: [],
      blacklist: [],
      normalize_tag_underscores: true,
      content_mode: 'template',
      prefix: '',
      template: {
        template_override: '{trigger}, {tags:filtered}, {append}',
        replace_rules: {},
        max_tags: 0,
      },
    },
    naming: { preset: 'keep', custom_pattern: '{trigger}_{index:03d}' },
    output: {
      mode: 'folder',
      folder: '',
      image_op: 'copy',
      overwrite_policy: 'unique',
    },
    trainer: {
      config: 'none',
      contract_version: null,
      mask_export: 'none',
      repeats: 10,
      batch: 2,
      resolution: 1024,
      keep_tokens: 0,
    },
    subject_crop: {
      enabled: false,
      alpha_threshold: 1,
      padding_percent: 0,
      background_mode: 'keep_background',
      solid_color: '#000000',
    },
    bucket_resize: {
      enabled: false,
      subject_aware: false,
      alpha_threshold: 128,
    },
    watermark_removal: {
      enabled: false,
      method: 'telea',
      radius: 3,
      padding_percent: 0,
      regions: [],
    },
    planning: { epochs: 10 },
  }
}

function projectSettingsFor(
  targetModel: DatasetProjectSettings['target_model'],
  trigger: string,
  outputFolder: string,
): DatasetProjectSettings {
  const settings = defaultProjectSettings()
  return {
    ...settings,
    target_model: targetModel,
    caption_render: { ...settings.caption_render, trigger },
    output: { ...settings.output, folder: outputFolder },
  }
}

const malformedPositionCases = [
  { name: 'duplicate', positions: [0, 0] },
  { name: 'gapped', positions: [0, 2] },
  { name: 'out-of-order', positions: [1, 0] },
] as const

function project(
  id: number,
  name: string,
  revision: number,
  items: Array<ProjectItem | LocalProjectItem>,
  archivedAt: string | null,
): DatasetProject {
  const normalizedItems = items.map((item) => (
    'item_type' in item && item.item_type
      ? item
      : { ...item, item_type: 'library' as const }
  ))
  return {
    id,
    name,
    revision,
    archived_at: archivedAt,
    created_at: NOW,
    updated_at: NOW,
    settings: defaultProjectSettings(),
    items: normalizedItems,
    missing_image_ids: normalizedItems
      .filter((item): item is ProjectItem => 'missing' in item && item.missing)
      .map((item) => item.source_image_id),
  }
}

function projectSummary(value: DatasetProject) {
  return {
    id: value.id,
    name: value.name,
    revision: value.revision,
    archived_at: value.archived_at,
    created_at: value.created_at,
    updated_at: value.updated_at,
    item_count: value.items.length,
    missing_image_count: value.missing_image_ids.length,
  }
}

function annotationRevision(
  id: number,
  subjectId: number,
  content: TrainingCaptionContent,
  parentRevisionId: number | null,
  restoredFromRevisionId: number | null,
): AnnotationRevision {
  return {
    id,
    subject_id: subjectId,
    annotation_kind: 'training_caption',
    parent_revision_id: parentRevisionId,
    restored_from_revision_id: restoredFromRevisionId,
    content,
    content_sha256: id.toString(16).padStart(64, '0'),
    source: restoredFromRevisionId === null ? 'manual' : 'restore',
    provider: null,
    model: null,
    author_class: 'user',
    created_at: NOW,
  }
}

function annotationHead(
  imageId: number,
  subjectId: number,
  generation: number,
  revision: AnnotationRevision,
): AnnotationHead {
  return {
    subject_id: subjectId,
    subject_key: `project_library:${imageId}:identity`,
    item: { item_type: 'library', image_id: imageId },
    generation,
    active_revision: revision,
    reviewed_revision_id: null,
    export_revision_id: null,
  }
}

function localAnnotationHead(
  path: string,
  subjectId: number,
  generation: number,
  revision: AnnotationRevision,
): AnnotationHead {
  return {
    subject_id: subjectId,
    subject_key: `project_local:${subjectId}:identity`,
    item: { item_type: 'local', path },
    generation,
    active_revision: revision,
    reviewed_revision_id: null,
    export_revision_id: null,
  }
}

async function stubDatasetDependencies(page: Page) {
  await page.route(/\/api\/images\/(?:101|102|202|301|401)(?:\?.*)?$/, (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop())
    return route.fulfill({
      json: {
        id,
        filename: `library-${id}.png`,
        path: `C:/library/library-${id}.png`,
        width: 1024,
        height: 1024,
      },
    })
  })
  await page.route('**/api/tags/export-preview', (route) => {
    const body = route.request().postDataJSON() as { image_ids?: number[]; trigger?: string }
    const trigger = String(body.trigger || '').trim()
    return route.fulfill({
      json: {
        results: (body.image_ids || []).map((id) => ({
          image_id: id,
          filename: `library-${id}.png`,
          thumbnail_path: '',
          rendered: [trigger, `tag ${id}`].filter(Boolean).join(', '),
          nl_caption: `caption ${id}`,
        })),
      },
    })
  })
  await page.route('**/api/dataset/export-preview', (route) =>
    route.fulfill({ json: { total: 0, returned: 0, items: [] } }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/image-file/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await page.route(/\/api\/annotations\/projects\/(\d+)\/training-captions\/heads(?:\?.*)?$/, (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    return route.fulfill({
      json: {
        project_id: Number(parts[4]),
        items: [],
        has_more: false,
        next_after_subject_id: null,
      },
    })
  })
}

async function openDataset(page: Page) {
  await stubDatasetDependencies(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._initProjectStore === 'function')
}

async function submitInputModal(page: Page, value: string) {
  await expect(page.locator('#input-modal')).toHaveClass(/visible/)
  await page.locator('#input-modal-field').fill(value)
  await page.locator('#btn-input-ok').click()
}

async function acceptConfirm(page: Page) {
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
  await page.locator('#btn-confirm-ok').click()
}

async function expectProjectStatusAfterLanguageReplay(
  page: Page,
  state: string,
  englishText: string,
  chineseText: string,
) {
  const status = page.getByTestId('dataset-project-status')
  await expect(status).toHaveAttribute('data-state', state)

  await page.evaluate(() => (window as any).I18n.setLang('zh-CN'))
  await expect(status).toHaveAttribute('data-state', state)
  await expect(status).toHaveText(chineseText)

  await page.evaluate(() => (window as any).I18n.setLang('en'))
  await expect(status).toHaveAttribute('data-state', state)
  await expect(status).toHaveText(englishText)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('project settings restore managed trigger ownership when no revision draft exists', async ({ page }) => {
  const stored = project(95, 'Managed trigger source', 1, [{
    position: 0,
    source_image_id: 101,
    image_id: 101,
    missing: false,
  }], null)
  stored.settings = {
    ...defaultProjectSettings(),
    caption_render: {
      ...defaultProjectSettings().caption_render,
      trigger: 'Project_Old_Token',
      common_tags: ['Project_Old_Token'],
    },
  }
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [projectSummary(stored)] },
  }))
  await page.route('**/api/dataset/projects/95', (route) => route.fulfill({ json: stored }))
  await openDataset(page)

  await page.getByTestId('dataset-project-selector').selectOption('95')
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'loaded')
  await page.locator('#dataset-tab-workbench').click()
  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      managedTrigger: dm._quickfilledTrigger,
      trigger: (document.getElementById('dataset-trigger') as HTMLInputElement).value,
      commonTags: (document.getElementById('dataset-common-tags') as HTMLTextAreaElement).value,
    }
  })).toEqual({
    managedTrigger: 'Project_Old_Token',
    trigger: 'Project_Old_Token',
    commonTags: 'Project_Old_Token',
  })

  await page.locator('#dataset-trigger').fill('Project_New_Token')
  await page.locator('#btn-dataset-quickfill-trigger').click()
  await expect(page.locator('#dataset-common-tags')).toHaveValue('Project_New_Token')
  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      managedTrigger: dm._quickfilledTrigger,
      effectiveCaption: dm._booruTextFor(101),
    }
  })).toEqual({
    managedTrigger: 'Project_New_Token',
    effectiveCaption: 'Project_New_Token, tag 101',
  })
})

test('first named local project load preserves the Unsaved draft caption cache', async ({ page }) => {
  const localPath = 'C:/dataset/project-managed-local.png'
  const baselineOnlyPath = 'C:/dataset/project-managed-baseline.png'
  const localId = -Number.parseInt('3123456789abc', 16)
  const stored = project(96, 'Managed local trigger source', 1, [
    {
      position: 0,
      item_type: 'local',
      ds_id: 'ds:3123456789abcdef',
      path: localPath,
      size: 1024,
      mtime_ns: '1000000000',
      device: '1',
      inode: '2',
      source_status: 'available',
      sidecar_caption: '1girl, smile',
    },
    {
      position: 1,
      item_type: 'local',
      ds_id: 'ds:4123456789abcdef',
      path: baselineOnlyPath,
      size: 2048,
      mtime_ns: '2000000000',
      device: '1',
      inode: '3',
      source_status: 'available',
      sidecar_caption: '2girls, frown',
    },
  ], null)
  stored.settings = {
    ...defaultProjectSettings(),
    caption_render: {
      ...defaultProjectSettings().caption_render,
      trigger: 'Project_New_Token',
      common_tags: ['Project_New_Token'],
    },
  }
  const unsavedSettings = {
    ...defaultProjectSettings(),
    caption_render: {
      ...defaultProjectSettings().caption_render,
      trigger: 'Unsaved_Token',
      common_tags: ['Unsaved_Token'],
    },
  }
  await page.addInitScript(({ path, projectId, id, projectSettings, settings }) => {
    localStorage.setItem(
      'sd-image-sorter-dataset-local-captions',
      JSON.stringify({ [path]: 'Unsaved_Token, unsaved_private_tag' }),
    )
    localStorage.setItem(
      'sd-image-sorter-dataset-local-caption-triggers',
      JSON.stringify({ [path]: 'Unsaved_Token' }),
    )
    localStorage.setItem('sd-image-sorter-dataset-session', JSON.stringify({
      imageIds: [],
      captionEdits: {},
      nlEdits: {},
      captionType: {},
      quickfilledTrigger: 'Unsaved_Token',
      activeId: null,
      local: { localItems: [], manifests: [] },
      settings,
    }))
    localStorage.setItem(
      `sd-image-sorter-dataset-project-session-${projectId}-r1`,
      JSON.stringify({
        imageIds: [id],
        captionEdits: { [String(id)]: 'Project_New_Token, project_private_tag' },
        nlEdits: {},
        captionType: { [String(id)]: 'booru' },
        quickfilledTrigger: 'Project_New_Token',
        activeId: id,
        local: {
          localItems: [{
            id,
            abs_path: path,
            ds_id: 'ds:3123456789abcdef',
            meta: {
              source: 'local',
              ds_id: 'ds:3123456789abcdef',
              abs_path: path,
              filename: 'project-managed-local.png',
              width: 1024,
              height: 1024,
              mtime: 1,
              size: 1024,
              source_kind: 'project_local',
              sidecar_capability: 'beside_image',
            },
            caption_baseline: '1girl, smile',
          }],
          manifests: [],
        },
        settings: projectSettings,
      }),
    )
  }, {
    path: localPath,
    projectId: stored.id,
    id: localId,
    projectSettings: stored.settings,
    settings: unsavedSettings,
  })
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [projectSummary(stored)] },
  }))
  await page.route('**/api/dataset/projects/96', (route) => route.fulfill({ json: stored }))
  await openDataset(page)

  await page.getByTestId('dataset-project-selector').selectOption('96')
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'loaded')
  await page.locator('#dataset-tab-workbench').click()

  expect(await page.evaluate(({ path, baselinePath }) => {
    const dm = (window as any).DatasetMaker
    const idByPath = new Map(
      dm.imageIds.map((id: number) => [dm.localItemPaths.get(id), id]),
    )
    const localId = idByPath.get(path)
    const baselineOnlyId = idByPath.get(baselinePath)
    const savedCaptions = JSON.parse(
      localStorage.getItem('sd-image-sorter-dataset-local-captions') || '{}',
    )
    const savedTriggers = JSON.parse(
      localStorage.getItem('sd-image-sorter-dataset-local-caption-triggers') || '{}',
    )
    return {
      managedTrigger: dm._quickfilledTrigger,
      baseline: dm.captions.get(localId),
      effectiveCaption: dm._booruTextFor(localId),
      captionEdit: dm.captionEdits.get(localId),
      savedCaption: savedCaptions[path],
      savedTrigger: savedTriggers[path],
      baselineOnlyBaseline: dm.captions.get(baselineOnlyId),
      baselineOnlyEffectiveCaption: dm._booruTextFor(baselineOnlyId),
      baselineOnlyCaptionEdit: dm.captionEdits.get(baselineOnlyId),
    }
  }, { path: localPath, baselinePath: baselineOnlyPath })).toEqual({
    managedTrigger: 'Project_New_Token',
    baseline: '1girl, smile',
    effectiveCaption: 'Project_New_Token, project_private_tag',
    captionEdit: 'Project_New_Token, project_private_tag',
    savedCaption: 'Unsaved_Token, unsaved_private_tag',
    savedTrigger: 'Unsaved_Token',
    baselineOnlyBaseline: '2girls, frown',
    baselineOnlyEffectiveCaption: '2girls, frown',
    baselineOnlyCaptionEdit: undefined,
  })

  expect(await page.evaluate(async ({ path }) => {
    const dm = (window as any).DatasetMaker
    await dm._replaceQueueWithUnsavedDraft()
    dm.addLocalItems([{
      ds_id: 'ds:3123456789abcdef',
      abs_path: path,
      filename: 'project-managed-local.png',
      size: 1024,
      mtime: 1,
      width: 1024,
      height: 1024,
      sidecar_caption: 'unsaved_sidecar_baseline',
      source_kind: 'folder_path',
      sidecar_capability: 'beside_image',
    }], { switchView: false, showToast: false, focusImportTab: false })
    const localId = dm.imageIds[0]
    return {
      activeProject: dm._activeProject,
      managedTrigger: dm._quickfilledTrigger,
      effectiveCaption: dm._booruTextFor(localId),
      savedCaptions: JSON.parse(
        localStorage.getItem('sd-image-sorter-dataset-local-captions') || '{}',
      ),
      savedTriggers: JSON.parse(
        localStorage.getItem('sd-image-sorter-dataset-local-caption-triggers') || '{}',
      ),
    }
  }, { path: localPath })).toEqual({
    activeProject: null,
    managedTrigger: 'Unsaved_Token',
    effectiveCaption: 'Unsaved_Token, unsaved_private_tag',
    savedCaptions: { [localPath]: 'Unsaved_Token, unsaved_private_tag' },
    savedTriggers: { [localPath]: 'Unsaved_Token' },
  })
})

test('named local project keeps its annotation revision over another project path draft', async ({ page }) => {
  const localPath = 'C:/dataset/shared-project-path.png'
  const stored = project(198, 'Project B', 1, [{
    position: 0,
    item_type: 'local',
    ds_id: 'ds:6123456789abcdef',
    path: localPath,
    size: 1024,
    mtime_ns: '1000000000',
    device: '1',
    inode: '2',
    source_status: 'available',
    sidecar_caption: 'project_b_baseline',
  }], null)
  const revision = annotationRevision(802, 9802, {
    content_version: 1,
    booru_caption: 'project_b_saved_caption',
    nl_caption: '',
    caption_type: 'booru',
  }, null, null)
  stored.settings = {
    ...defaultProjectSettings(),
    caption_render: {
      ...defaultProjectSettings().caption_render,
      trigger: 'Project_B_Token',
      common_tags: ['Project_B_Token'],
    },
  }
  await page.addInitScript(({ path }) => {
    localStorage.setItem(
      'sd-image-sorter-dataset-local-captions',
      JSON.stringify({ [path]: 'Project_A_Token, project_a_private_tag' }),
    )
    localStorage.setItem(
      'sd-image-sorter-dataset-local-caption-triggers',
      JSON.stringify({ [path]: 'Project_A_Token' }),
    )
  }, { path: localPath })
  await openDataset(page)
  await page.route('**/api/annotations/projects/198/training-captions/heads**', (route) => (
    route.fulfill({
      json: {
        project_id: 198,
        items: [localAnnotationHead(localPath, 9802, 1, revision)],
        has_more: false,
        next_after_subject_id: null,
      },
    })
  ))

  const restored = await page.evaluate(async ({ projectValue, path }) => {
    const dm = (window as any).DatasetMaker
    await dm._replaceQueueWithProject(projectValue)
    await dm._annotationHeadsReady
    const localId = dm.imageIds[0]
    const savedCaptions = JSON.parse(
      localStorage.getItem('sd-image-sorter-dataset-local-captions') || '{}',
    )
    return {
      managedTrigger: dm._quickfilledTrigger,
      baseline: dm.captions.get(localId),
      captionEditPresent: dm.captionEdits.has(localId),
      effectiveCaption: dm._booruTextFor(localId),
      selection: dm._buildExportPayload().annotation_selections[path],
      savedCaption: savedCaptions[path],
    }
  }, { projectValue: stored, path: localPath })

  expect(restored).toEqual({
    managedTrigger: 'Project_B_Token',
    baseline: 'project_b_baseline',
    captionEditPresent: false,
    effectiveCaption: 'project_b_saved_caption',
    selection: { kind: 'revision_ref', revision_id: 802 },
    savedCaption: 'Project_A_Token, project_a_private_tag',
  })
})

test('revision draft restoration remains project-scoped and leaves the next project authoritative', async ({ page }) => {
  const localPath = 'C:/dataset/shared-managed-local.png'
  const dsId = 'ds:5123456789abcdef'
  const localId = -Number.parseInt('5123456789abc', 16)
  const revisionSettings = defaultProjectSettings()
  revisionSettings.caption_render = {
    ...revisionSettings.caption_render,
    trigger: 'Revision_Token',
    common_tags: ['Revision_Token'],
  }
  const revisionProject = project(196, 'Revision owner source', 1, [{
    position: 0,
    item_type: 'local',
    ds_id: dsId,
    path: localPath,
    size: 1024,
    mtime_ns: '1000000000',
    device: '1',
    inode: '2',
    source_status: 'available',
    sidecar_caption: '1girl, smile',
  }], null)
  revisionProject.settings = revisionSettings
  const nextSettings = defaultProjectSettings()
  nextSettings.caption_render = {
    ...nextSettings.caption_render,
    trigger: 'Next_Token',
    common_tags: ['Next_Token'],
  }
  const nextProject = project(197, 'Next owner target', 1, [{
    position: 0,
    item_type: 'local',
    ds_id: dsId,
    path: localPath,
    size: 1024,
    mtime_ns: '1000000000',
    device: '1',
    inode: '2',
    source_status: 'available',
    sidecar_caption: '1girl, smile',
  }], null)
  nextProject.settings = nextSettings

  await page.addInitScript(({ path, id, sourceId, settings }) => {
    localStorage.setItem(
      'sd-image-sorter-dataset-local-captions',
      JSON.stringify({ [path]: 'Legacy_Token, 1girl, smile' }),
    )
    localStorage.setItem(
      'sd-image-sorter-dataset-local-caption-triggers',
      JSON.stringify({ [path]: 'Legacy_Token' }),
    )
    localStorage.setItem(`sd-image-sorter-dataset-project-session-${sourceId}-r1`, JSON.stringify({
      imageIds: [id],
      captionEdits: { [String(id)]: 'Revision_Token, 1girl, smile' },
      nlEdits: {},
      captionType: { [String(id)]: 'booru' },
      quickfilledTrigger: 'Revision_Token',
      activeId: id,
      local: {
        localItems: [{
          id,
          abs_path: path,
          ds_id: 'ds:5123456789abcdef',
          meta: {
            source: 'local',
            ds_id: 'ds:5123456789abcdef',
            abs_path: path,
            filename: 'shared-managed-local.png',
            width: 512,
            height: 512,
            mtime: 1,
            size: 1024,
            source_kind: 'project_local',
            sidecar_capability: 'beside_image',
          },
          caption_baseline: '1girl, smile',
        }],
        manifests: [],
      },
      settings,
    }))
  }, {
    path: localPath,
    id: localId,
    sourceId: revisionProject.id,
    settings: revisionSettings,
  })
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [projectSummary(revisionProject), projectSummary(nextProject)] },
  }))
  await openDataset(page)

  const restoredState = await page.evaluate(async ({ source, target, path }) => {
    const dm = (window as any).DatasetMaker
    await dm._replaceQueueWithProject(source)
    const sourceId = dm.imageIds[0]
    const sourceEffectiveCaption = dm._booruTextFor(sourceId)
    const afterRevisionCaption = JSON.parse(
      localStorage.getItem('sd-image-sorter-dataset-local-captions') || '{}',
    )[path]
    const afterRevisionOwner = JSON.parse(
      localStorage.getItem('sd-image-sorter-dataset-local-caption-triggers') || '{}',
    )[path]
    await dm._replaceQueueWithProject(target)
    const targetId = dm.imageIds[0]
    return {
      sourceEffectiveCaption,
      afterRevisionCaption,
      afterRevisionOwner,
      targetManagedTrigger: dm._quickfilledTrigger,
      targetBaseline: dm.captions.get(targetId),
      targetEffectiveCaption: dm._booruTextFor(targetId),
      targetCaptionEdit: dm.captionEdits.get(targetId),
    }
  }, { source: revisionProject, target: nextProject, path: localPath })
  expect(restoredState).toEqual({
    sourceEffectiveCaption: 'Revision_Token, 1girl, smile',
    afterRevisionCaption: 'Legacy_Token, 1girl, smile',
    afterRevisionOwner: 'Legacy_Token',
    targetManagedTrigger: 'Next_Token',
    targetBaseline: '1girl, smile',
    targetEffectiveCaption: '1girl, smile',
    targetCaptionEdit: undefined,
  })
})

test('Save As persists settings v1 and loading restores the exact export configuration', async ({ page }) => {
  let createBody: Record<string, unknown> | null = null
  let createdProject: DatasetProject | null = null
  await page.route('**/api/dataset/projects', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: { projects: createdProject ? [projectSummary(createdProject)] : [] },
      })
    }
    createBody = route.request().postDataJSON() as Record<string, unknown>
    createdProject = {
      ...project(91, 'Settings source', 1, [{
        position: 0,
        source_image_id: 101,
        image_id: 101,
        missing: false,
      }], null),
      settings: createBody.settings as DatasetProjectSettings,
    }
    return route.fulfill({
      status: 201,
      json: createdProject,
    })
  })
  await page.route('**/api/dataset/projects/91', (route) => {
    if (!createdProject) throw new Error('Settings source project has not been created')
    return route.fulfill({ json: createdProject })
  })
  await openDataset(page)
  await page.waitForFunction(() =>
    (window as any).DatasetMaker?._trainerContractState?.status === 'ready')
  await page.locator('#dataset-tab-workbench').click()
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [101]
    dm.meta.set(101, { filename: 'library-101.png' })
    ;(document.getElementById('dataset-target-model') as HTMLSelectElement).value = 'flux'
    ;(document.getElementById('dataset-trigger') as HTMLInputElement).value = 'hero_token'
    ;(document.getElementById('dataset-common-tags') as HTMLTextAreaElement).value = 'masterpiece, solo'
    ;(document.getElementById('dataset-blacklist') as HTMLTextAreaElement).value = 'watermark\nlow quality'
    ;(document.getElementById('dataset-underscore-to-space') as HTMLInputElement).checked = false
    ;(document.getElementById('dataset-export-prefix') as HTMLInputElement).value = 'portrait'
    ;(document.getElementById('dataset-template-override') as HTMLTextAreaElement).value = '{trigger}, {tags:filtered}'
    ;(document.getElementById('dataset-replace-rules') as HTMLTextAreaElement).value = 'blue_eyes->azure eyes'
    ;(document.getElementById('dataset-max-tags') as HTMLInputElement).value = '37'
    ;(document.querySelector('input[name="dataset-naming-preset"][value="custom"]') as HTMLInputElement).checked = true
    ;(document.getElementById('dataset-naming-pattern') as HTMLInputElement).value = '{trigger}_{index:03d}'
    ;(document.querySelector('input[name="dataset-output-mode"][value="folder"]') as HTMLInputElement).checked = true
    ;(document.getElementById('dataset-output-folder') as HTMLInputElement).value = 'C:/training/settings-source'
    ;(document.querySelector('input[name="dataset-image-op-radio"][value="copy"]') as HTMLInputElement).checked = true
    ;(document.getElementById('dataset-image-op') as HTMLInputElement).value = 'copy'
    ;(document.getElementById('dataset-overwrite') as HTMLSelectElement).value = 'skip'
    ;(document.getElementById('dataset-trainer-package') as HTMLSelectElement).value = 'kohya_toml'
    dm._applyTrainerSelection(false)
    ;(document.getElementById('dataset-mask-export') as HTMLSelectElement).value = 'kohya'
    ;(document.getElementById('dataset-est-repeats') as HTMLInputElement).value = '12'
    ;(document.getElementById('dataset-est-batch') as HTMLInputElement).value = '3'
    ;(document.getElementById('dataset-trainer-resolution') as HTMLInputElement).value = '768'
    ;(document.getElementById('dataset-trainer-keep-tokens') as HTMLInputElement).value = '4'
    ;(document.getElementById('dataset-est-epochs') as HTMLInputElement).value = '8'
    dm._renderQueue()
  })

  await page.getByTestId('dataset-project-save-as').click()
  await submitInputModal(page, 'Settings source')
  await expect.poll(() => createBody).not.toBeNull()

  const expectedSettings: DatasetProjectSettings = {
    settings_version: 1,
    target_model: 'flux',
    caption_render: {
      trigger: 'hero_token',
      common_tags: ['masterpiece', 'solo'],
      blacklist: ['watermark', 'low quality'],
      normalize_tag_underscores: false,
      content_mode: 'template',
      prefix: 'portrait',
      template: {
        template_override: '{trigger}, {tags:filtered}',
        replace_rules: { blue_eyes: 'azure eyes' },
        max_tags: 37,
      },
    },
    naming: { preset: 'custom', custom_pattern: '{trigger}_{index:03d}' },
    output: {
      mode: 'folder',
      folder: 'C:/training/settings-source',
      image_op: 'copy',
      overwrite_policy: 'skip',
    },
    trainer: {
      config: 'kohya_toml',
      contract_version: '1.0.0',
      mask_export: 'kohya',
      repeats: 12,
      batch: 3,
      resolution: 768,
      keep_tokens: 4,
    },
    subject_crop: {
      enabled: false,
      alpha_threshold: 1,
      padding_percent: 0,
      background_mode: 'keep_background',
      solid_color: '#000000',
    },
    bucket_resize: {
      enabled: false,
      subject_aware: false,
      alpha_threshold: 128,
    },
    watermark_removal: {
      enabled: false,
      method: 'telea',
      radius: 3,
      padding_percent: 0,
      regions: [],
    },
    planning: { epochs: 8 },
  }
  expect(createBody).toEqual({
    name: 'Settings source',
    items: [{ item_type: 'library', image_id: 101 }],
    settings: expectedSettings,
  })
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'saved')

  await page.reload()
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.getByTestId('dataset-project-selector').selectOption('91')
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
  await acceptConfirm(page)
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'loaded')
  await expect(page.locator('#btn-dataset-quickfill-trigger')).toBeEnabled()

  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    const payload = dm._buildExportPayload()
    return {
      settings: dm._serializeProjectSettings(),
      payload: {
        output_folder: payload.output_folder,
        naming_pattern: payload.naming_pattern,
        trigger: payload.trigger,
        image_op: payload.image_op,
        overwrite_policy: payload.overwrite_policy,
        prefix: payload.prefix,
        template_options: payload.template_options,
        normalize_tag_underscores: payload.normalize_tag_underscores,
        blacklist: payload.blacklist,
        common_tags: payload.common_tags,
        mask_export: payload.mask_export,
        trainer_repeats: payload.trainer_repeats,
        trainer_batch: payload.trainer_batch,
      },
    }
  })).toEqual({
    settings: expectedSettings,
    payload: {
      output_folder: 'C:/training/settings-source',
      naming_pattern: '{trigger}_{index:03d}',
      trigger: 'hero_token',
      image_op: 'copy',
      overwrite_policy: 'skip',
      prefix: 'portrait',
      template_options: {
        preset_id: 'custom',
        template_override: '{trigger}, {tags:filtered}',
        trigger: 'hero_token',
        append: ['masterpiece', 'solo'],
        blacklist: ['watermark', 'low quality'],
        underscore_to_space_override: false,
        preserve_underscore_prefixes_override: ['score_'],
        replace_rules: { blue_eyes: 'azure eyes' },
        max_tags: 37,
      },
      normalize_tag_underscores: false,
      blacklist: ['watermark', 'low quality'],
      common_tags: ['masterpiece', 'solo'],
      mask_export: 'kohya',
      trainer_repeats: 12,
      trainer_batch: 3,
    },
  })
})

test('switching projects restores isolated project settings', async ({ page }) => {
  const first = {
    ...project(92, 'First settings', 1, [{
      position: 0,
      source_image_id: 101,
      image_id: 101,
      missing: false,
    }], null),
    settings: projectSettingsFor('sdxl', 'first_token', 'C:/training/first'),
  }
  const second = {
    ...project(93, 'Second settings', 1, [{
      position: 0,
      source_image_id: 102,
      image_id: 102,
      missing: false,
    }], null),
    settings: projectSettingsFor('krea2', 'second_token', 'C:/training/second'),
  }
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [projectSummary(first), projectSummary(second)] },
  }))
  await page.route('**/api/dataset/projects/92', (route) => route.fulfill({ json: first }))
  await page.route('**/api/dataset/projects/93', (route) => route.fulfill({ json: second }))
  await openDataset(page)

  await page.getByTestId('dataset-project-selector').selectOption('92')
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'loaded')
  expect(await page.evaluate(() => (window as any).DatasetMaker._serializeProjectSettings()))
    .toEqual(first.settings)

  await page.getByTestId('dataset-project-selector').selectOption('93')
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'loaded')
  expect(await page.evaluate(() => (window as any).DatasetMaker._serializeProjectSettings()))
    .toEqual(second.settings)
})

test('switching to a local-only project supersedes an in-flight trigger quickfill', async ({ page }) => {
  const localPath = 'C:/dataset/isolated-local.png'
  const localOnly = {
    ...project(98, 'Local-only target', 3, [], null),
    settings: {
      ...defaultProjectSettings(),
      caption_render: {
        ...defaultProjectSettings().caption_render,
        trigger: 'New_Token',
        common_tags: ['New_Common'],
      },
    },
    items: [{
      position: 0,
      item_type: 'local' as const,
      ds_id: 'ds:9898989898989898',
      path: localPath,
      size: 41,
      mtime_ns: '1700000000000000400',
      device: '7',
      inode: '11',
      source_status: 'available' as const,
      sidecar_caption: 'local baseline, smile',
    }],
  }
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [projectSummary(localOnly)] },
  }))
  await page.route('**/api/dataset/projects/98', (route) => route.fulfill({ json: localOnly }))
  await openDataset(page)

  const oldRequestGate: { release?: () => void } = {}
  let oldRequestStarted = false
  await page.route('**/api/tags/export-preview', async (route) => {
    const body = route.request().postDataJSON() as { image_ids?: number[]; trigger?: string }
    const trigger = String(body.trigger || '').trim()
    if (trigger === 'Old_Token') {
      oldRequestStarted = true
      await new Promise<void>((resolve) => { oldRequestGate.release = resolve })
    }
    await route.fulfill({
      json: {
        results: (body.image_ids || []).map((imageId) => ({
          image_id: imageId,
          filename: `old-${imageId}.png`,
          rendered: [trigger, `tag ${imageId}`].filter(Boolean).join(', '),
        })),
      },
    })
  })
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [101]
    dm.meta.set(101, { filename: 'library-101.png' })
    dm.captions.set(101, 'old baseline')
    dm._renderQueue()
    dm._setActive(101)
    ;(document.getElementById('dataset-trigger') as HTMLInputElement).value = 'Old_Token'
    dm._syncTriggerQuickfillButton()
  })
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#btn-dataset-quickfill-trigger').click()
  await expect.poll(() => oldRequestStarted).toBe(true)

  await page.getByTestId('dataset-project-selector').selectOption('98')
  await acceptConfirm(page)
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'loaded')
  if (!oldRequestGate.release) throw new Error('Old trigger request was not held')
  oldRequestGate.release()

  await expect(page.locator('#toast-container .toast.error')).toContainText('newer input was kept')
  await expect(page.locator('#toast-container .toast.success')).toHaveCount(0)
  await expect.poll(() => page.evaluate(({ path }) => {
    const dm = (window as any).DatasetMaker
    const localId = dm.imageIds.find((imageId: number) => imageId < 0)
    return {
      project: { id: dm._activeProject.id, revision: dm._activeProject.revision },
      trigger: (document.getElementById('dataset-trigger') as HTMLInputElement).value,
      commonTags: (document.getElementById('dataset-common-tags') as HTMLTextAreaElement).value,
      localPath: dm.localItemPaths.get(localId),
      localCaption: dm.captions.get(localId),
      staleGalleryCaptionPresent: dm.captions.has(101),
    }
  }, { path: localPath })).toEqual({
    project: { id: 98, revision: 3 },
    trigger: 'New_Token',
    commonTags: 'New_Common',
    localPath,
    localCaption: 'local baseline, smile',
    staleGalleryCaptionPresent: false,
  })
})

test('saving a project revision invalidates trigger quickfill before caption cache writes', async ({ page }) => {
  await openDataset(page)
  const requestGate: { release?: () => void } = {}
  let requestStarted = false
  await page.unroute('**/api/tags/export-preview')
  await page.route('**/api/tags/export-preview', async (route) => {
    const body = route.request().postDataJSON() as { image_ids?: number[]; trigger?: string }
    const trigger = String(body.trigger || '').trim()
    if (trigger === 'Saved_Token') {
      requestStarted = true
      await new Promise<void>((resolve) => { requestGate.release = resolve })
    }
    await route.fulfill({
      json: {
        results: (body.image_ids || []).map((imageId) => ({
          image_id: imageId,
          filename: `saved-${imageId}.png`,
          rendered: [trigger, `tag ${imageId}`].filter(Boolean).join(', '),
        })),
      },
    })
  })
  const savedProject = project(99, 'Saved project', 1, [{
    position: 0,
    source_image_id: 101,
    image_id: 101,
    missing: false,
  }], null)
  await page.evaluate(({ initialProject }) => {
    const dm = (window as any).DatasetMaker
    dm._activeProject = initialProject
    dm._annotationHeadsStatus = 'ready'
    dm._annotationHeadsOwner = {
      project_id: initialProject.id,
      project_revision: initialProject.revision,
    }
    dm.annotationHeads.clear()
    dm.imageIds = [101]
    dm.meta.set(101, { filename: 'library-101.png' })
    dm.captions.set(101, 'old baseline')
    dm._renderProjectControls()
    dm._renderQueue()
    dm._setActive(101)
    ;(document.getElementById('dataset-trigger') as HTMLInputElement).value = 'Saved_Token'
    dm._syncTriggerQuickfillButton()
  }, { initialProject: savedProject })
  await page.locator('#dataset-tab-workbench').click()

  await page.locator('#btn-dataset-quickfill-trigger').click()
  await expect.poll(() => requestStarted).toBe(true)
  await page.evaluate(({ nextProject }) => {
    ;(window as any).DatasetMaker._replaceProjectState(nextProject)
  }, { nextProject: { ...savedProject, revision: 2 } })
  if (!requestGate.release) throw new Error('Trigger quickfill request was not held')
  requestGate.release()

  await expect(page.locator('#toast-container .toast.error')).toContainText('newer input was kept')
  await expect(page.locator('#toast-container .toast.success')).toHaveCount(0)
  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      revision: dm._activeProject.revision,
      caption: dm.captions.get(101),
    }
  })).toEqual({ revision: 2, caption: 'old baseline' })
})

test('rename changes only the project name and preserves saved settings', async ({ page }) => {
  let renameBody: Record<string, unknown> | null = null
  const stored = {
    ...project(96, 'Before rename', 4, [{
      position: 0,
      source_image_id: 101,
      image_id: 101,
      missing: false,
    }], null),
    settings: projectSettingsFor('flux', 'saved_token', 'C:/training/saved'),
  }
  const renamed = { ...stored, name: 'After rename', revision: 5 }
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [projectSummary(stored)] },
  }))
  await page.route('**/api/dataset/projects/96', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: stored })
    renameBody = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({ json: renamed })
  })
  await openDataset(page)
  await page.getByTestId('dataset-project-selector').selectOption('96')
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'loaded')
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#dataset-trigger').fill('unsaved_token')

  await page.getByTestId('dataset-project-menu').click()
  await page.getByTestId('dataset-project-rename').click()
  await submitInputModal(page, 'After rename')

  await expect.poll(() => renameBody).toEqual({
    name: 'After rename',
    items: [{ item_type: 'library', image_id: 101 }],
    settings: stored.settings,
    expected_revision: 4,
  })
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'saved')
  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      name: dm._activeProject.name,
      revision: dm._activeProject.revision,
      savedTrigger: dm._activeProject.settings.caption_render.trigger,
      localTrigger: (document.getElementById('dataset-trigger') as HTMLInputElement).value,
    }
  })).toEqual({
    name: 'After rename',
    revision: 5,
    savedTrigger: 'saved_token',
    localTrigger: 'unsaved_token',
  })
  await expect.poll(() => page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      status: dm._annotationHeadsStatus,
      owner: dm._annotationHeadsOwner,
      selection: dm._buildExportPayload().annotation_selections['101'],
    }
  })).toEqual({
    status: 'ready',
    owner: { project_id: 96, project_revision: 5 },
    selection: { kind: 'dynamic_source' },
  })

  await page.locator('#btn-dataset-quickfill-trigger').click()
  await expect(page.locator('#toast-container .toast.success')).toContainText('unsaved_token')
  await expect.poll(() => page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return dm._buildExportPayload().annotation_selections['101']
  })).toEqual({
    kind: 'frozen_draft',
    content: {
      content_version: 1,
      booru_caption: 'unsaved_token, tag 101',
      nl_caption: 'caption 101',
      caption_type: 'both',
    },
  })
})

test('malformed or unverified settings fail before project queue and controls mutate', async ({ page }) => {
  const malformedSource = project(94, 'Malformed settings', 1, [{
    position: 0,
    source_image_id: 102,
    image_id: 102,
    missing: false,
  }], null)
  const { settings: _removedSettings, ...malformed } = malformedSource
  const mismatched = {
    ...project(95, 'Unverified trainer version', 1, [{
      position: 0,
      source_image_id: 102,
      image_id: 102,
      missing: false,
    }], null),
    settings: {
      ...projectSettingsFor('anima', 'trainer_token', 'C:/training/mismatch'),
      trainer: {
        config: 'kohya_toml' as const,
        contract_version: '9.9.9',
        mask_export: 'kohya' as const,
        repeats: 10,
        batch: 2,
        resolution: 1024,
        keep_tokens: 0,
      },
    },
  }
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [projectSummary(malformed as DatasetProject), projectSummary(mismatched)] },
  }))
  await page.route('**/api/dataset/projects/94', (route) => route.fulfill({ json: malformed }))
  await page.route('**/api/dataset/projects/95', (route) => route.fulfill({ json: mismatched }))
  await openDataset(page)
  await page.waitForFunction(() =>
    (window as any).DatasetMaker?._trainerContractState?.status === 'ready')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [101]
    dm.meta.set(101, { filename: 'library-101.png' })
    ;(document.getElementById('dataset-trigger') as HTMLInputElement).value = 'unchanged_token'
    ;(document.getElementById('dataset-output-folder') as HTMLInputElement).value = 'C:/unchanged'
    dm._renderQueue()
  })

  for (const projectId of [94, 95]) {
    await page.evaluate((id) => (window as any).DatasetMaker._loadProject(id), projectId)
    await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'error')
    expect(await page.evaluate(() => {
      const dm = (window as any).DatasetMaker
      return {
        imageIds: dm.imageIds,
        activeProject: dm._activeProject,
        trigger: (document.getElementById('dataset-trigger') as HTMLInputElement).value,
        outputFolder: (document.getElementById('dataset-output-folder') as HTMLInputElement).value,
      }
    })).toEqual({
      imageIds: [101],
      activeProject: null,
      trigger: 'unchanged_token',
      outputFolder: 'C:/unchanged',
    })
  }
})

test('unverified revision draft settings fail before project state mutates', async ({ page }) => {
  const targetProject = project(97, 'Draft contract mismatch', 1, [{
    position: 0,
    source_image_id: 102,
    image_id: 102,
    missing: false,
  }], null)
  const draftSettings = projectSettingsFor('anima', 'draft_token', 'C:/training/draft')
  draftSettings.trainer = {
    config: 'kohya_toml',
    contract_version: '9.9.9',
    mask_export: 'kohya',
    repeats: 10,
    batch: 2,
    resolution: 1024,
    keep_tokens: 0,
  }
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [projectSummary(targetProject)] },
  }))
  await page.route('**/api/dataset/projects/97', (route) => route.fulfill({ json: targetProject }))
  await openDataset(page)
  await page.waitForFunction(() =>
    (window as any).DatasetMaker?._trainerContractState?.status === 'ready')
  await page.evaluate((settings) => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [101]
    dm.meta.set(101, { filename: 'library-101.png' })
    ;(document.getElementById('dataset-trigger') as HTMLInputElement).value = 'unchanged_token'
    ;(document.getElementById('dataset-output-folder') as HTMLInputElement).value = 'C:/unchanged'
    localStorage.setItem('sd-image-sorter-dataset-project-session-97-r1', JSON.stringify({
      imageIds: [102],
      captionEdits: {},
      nlEdits: {},
      captionType: {},
      activeId: 102,
      local: null,
      settings,
    }))
    dm._renderQueue()
  }, draftSettings)
  const draftBytesBefore = await page.evaluate(() =>
    localStorage.getItem('sd-image-sorter-dataset-project-session-97-r1'))

  await page.evaluate(() => (window as any).DatasetMaker._loadProject(97))
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'error')
  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      imageIds: dm.imageIds,
      activeProject: dm._activeProject,
      trigger: (document.getElementById('dataset-trigger') as HTMLInputElement).value,
      outputFolder: (document.getElementById('dataset-output-folder') as HTMLInputElement).value,
      trainer: (document.getElementById('dataset-trainer-package') as HTMLSelectElement).value,
    }
  })).toEqual({
    imageIds: [101],
    activeProject: null,
    trigger: 'unchanged_token',
    outputFolder: 'C:/unchanged',
    trainer: 'none',
  })
  expect(await page.evaluate(() =>
    localStorage.getItem('sd-image-sorter-dataset-project-session-97-r1'))).toBe(draftBytesBefore)
})

test('malformed revision draft envelopes fail without state or storage mutation', async ({ page }) => {
  const malformedSettingsProject = project(98, 'Malformed draft settings', 1, [{
    position: 0,
    source_image_id: 102,
    image_id: 102,
    missing: false,
  }], null)
  const malformedLocalProject = project(99, 'Malformed draft local state', 1, [{
    position: 0,
    source_image_id: 103,
    image_id: 103,
    missing: false,
  }], null)
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [
      projectSummary(malformedSettingsProject),
      projectSummary(malformedLocalProject),
    ] },
  }))
  await page.route('**/api/dataset/projects/98', (route) =>
    route.fulfill({ json: malformedSettingsProject }))
  await page.route('**/api/dataset/projects/99', (route) =>
    route.fulfill({ json: malformedLocalProject }))
  await openDataset(page)
  await page.waitForFunction(() =>
    (window as any).DatasetMaker?._trainerContractState?.status === 'ready')
  const draftBytes = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [101]
    dm.meta.set(101, { filename: 'library-101.png' })
    ;(document.getElementById('dataset-trigger') as HTMLInputElement).value = 'unchanged_token'
    ;(document.getElementById('dataset-output-folder') as HTMLInputElement).value = 'C:/unchanged'
    const malformedSettings = JSON.stringify({
      imageIds: [102],
      captionEdits: { 102: 'preserve caption' },
      nlEdits: {},
      captionType: {},
      activeId: 102,
      local: null,
      settings: { settings_version: 1 },
    })
    const malformedLocal = JSON.stringify({
      imageIds: [103],
      captionEdits: { 103: 'preserve caption' },
      nlEdits: {},
      captionType: {},
      activeId: 103,
      local: { localItems: [], manifests: {} },
      settings: dm._defaultProjectSettings(),
    })
    localStorage.setItem('sd-image-sorter-dataset-project-session-98-r1', malformedSettings)
    localStorage.setItem('sd-image-sorter-dataset-project-session-99-r1', malformedLocal)
    dm._renderQueue()
    return { malformedSettings, malformedLocal }
  })

  for (const draftCase of [
    { projectId: 98, key: 'sd-image-sorter-dataset-project-session-98-r1', bytes: draftBytes.malformedSettings },
    { projectId: 99, key: 'sd-image-sorter-dataset-project-session-99-r1', bytes: draftBytes.malformedLocal },
  ]) {
    await page.evaluate((id) => (window as any).DatasetMaker._loadProject(id), draftCase.projectId)
    await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'error')
    expect(await page.evaluate(() => {
      const dm = (window as any).DatasetMaker
      return {
        imageIds: dm.imageIds,
        activeProject: dm._activeProject,
        trigger: (document.getElementById('dataset-trigger') as HTMLInputElement).value,
        outputFolder: (document.getElementById('dataset-output-folder') as HTMLInputElement).value,
      }
    })).toEqual({
      imageIds: [101],
      activeProject: null,
      trigger: 'unchanged_token',
      outputFolder: 'C:/unchanged',
    })
    expect(await page.evaluate((key) => localStorage.getItem(key), draftCase.key)).toBe(draftCase.bytes)
  }
})

test('unverified unsaved draft settings fail without leaving the active project', async ({ page }) => {
  const currentProject = project(100, 'Current project', 1, [{
    position: 0,
    source_image_id: 101,
    image_id: 101,
    missing: false,
  }], null)
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [projectSummary(currentProject)] },
  }))
  await page.route('**/api/dataset/projects/100', (route) =>
    route.fulfill({ json: currentProject }))
  await openDataset(page)
  await page.waitForFunction(() =>
    (window as any).DatasetMaker?._trainerContractState?.status === 'ready')
  await page.getByTestId('dataset-project-selector').selectOption('100')
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'loaded')
  const unsavedDraftBytes = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    const defaultSettings = dm._defaultProjectSettings()
    const settings = {
      ...defaultSettings,
      trainer: {
        config: 'kohya_toml',
        contract_version: '9.9.9',
        mask_export: 'kohya',
        repeats: 10,
        batch: 2,
        resolution: 1024,
        keep_tokens: 0,
      },
    }
    const bytes = JSON.stringify({
      imageIds: [102],
      captionEdits: {},
      nlEdits: {},
      captionType: {},
      activeId: 102,
      local: null,
      settings,
    })
    localStorage.setItem('sd-image-sorter-dataset-session', bytes)
    return bytes
  })

  await page.evaluate(() => (window as any).DatasetMaker._selectUnsavedDraft())

  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'error')
  await expect(page.getByTestId('dataset-project-selector')).toHaveValue('100')
  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return { imageIds: dm.imageIds, activeProjectId: dm._activeProject?.id }
  })).toEqual({ imageIds: [101], activeProjectId: 100 })
  expect(await page.evaluate(() =>
    localStorage.getItem('sd-image-sorter-dataset-session'))).toBe(unsavedDraftBytes)
})

test('Save As rejects settings changed during asynchronous source preparation', async ({ page }) => {
  let createCount = 0
  await page.route('**/api/dataset/projects', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { projects: [] } })
    createCount += 1
    return route.fulfill({ status: 500, json: { detail: 'unexpected create' } })
  })
  await openDataset(page)
  await page.waitForFunction(() =>
    (window as any).DatasetMaker?._trainerContractState?.status === 'ready')
  await page.locator('#dataset-tab-workbench').click()
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [101]
    dm.meta.set(101, { filename: 'library-101.png' })
    dm._renderQueue()
    dm._materializeProjectLocalItems = () => new Promise((resolve) => {
      ;(window as any).__resolveProjectMaterialization = resolve
    })
  })

  await page.getByTestId('dataset-project-save-as').click()
  await submitInputModal(page, 'Racing settings')
  await page.waitForFunction(() =>
    typeof (window as any).__resolveProjectMaterialization === 'function')
  await page.locator('#dataset-trigger').fill('changed_during_save')
  await page.evaluate(() => (window as any).__resolveProjectMaterialization())

  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'error')
  await expect(page.locator('#toast-container .toast').last()).toContainText('settings changed')
  expect(createCount).toBe(0)
})

test('Save As discloses browser-only caption edits while persisting the ordered project queue', async ({ page }) => {
  let createBody: Record<string, unknown> | null = null
  await page.route('**/api/dataset/projects', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { projects: [] } })
    }
    createBody = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({
      status: 201,
      json: project(7, 'Character set', 1, [{
        position: 0,
        source_image_id: 101,
        image_id: 101,
        missing: false,
      }], null),
    })
  })
  await openDataset(page)
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [101]
    dm.meta.set(101, { filename: 'library-101.png' })
    dm.captions.set(101, 'original tag')
    dm.captionEdits.set(101, 'edited tag')
    dm._renderQueue()
  })

  await page.getByTestId('dataset-project-save-as').click()
  await submitInputModal(page, 'Character set')
  await expect(page.locator('#confirm-message')).toContainText('browser draft')
  await acceptConfirm(page)

  await expect.poll(() => createBody).toEqual({
    name: 'Character set',
    items: [{ item_type: 'library', image_id: 101 }],
    settings: defaultProjectSettings(),
  })
  await expect(page.getByTestId('dataset-project-selector')).toHaveValue('7')
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'saved')
})

test('project status text survives real language replay for loaded, idle, saved, and error states', async ({ page }) => {
  const stored = project(88, 'Language replay source', 1, [{
    position: 0,
    source_image_id: 101,
    image_id: 101,
    missing: false,
  }], null)
  const created = project(89, 'Language replay saved', 1, [{
    position: 0,
    source_image_id: 101,
    image_id: 101,
    missing: false,
  }], null)
  await page.route('**/api/dataset/projects', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { projects: [projectSummary(stored)] } })
    }
    return route.fulfill({ status: 201, json: created })
  })
  await page.route('**/api/dataset/projects/88', (route) => route.fulfill({ json: stored }))
  await page.route('**/api/dataset/projects/89', (route) => route.fulfill({
    status: 500,
    json: { detail: 'intentional status replay failure' },
  }))
  await openDataset(page)

  await page.getByTestId('dataset-project-selector').selectOption('88')
  await expectProjectStatusAfterLanguageReplay(page, 'loaded', 'Loaded', '已加载')

  await page.getByTestId('dataset-project-selector').selectOption('')
  await expectProjectStatusAfterLanguageReplay(page, 'idle', 'No saved project', '未保存项目')

  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [101]
    dm.meta.set(101, { filename: 'library-101.png' })
    dm._renderQueue()
  })
  await page.getByTestId('dataset-project-save-as').click()
  await submitInputModal(page, 'Language replay saved')
  await expectProjectStatusAfterLanguageReplay(page, 'saved', 'Saved', '已保存')

  await page.getByTestId('dataset-project-save').click()
  await expectProjectStatusAfterLanguageReplay(page, 'error', 'Project error', '项目错误')
})

test('Save As persists exact mixed Library and local order without calling local files browser-only', async ({ page }) => {
  let createBody: Record<string, unknown> | null = null
  const localPath = 'C:/dataset/project-local.png'
  const localResponse: LocalProjectItem = {
    position: 1,
    item_type: 'local',
    ds_id: 'ds:1111111111111111',
    path: localPath,
    size: 17,
    mtime_ns: '1700000000000000000',
    device: '9',
    inode: '27',
    source_status: 'available',
    sidecar_caption: '1girl, red_hair',
  }
  await page.route('**/api/dataset/projects', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { projects: [] } })
    }
    createBody = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({
      status: 201,
      json: {
        ...project(71, 'Mixed sources', 1, [], null),
        items: [
          {
            position: 0,
            item_type: 'library',
            source_image_id: 101,
            image_id: 101,
            missing: false,
          },
          localResponse,
        ],
      },
    })
  })
  await openDataset(page)
  await page.evaluate(({ path }) => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [101]
    dm.meta.set(101, { filename: 'library-101.png' })
    dm.addLocalItems([{
      ds_id: 'ds:1111111111111111',
      abs_path: path,
      filename: 'project-local.png',
      width: 768,
      height: 1024,
      mtime: 1700000000,
      size: 17,
      source_kind: 'upload',
      sidecar_capability: 'beside_image',
      sidecar_caption: '1girl, red_hair',
    }], { switchView: false, showToast: false, focusImportTab: false })
  }, { path: localPath })

  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#dataset-trigger').fill('Hero_Token')
  await page.locator('#btn-dataset-quickfill-trigger').click()

  await page.getByTestId('dataset-project-save-as').click()
  await submitInputModal(page, 'Mixed sources')
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
  await acceptConfirm(page)

  const expectedSettings = defaultProjectSettings()
  expectedSettings.caption_render = {
    ...expectedSettings.caption_render,
    trigger: 'Hero_Token',
    common_tags: ['Hero_Token'],
  }

  await expect.poll(() => createBody).toEqual({
    name: 'Mixed sources',
    items: [
      { item_type: 'library', image_id: 101 },
      { item_type: 'local', path: localPath },
    ],
    settings: expectedSettings,
  })
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/visible/)
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'saved')
  const sourceCaptionSelection = await page.evaluate(async ({ path }) => {
    const dm = (window as any).DatasetMaker
    await dm._annotationHeadsReady
    const localId = dm.imageIds.find((id: number) => id < 0)
    const payload = dm._buildExportPayload()
    return {
      baseline: dm.captions.get(localId),
      overridePresent: dm.captionEdits.has(localId),
      selection: payload.annotation_selections[path],
    }
  }, { path: localPath })
  expect(sourceCaptionSelection).toEqual({
    baseline: '1girl, red_hair',
    overridePresent: true,
    selection: {
      kind: 'frozen_draft',
      content: {
        content_version: 1,
        booru_caption: 'Hero_Token, 1girl, red_hair',
        nl_caption: '',
        caption_type: 'booru',
      },
    },
  })
  const reloadedBaseline = await page.evaluate(async () => {
    const dm = (window as any).DatasetMaker
    await dm._replaceQueueWithProject(dm._activeProject)
    const localId = dm.imageIds.find((id: number) => id < 0)
    return {
      baseline: dm.captions.get(localId),
      overridePresent: dm.captionEdits.has(localId),
      selection: dm._buildExportPayload().annotation_selections[dm.localItemPaths.get(localId)],
    }
  })
  expect(reloadedBaseline).toEqual({
    baseline: '1girl, red_hair',
    overridePresent: true,
    selection: {
      kind: 'frozen_draft',
      content: {
        content_version: 1,
        booru_caption: 'Hero_Token, 1girl, red_hair',
        nl_caption: '',
        caption_type: 'booru',
      },
    },
  })
  const draftContinuity = await page.evaluate(async () => {
    const dm = (window as any).DatasetMaker
    const beforeId = dm.imageIds.find((id: number) => id < 0)
    dm.captionEdits.set(beforeId, 'local caption draft')
    dm._saveSession()
    await dm._replaceQueueWithProject(dm._activeProject)
    const afterId = dm.imageIds.find((id: number) => id < 0)
    return {
      beforeId,
      afterId,
      caption: dm.captionEdits.get(afterId),
    }
  })
  expect(draftContinuity.beforeId).toBeLessThan(0)
  expect(draftContinuity.afterId).toBe(draftContinuity.beforeId)
  expect(draftContinuity.caption).toBe('local caption draft')
})

test('named project blocks preview readiness and export until a paged manifest is saved', async ({ page }) => {
  const scanToken = 'named-project-paged-manifest'
  const firstPath = 'C:/dataset/paged-manifest/001.png'
  const secondPath = 'C:/dataset/paged-manifest/002.png'
  const firstItem = {
    ds_id: 'ds:7123456789abcdef',
    abs_path: firstPath,
    filename: '001.png',
    size: 100,
    mtime: 1,
    width: 1024,
    height: 1024,
    sidecar_caption: '1girl, smile',
    folder_scan_token: scanToken,
    scan_index: 0,
    source_kind: 'folder_path',
    sidecar_capability: 'beside_image',
  }
  const secondItem = {
    ...firstItem,
    ds_id: 'ds:8123456789abcdef',
    abs_path: secondPath,
    filename: '002.png',
    scan_index: 1,
  }
  const stored = project(199, 'Paged manifest guard', 1, [], null)
  stored.settings = projectSettingsFor('', '', 'C:/training/paged-manifest')
  const saved = project(199, 'Paged manifest guard', 2, [
    {
      position: 0,
      item_type: 'local',
      ds_id: firstItem.ds_id,
      path: firstPath,
      size: firstItem.size,
      mtime_ns: '1000000000',
      device: '1',
      inode: '11',
      source_status: 'available',
      sidecar_caption: firstItem.sidecar_caption,
    },
    {
      position: 1,
      item_type: 'local',
      ds_id: secondItem.ds_id,
      path: secondPath,
      size: secondItem.size,
      mtime_ns: '1000000000',
      device: '1',
      inode: '12',
      source_status: 'available',
      sidecar_caption: secondItem.sidecar_caption,
    },
  ], null)
  saved.settings = stored.settings
  let previewRequests = 0
  let readinessRequests = 0
  let exportRequests = 0

  await openDataset(page)
  await page.route('**/api/dataset/export-preview', (route) => {
    previewRequests += 1
    return route.fulfill({ json: { total: 2, returned: 0, items: [] } })
  })
  await page.route('**/api/dataset/readiness/start', (route) => {
    readinessRequests += 1
    return route.fulfill({ status: 500, json: { detail: 'must not start' } })
  })
  await page.route('**/api/dataset/export/start', (route) => {
    exportRequests += 1
    return route.fulfill({ status: 500, json: { detail: 'must not start' } })
  })

  await page.evaluate(async ({ projectValue, token, item }) => {
    const dm = (window as any).DatasetMaker
    await dm._replaceQueueWithProject(projectValue)
    dm._registerFolderManifest({
      scan_token: token,
      folder_path: 'C:/dataset/paged-manifest',
      total_files_seen: 2,
    })
    dm.addLocalItems([item], { switchView: false, showToast: false, focusImportTab: false })
    dm._setPipelineTab('export')
    dm._renderReadiness()
    dm._updateExportEnabled()
  }, { projectValue: stored, token: scanToken, item: firstItem })

  const blockedReason = 'Click Save to materialize 2 manifest image(s) into a new Dataset Project revision before preview, Readiness, or export.'
  await expect(page.getByTestId('dataset-readiness-check')).toBeDisabled()
  await expect(page.getByTestId('dataset-readiness-check')).toHaveAttribute('title', blockedReason)
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()
  await expect(page.locator('#dataset-export-disabled-hint')).toContainText(blockedReason)
  await expect(page.locator('#dataset-export-preview-list')).toContainText(blockedReason)

  const chineseBlockedReason = '请点击“保存”，将 Manifest 中的 2 张图片写入新的数据集项目版本，再进行预览、完整性检查或导出。'
  await page.evaluate(() => {
    ;(window as any).I18n.setLang('zh-CN')
  })
  await expect(page.getByTestId('dataset-readiness-check')).toHaveAttribute('title', chineseBlockedReason)
  await expect(page.locator('#dataset-export-disabled-hint')).toContainText(chineseBlockedReason)
  await expect(page.locator('#dataset-export-preview-list')).toContainText(chineseBlockedReason)
  expect({ previewRequests, readinessRequests, exportRequests }).toEqual({
    previewRequests: 0,
    readinessRequests: 0,
    exportRequests: 0,
  })

  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    let payloadError = ''
    try {
      dm._buildExportPayload()
    } catch (error) {
      payloadError = (error as Error).message
    }
    return {
      disabledReason: dm._baseExportDisabledReason(),
      payloadError,
    }
  })).toEqual({
    disabledReason: chineseBlockedReason,
    payloadError: chineseBlockedReason,
  })

  await page.evaluate(async () => {
    const dm = (window as any).DatasetMaker
    await dm._startReadinessCheck()
    dm._readinessAcceptedSignature = null
    dm._setReadinessView({
      state: 'ready',
      message: 'Ready',
      activeJobId: null,
      processed: 1,
      total: 1,
      report: {
        report_id: 'blocked-report',
        input_fingerprint: 'blocked-input',
        summary: {
          processed: 1,
          total_requested: 1,
          trainable_pairs: 1,
          blocker_count: 0,
          warning_count: 0,
        },
        issues: [],
      },
    })
    await dm._runExport()
  })
  await expect(page.locator('#toast-container .toast.warning').last()).toContainText(chineseBlockedReason)
  expect({ previewRequests, readinessRequests, exportRequests }).toEqual({
    previewRequests: 0,
    readinessRequests: 0,
    exportRequests: 0,
  })

  await page.evaluate(async (projectValue) => {
    const dm = (window as any).DatasetMaker
    await dm._replaceQueueWithProject(projectValue)
    dm._setReadinessView({
      state: 'idle', message: '', activeJobId: null, processed: 0, total: 0, report: null,
    })
    dm._setPipelineTab('export')
    dm._updateExportEnabled()
    await dm._refreshExportPreview()
  }, saved)
  await expect(page.getByTestId('dataset-readiness-check')).toBeEnabled()
  await expect.poll(() => previewRequests).toBeGreaterThan(0)
  expect(await page.evaluate(({ first, second }) => {
    const payload = (window as any).DatasetMaker._buildExportPayload()
    return {
      selections: payload.annotation_selections,
      scanTokens: payload.dataset_scan_tokens,
      projectId: payload.dataset_project_id,
    }
  }, { first: firstPath, second: secondPath })).toEqual({
    selections: {
      [firstPath]: { kind: 'dynamic_source' },
      [secondPath]: { kind: 'dynamic_source' },
    },
    scanTokens: [],
    projectId: 199,
  })

  const unsavedState = await page.evaluate(async ({ token, item }) => {
    const dm = (window as any).DatasetMaker
    await dm._replaceQueueWithUnsavedDraft()
    ;(document.getElementById('dataset-output-folder') as HTMLInputElement).value = 'C:/training/unsaved'
    dm._registerFolderManifest({
      scan_token: token,
      folder_path: 'C:/dataset/paged-manifest',
      total_files_seen: 2,
    })
    dm.addLocalItems([item], { switchView: false, showToast: false, focusImportTab: false })
    dm._renderReadiness()
    dm._updateExportEnabled()
    const payload = dm._buildExportPayload()
    return {
      activeProject: dm._activeProject,
      disabledReason: dm._baseExportDisabledReason(),
      projectId: payload.dataset_project_id,
      selections: payload.annotation_selections,
      scanTokens: payload.dataset_scan_tokens,
    }
  }, { token: scanToken, item: firstItem })
  expect(unsavedState).toEqual({
    activeProject: null,
    disabledReason: '',
    projectId: undefined,
    selections: undefined,
    scanTokens: [{ scan_token: scanToken, exclude_paths: [] }],
  })
  await expect(page.getByTestId('dataset-readiness-check')).toBeEnabled()
})

test('Save As materializes every manifest member at its mixed-queue position', async ({ page }) => {
  let createBody: Record<string, unknown> | null = null
  const firstPath = 'C:/dataset/manifest/001.png'
  const secondPath = 'C:/dataset/manifest/002.png'
  const localResponses: LocalProjectItem[] = [firstPath, secondPath].map((path, index) => ({
    position: index + 1,
    item_type: 'local',
    ds_id: `ds:${String(index + 1).repeat(16)}`,
    path,
    size: 20 + index,
    mtime_ns: `170000000000000000${index}`,
    device: '9',
    inode: String(40 + index),
    source_status: 'available',
    sidecar_caption: null,
  }))
  await page.route('**/api/dataset/folder-scan', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    expect(body).toEqual({
      scan_token: 'manifest-project-token',
      offset: 0,
      limit: 5000,
      include_thumbnails: false,
    })
    return route.fulfill({
      json: {
        folder_path: 'C:/dataset/manifest',
        scan_token: 'manifest-project-token',
        total_files_seen: 2,
        offset: 0,
        next_offset: null,
        has_more: false,
        items: [
          {
            ds_id: 'ds:1111111111111111',
            abs_path: firstPath,
            filename: '001.png',
            width: 0,
            height: 0,
            mtime: 1700000000,
            size: 20,
            thumb_b64: '',
            scan_index: 0,
            source_kind: 'folder_path',
            sidecar_capability: 'beside_image',
          },
          {
            ds_id: 'ds:2222222222222222',
            abs_path: secondPath,
            filename: '002.png',
            width: 0,
            height: 0,
            mtime: 1700000000,
            size: 21,
            thumb_b64: '',
            scan_index: 1,
            source_kind: 'folder_path',
            sidecar_capability: 'beside_image',
          },
        ],
      },
    })
  })
  await page.route('**/api/dataset/projects', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { projects: [] } })
    }
    createBody = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({
      status: 201,
      json: {
        ...project(75, 'Complete manifest', 1, [], null),
        items: [
          {
            position: 0,
            item_type: 'library',
            source_image_id: 101,
            image_id: 101,
            missing: false,
          },
          ...localResponses,
          {
            position: 3,
            item_type: 'library',
            source_image_id: 102,
            image_id: 102,
            missing: false,
          },
        ],
      },
    })
  })
  await openDataset(page)
  await page.evaluate(({ first }) => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [101]
    dm.meta.set(101, { filename: 'library-101.png' })
    dm.localManifestTokens.set('manifest-project-token', {
      scan_token: 'manifest-project-token',
      folder_path: 'C:/dataset/manifest',
      total: 2,
      queueIndex: 1,
      excludedPaths: new Set(),
    })
    dm.addLocalItems([{
      ds_id: 'ds:1111111111111111',
      abs_path: first,
      filename: '001.png',
      width: 0,
      height: 0,
      mtime: 1700000000,
      size: 20,
      scan_index: 0,
      folder_scan_token: 'manifest-project-token',
      source_kind: 'folder_path',
      sidecar_capability: 'beside_image',
    }], { switchView: false, showToast: false, focusImportTab: false })
    dm.imageIds.push(102)
    dm.meta.set(102, { filename: 'library-102.png' })
  }, { first: firstPath })

  await page.getByTestId('dataset-project-save-as').click()
  await submitInputModal(page, 'Complete manifest')

  await expect.poll(() => createBody).toEqual({
    name: 'Complete manifest',
    items: [
      { item_type: 'library', image_id: 101 },
      { item_type: 'local', path: firstPath },
      { item_type: 'local', path: secondPath },
      { item_type: 'library', image_id: 102 },
    ],
    settings: defaultProjectSettings(),
  })
  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return dm.imageIds.map((id: number) => (
      id < 0 ? dm.localItemPaths.get(id) : id
    ))
  })).toEqual([101, firstPath, secondPath, 102])
})

test('Save As rejects an incomplete manifest without writing a partial project', async ({ page }) => {
  let createCount = 0
  const firstPath = 'C:/dataset/incomplete/001.png'
  await page.route('**/api/dataset/folder-scan', (route) => route.fulfill({
    json: {
      folder_path: 'C:/dataset/incomplete',
      scan_token: 'incomplete-project-token',
      total_files_seen: 2,
      offset: 0,
      next_offset: null,
      has_more: false,
      items: [{
        ds_id: 'ds:1111111111111111',
        abs_path: firstPath,
        filename: '001.png',
        width: 0,
        height: 0,
        mtime: 1700000000,
        size: 20,
        thumb_b64: '',
        scan_index: 0,
        source_kind: 'folder_path',
        sidecar_capability: 'beside_image',
      }],
    },
  }))
  await page.route('**/api/dataset/projects', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { projects: [] } })
    }
    createCount += 1
    return route.fulfill({ status: 500, json: { detail: 'must not write' } })
  })
  await openDataset(page)
  await page.evaluate(({ first }) => {
    const dm = (window as any).DatasetMaker
    dm.localManifestTokens.set('incomplete-project-token', {
      scan_token: 'incomplete-project-token',
      folder_path: 'C:/dataset/incomplete',
      total: 2,
      queueIndex: 0,
      excludedPaths: new Set(),
    })
    dm.addLocalItems([{
      ds_id: 'ds:1111111111111111',
      abs_path: first,
      filename: '001.png',
      width: 0,
      height: 0,
      mtime: 1700000000,
      size: 20,
      scan_index: 0,
      folder_scan_token: 'incomplete-project-token',
      source_kind: 'folder_path',
      sidecar_capability: 'beside_image',
    }], { switchView: false, showToast: false, focusImportTab: false })
  }, { first: firstPath })

  await page.getByTestId('dataset-project-save-as').click()
  await submitInputModal(page, 'Incomplete manifest')

  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'error')
  expect(createCount).toBe(0)
  expect(await page.evaluate(() => (window as any).DatasetMaker._activeProject)).toBeNull()
})

test('Save As rejects a multi-page manifest gap and terminal overrun without writing a project', async ({ page }) => {
  let createCount = 0
  const paths = [
    'C:/dataset/pagination-gap/001.png',
    'C:/dataset/pagination-gap/003.png',
    'C:/dataset/pagination-gap/004.png',
  ]
  await page.route('**/api/dataset/folder-scan', (route) => {
    const body = route.request().postDataJSON() as {
      offset: number
      scan_token: string
    }
    const pageItems = body.offset === 0
      ? [{ path: paths[0], scanIndex: 0 }]
      : [
          { path: paths[1], scanIndex: 2 },
          { path: paths[2], scanIndex: 3 },
        ]
    return route.fulfill({
      json: {
        folder_path: 'C:/dataset/pagination-gap',
        scan_token: body.scan_token,
        total_files_seen: 3,
        offset: body.offset,
        next_offset: body.offset === 0 ? 2 : null,
        has_more: body.offset === 0,
        items: pageItems.map(({ path, scanIndex }) => ({
          ds_id: `ds:${String(scanIndex + 1).repeat(16)}`,
          abs_path: path,
          filename: path.split('/').pop(),
          width: 0,
          height: 0,
          mtime: 1700000000,
          size: 20 + scanIndex,
          thumb_b64: '',
          scan_index: scanIndex,
          source_kind: 'folder_path',
          sidecar_capability: 'beside_image',
        })),
      },
    })
  })
  await page.route('**/api/dataset/projects', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { projects: [] } })
    }
    createCount += 1
    return route.fulfill({
      status: 201,
      json: {
        ...project(77, 'Invalid pagination', 1, [], null),
        items: paths.map((path, index): LocalProjectItem => ({
          position: index,
          item_type: 'local',
          ds_id: `ds:${String(index + 7).repeat(16)}`,
          path,
          size: 20 + index,
          mtime_ns: `170000000000000000${index}`,
          device: '9',
          inode: String(70 + index),
          source_status: 'available',
          sidecar_caption: null,
        })),
      },
    })
  })
  await openDataset(page)
  await page.evaluate(({ firstPath }) => {
    const dm = (window as any).DatasetMaker
    dm.localManifestTokens.set('pagination-gap-token', {
      scan_token: 'pagination-gap-token',
      folder_path: 'C:/dataset/pagination-gap',
      total: 3,
      queueIndex: 0,
      excludedPaths: new Set(),
    })
    dm.addLocalItems([{
      ds_id: 'ds:1111111111111111',
      abs_path: firstPath,
      filename: '001.png',
      width: 0,
      height: 0,
      mtime: 1700000000,
      size: 20,
      scan_index: 0,
      folder_scan_token: 'pagination-gap-token',
      source_kind: 'folder_path',
      sidecar_capability: 'beside_image',
    }], { switchView: false, showToast: false, focusImportTab: false })
  }, { firstPath: paths[0] })

  await page.getByTestId('dataset-project-save-as').click()
  await submitInputModal(page, 'Invalid pagination')

  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'error')
  expect(createCount).toBe(0)
  expect(await page.evaluate(() => (window as any).DatasetMaker._activeProject)).toBeNull()
})

for (const malformedCase of malformedPositionCases) {
  test(`Save As rejects ${malformedCase.name} response positions before identity reconciliation`, async ({ page }) => {
    const logicalPath = `C:/dataset/${malformedCase.name}-logical.png`
    const canonicalPath = `C:/dataset/${malformedCase.name}-canonical.png`
    await page.route('**/api/dataset/projects', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ json: { projects: [] } })
      }
      return route.fulfill({
        status: 201,
        json: {
          ...project(78, `Malformed ${malformedCase.name}`, 1, [], null),
          items: [
            {
              position: malformedCase.positions[0],
              item_type: 'local',
              ds_id: 'ds:8888888888888888',
              path: canonicalPath,
              size: 31,
              mtime_ns: '1700000000000000000',
              device: '7',
              inode: '88',
              source_status: 'available',
              sidecar_caption: null,
            },
            {
              position: malformedCase.positions[1],
              item_type: 'library',
              source_image_id: 101,
              image_id: 101,
              missing: false,
            },
          ],
        },
      })
    })
    await openDataset(page)
    const original = await page.evaluate(({ path }) => {
      const dm = (window as any).DatasetMaker
      dm.addLocalItems([{
        ds_id: 'ds:1111111111111111',
        abs_path: path,
        filename: path.split('/').pop(),
        width: 512,
        height: 512,
        mtime: 1700000000,
        size: 31,
        source_kind: 'upload',
        sidecar_capability: 'beside_image',
      }], { switchView: false, showToast: false, focusImportTab: false })
      dm.imageIds.push(101)
      dm.meta.set(101, { filename: 'library-101.png' })
      const originalId = dm.imageIds[0]
      const reconcile = dm._applySavedProjectLocalIdentities.bind(dm)
      dm._positionValidationReconcileCalls = 0
      dm._applySavedProjectLocalIdentities = function (items: unknown[]) {
        dm._positionValidationReconcileCalls += 1
        return reconcile(items)
      }
      return { originalId, originalPath: dm.localItemPaths.get(originalId) }
    }, { path: logicalPath })

    await page.getByTestId('dataset-project-save-as').click()
    await submitInputModal(page, `Malformed ${malformedCase.name}`)

    await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'error')
    const state = await page.evaluate(({ originalId }) => {
      const dm = (window as any).DatasetMaker
      return {
        activeProject: dm._activeProject,
        reconcileCalls: dm._positionValidationReconcileCalls,
        imageIds: dm.imageIds,
        oldPath: dm.localItemPaths.get(originalId),
      }
    }, { originalId: original.originalId })
    expect(state).toEqual({
      activeProject: null,
      reconcileCalls: 0,
      imageIds: [original.originalId, 101],
      oldPath: original.originalPath,
    })
  })
}

test('Save As rejects a non-empty manifest whose queue anchor was removed', async ({ page }) => {
  let createCount = 0
  let scanCount = 0
  await page.route('**/api/dataset/folder-scan', (route) => {
    scanCount += 1
    return route.fulfill({ status: 500, json: { detail: 'must not scan' } })
  })
  await page.route('**/api/dataset/projects', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { projects: [] } })
    }
    createCount += 1
    return route.fulfill({ status: 500, json: { detail: 'must not write' } })
  })
  await openDataset(page)
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.localManifestTokens.set('anchorless-project-token', {
      scan_token: 'anchorless-project-token',
      folder_path: 'C:/dataset/anchorless',
      total: 1,
      queueIndex: 0,
      excludedPaths: new Set(),
    })
  })

  await page.getByTestId('dataset-project-save-as').click()
  await submitInputModal(page, 'Anchorless manifest')

  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'error')
  expect(scanCount).toBe(0)
  expect(createCount).toBe(0)
})

test('Save As preserves a queue mutation that races manifest materialization', async ({ page }) => {
  let createCount = 0
  let releaseScan!: () => void
  let markScanRequested!: () => void
  const scanRelease = new Promise<void>((resolve) => { releaseScan = resolve })
  const scanRequested = new Promise<void>((resolve) => { markScanRequested = resolve })
  const firstPath = 'C:/dataset/race/001.png'
  const secondPath = 'C:/dataset/race/002.png'
  await page.route('**/api/dataset/folder-scan', async (route) => {
    markScanRequested()
    await scanRelease
    return route.fulfill({
      json: {
        folder_path: 'C:/dataset/race',
        scan_token: 'racing-project-token',
        total_files_seen: 2,
        offset: 0,
        next_offset: null,
        has_more: false,
        items: [firstPath, secondPath].map((path, index) => ({
          ds_id: `ds:${String(index + 1).repeat(16)}`,
          abs_path: path,
          filename: `${String(index + 1).padStart(3, '0')}.png`,
          width: 0,
          height: 0,
          mtime: 1700000000,
          size: 20 + index,
          thumb_b64: '',
          scan_index: index,
          source_kind: 'folder_path',
          sidecar_capability: 'beside_image',
        })),
      },
    })
  })
  await page.route('**/api/dataset/projects', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { projects: [] } })
    }
    createCount += 1
    return route.fulfill({ status: 500, json: { detail: 'must not write' } })
  })
  await openDataset(page)
  await page.evaluate(({ first }) => {
    const dm = (window as any).DatasetMaker
    dm.localManifestTokens.set('racing-project-token', {
      scan_token: 'racing-project-token',
      folder_path: 'C:/dataset/race',
      total: 2,
      queueIndex: 0,
      excludedPaths: new Set(),
    })
    dm.addLocalItems([{
      ds_id: 'ds:1111111111111111',
      abs_path: first,
      filename: '001.png',
      width: 0,
      height: 0,
      mtime: 1700000000,
      size: 20,
      scan_index: 0,
      folder_scan_token: 'racing-project-token',
      source_kind: 'folder_path',
      sidecar_capability: 'beside_image',
    }], { switchView: false, showToast: false, focusImportTab: false })
  }, { first: firstPath })

  await page.getByTestId('dataset-project-save-as').click()
  await submitInputModal(page, 'Racing manifest')
  await scanRequested
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds.push(102)
    dm.meta.set(102, { filename: 'library-102.png' })
  })
  releaseScan()

  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'error')
  expect(createCount).toBe(0)
  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return dm.imageIds.map((id: number) => (
      id < 0 ? dm.localItemPaths.get(id) : id
    ))
  })).toEqual([firstPath, 102])
})

test('Save As atomically rekeys a canonical local identity and its browser drafts', async ({ page }) => {
  const logicalPath = 'C:/dataset/link.png'
  const canonicalPath = 'C:/dataset/real/source.png'
  const canonicalItem: LocalProjectItem = {
    position: 0,
    item_type: 'local',
    ds_id: 'ds:9999999999999999',
    path: canonicalPath,
    size: 41,
    mtime_ns: '1700000000000000000',
    device: '7',
    inode: '88',
    source_status: 'available',
    sidecar_caption: null,
  }
  await page.route('**/api/dataset/projects', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { projects: [] } })
    }
    return route.fulfill({
      status: 201,
      json: {
        ...project(76, 'Canonical source', 1, [], null),
        items: [canonicalItem],
      },
    })
  })
  await openDataset(page)
  const originalId = await page.evaluate(({ path }) => {
    const dm = (window as any).DatasetMaker
    dm.addLocalItems([{
      ds_id: 'ds:1111111111111111',
      abs_path: path,
      filename: 'link.png',
      width: 512,
      height: 512,
      mtime: 1700000000,
      size: 41,
      source_kind: 'folder_path',
      sidecar_capability: 'beside_image',
    }], { switchView: false, showToast: false, focusImportTab: false })
    const id = dm.imageIds[0]
    dm.meta.set(id, {
      ...dm.meta.get(id),
      review_marker: 'preserved metadata',
    })
    dm.captions.set(id, 'canonical base caption')
    dm.captionEdits.set(id, 'Canonical_Token, canonical caption draft')
    dm.nlCaptions.set(id, 'canonical base natural language')
    dm.nlEdits.set(id, 'canonical natural language draft')
    dm.captionType.set(id, 'both')
    dm._undoStacks.set(id, [{ field: 'caption', before: 'before', after: 'after' }])
    dm._queueSelection.add(id)
    dm.activeId = id
    dm._lastClickedId = id
    dm._quickfilledTrigger = 'Canonical_Token'
    ;(document.getElementById('dataset-trigger') as HTMLInputElement).value = 'Canonical_Token'
    dm._saveManagedTriggerForLocalIds([id], 'Canonical_Token', null)
    const captionKey = 'sd-image-sorter-dataset-local-captions'
    const originalSetItem = Storage.prototype.setItem
    let captionWriteCount = 0
    ;(window as any).__canonicalCaptionWriteCount = () => captionWriteCount
    ;(window as any).__restoreCanonicalStorage = () => {
      Storage.prototype.setItem = originalSetItem
    }
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === captionKey) {
        captionWriteCount += 1
        if (captionWriteCount === 2) {
          throw new DOMException('unexpected second caption write', 'QuotaExceededError')
        }
      }
      return originalSetItem.call(this, key, value)
    }
    dm._renderQueue()
    return id
  }, { path: logicalPath })

  await page.getByTestId('dataset-project-save-as').click()
  await submitInputModal(page, 'Canonical source')
  await expect(page.locator('#confirm-message')).toContainText('browser draft')
  await acceptConfirm(page)
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'saved')

  const canonicalState = await page.evaluate(({ oldId, oldPath, newPath }) => {
    const dm = (window as any).DatasetMaker
    const newId = dm.imageIds[0]
    const draft = JSON.parse(
      localStorage.getItem('sd-image-sorter-dataset-project-session-76-r1') || '{}',
    )
    const localCaptions = JSON.parse(
      localStorage.getItem('sd-image-sorter-dataset-local-captions') || '{}',
    )
    const localCaptionTriggers = JSON.parse(
      localStorage.getItem('sd-image-sorter-dataset-local-caption-triggers') || '{}',
    )
    const captionWriteCount = (window as any).__canonicalCaptionWriteCount()
    ;(window as any).__restoreCanonicalStorage()
    delete (window as any).__canonicalCaptionWriteCount
    delete (window as any).__restoreCanonicalStorage
    return {
      oldId,
      newId,
      path: dm.localItemPaths.get(newId),
      oldPathPresent: Array.from(dm.localItemPaths.values()).includes(oldPath),
      dsId: dm.localItemDsIds.get(newId),
      meta: dm.meta.get(newId),
      baseCaption: dm.captions.get(newId),
      captionEdit: dm.captionEdits.get(newId),
      baseNl: dm.nlCaptions.get(newId),
      nlEdit: dm.nlEdits.get(newId),
      captionType: dm.captionType.get(newId),
      undoStack: dm._undoStacks.get(newId),
      selected: dm._queueSelection.has(newId),
      activeId: dm.activeId,
      lastClickedId: dm._lastClickedId,
      oldKeysPresent: {
        localPath: dm.localItemPaths.has(oldId),
        dsId: dm.localItemDsIds.has(oldId),
        meta: dm.meta.has(oldId),
        baseCaption: dm.captions.has(oldId),
        captionEdit: dm.captionEdits.has(oldId),
        baseNl: dm.nlCaptions.has(oldId),
        nlEdit: dm.nlEdits.has(oldId),
        captionType: dm.captionType.has(oldId),
        undoStack: dm._undoStacks.has(oldId),
        selected: dm._queueSelection.has(oldId),
      },
      draftCaption: draft.captionEdits?.[String(newId)],
      draftOldCaption: draft.captionEdits?.[String(oldId)],
      draftNl: draft.nlEdits?.[String(newId)],
      draftOldNl: draft.nlEdits?.[String(oldId)],
      draftCaptionType: draft.captionType?.[String(newId)],
      draftOldCaptionType: draft.captionType?.[String(oldId)],
      localCaption: localCaptions[newPath],
      localOldCaption: localCaptions[oldPath],
      localCaptionTrigger: localCaptionTriggers[newPath],
      localOldCaptionTrigger: localCaptionTriggers[oldPath],
      captionWriteCount,
      queueDirty: dm._projectDraftDetails().includes('Project queue changes'),
      queueDomIds: Array.from(
        document.querySelectorAll('#dataset-queue-list .dataset-queue-item'),
      ).map((node) => Number((node as HTMLElement).dataset.imageId)),
    }
  }, { oldId: originalId, oldPath: logicalPath, newPath: canonicalPath })
  expect(canonicalState.newId).toBeLessThan(0)
  expect(canonicalState.newId).not.toBe(originalId)
  expect(canonicalState).toMatchObject({
    path: canonicalPath,
    oldPathPresent: false,
    dsId: canonicalItem.ds_id,
    meta: {
      review_marker: 'preserved metadata',
      source: 'local',
      ds_id: canonicalItem.ds_id,
      abs_path: canonicalPath,
      filename: 'source.png',
      width: 512,
      height: 512,
      size: canonicalItem.size,
      mtime_ns: canonicalItem.mtime_ns,
      source_device: canonicalItem.device,
      source_inode: canonicalItem.inode,
      source_kind: 'project_local',
      sidecar_capability: 'beside_image',
    },
    baseCaption: 'canonical base caption',
    captionEdit: 'Canonical_Token, canonical caption draft',
    baseNl: 'canonical base natural language',
    nlEdit: 'canonical natural language draft',
    captionType: 'both',
    undoStack: [{ field: 'caption', before: 'before', after: 'after' }],
    selected: true,
    activeId: canonicalState.newId,
    lastClickedId: canonicalState.newId,
    oldKeysPresent: {
      localPath: false,
      dsId: false,
      meta: false,
      baseCaption: false,
      captionEdit: false,
      baseNl: false,
      nlEdit: false,
      captionType: false,
      undoStack: false,
      selected: false,
    },
    draftCaption: 'Canonical_Token, canonical caption draft',
    draftOldCaption: undefined,
    draftNl: 'canonical natural language draft',
    draftOldNl: undefined,
    draftCaptionType: 'both',
    draftOldCaptionType: undefined,
    localCaption: 'Canonical_Token, canonical caption draft',
    localOldCaption: undefined,
    localCaptionTrigger: 'Canonical_Token',
    localOldCaptionTrigger: undefined,
    captionWriteCount: 1,
    queueDirty: false,
    queueDomIds: [canonicalState.newId],
  })
})

test('loading a mixed project restores only identity-matched local sources and shows source issues', async ({ page }) => {
  const availablePath = 'C:/dataset/available.png'
  const stored: DatasetProject = {
    ...project(72, 'Identity checked', 3, [], null),
    items: [
      {
        position: 0,
        item_type: 'local',
        ds_id: 'ds:2222222222222222',
        path: availablePath,
        size: 31,
        mtime_ns: '1700000000000000000',
        device: '4',
        inode: '8',
        source_status: 'available',
        sidecar_caption: null,
      },
      {
        position: 1,
        item_type: 'local',
        ds_id: 'ds:3333333333333333',
        path: 'C:/dataset/missing.png',
        size: 19,
        mtime_ns: '1700000000000000100',
        device: '4',
        inode: '9',
        source_status: 'missing',
        sidecar_caption: null,
      },
      {
        position: 2,
        item_type: 'library',
        source_image_id: 202,
        image_id: 202,
        missing: false,
      },
      {
        position: 3,
        item_type: 'local',
        ds_id: 'ds:4444444444444444',
        path: 'C:/dataset/replaced.png',
        size: 23,
        mtime_ns: '1700000000000000200',
        device: '4',
        inode: '10',
        source_status: 'changed',
        sidecar_caption: null,
      },
    ],
  }
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [projectSummary(stored)] },
  }))
  await page.route('**/api/dataset/projects/72', (route) => route.fulfill({ json: stored }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await openDataset(page)

  await page.getByTestId('dataset-project-selector').selectOption('72')

  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'loaded')
  await expect(page.getByTestId('dataset-project-missing')).toBeVisible()
  await expect(page.getByTestId('dataset-project-missing')).toContainText('missing.png')
  await expect(page.getByTestId('dataset-project-missing')).toContainText('replaced.png')
  const restored = await page.evaluate(({ path }) => {
    const dm = (window as any).DatasetMaker
    const localIds = dm.imageIds.filter((id: number) => id < 0)
    return {
      imageIds: dm.imageIds,
      localPaths: localIds.map((id: number) => dm.localItemPaths.get(id)),
      availableMeta: localIds.map((id: number) => dm.meta.get(id)),
      unresolvedCount: dm._projectMissingItems.length,
      expectedPath: path,
    }
  }, { path: availablePath })
  expect(restored.imageIds).toHaveLength(2)
  expect(restored.imageIds[1]).toBe(202)
  expect(restored.localPaths).toEqual([availablePath])
  expect(restored.availableMeta[0]).toMatchObject({
    source: 'local',
    abs_path: availablePath,
    filename: 'available.png',
    size: 31,
  })
  expect(restored.unresolvedCount).toBe(2)
})

test('loading rejects malformed local identity fields instead of restoring an ambiguous source', async ({ page }) => {
  const malformed = project(73, 'Malformed local identity', 1, [], null)
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [projectSummary(malformed)] },
  }))
  await page.route('**/api/dataset/projects/73', (route) => route.fulfill({
    json: {
      ...malformed,
      items: [{
        position: 0,
        item_type: 'local',
        ds_id: 'ds:5555555555555555',
        path: 'C:/dataset/ambiguous.png',
        size: 20,
        mtime_ns: 1_700_000_000_000_000_000,
        device: '4',
        inode: '11',
        source_status: 'available',
        sidecar_caption: null,
      }],
    },
  }))
  await openDataset(page)

  await page.getByTestId('dataset-project-selector').selectOption('73')

  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'error')
  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      activeProject: dm._activeProject,
      localPaths: Array.from(dm.localItemPaths.values()),
    }
  })).toEqual({ activeProject: null, localPaths: [] })
})

test('a same-revision browser draft cannot rebind a local source rejected by backend identity', async ({ page }) => {
  const changedPath = 'C:/dataset/changed-since-draft.png'
  await page.addInitScript(({ path }) => {
    localStorage.setItem('sd-image-sorter-dataset-project-session-74-r5', JSON.stringify({
      imageIds: [-77],
      captionEdits: { '-77': 'preserved draft caption' },
      nlEdits: {},
      captionType: {},
      activeId: -77,
      local: {
        localItems: [{
          id: -77,
          abs_path: path,
          ds_id: 'project-local:old-identity',
          meta: {
            source: 'local',
            abs_path: path,
            filename: 'changed-since-draft.png',
            size: 10,
          },
        }],
        manifests: [],
      },
    }))
  }, { path: changedPath })
  const stored: DatasetProject = {
    ...project(74, 'Draft identity guard', 5, [], null),
    items: [{
      position: 0,
      item_type: 'local',
      ds_id: 'ds:6666666666666666',
      path: changedPath,
      size: 10,
      mtime_ns: '1700000000000000000',
      device: '5',
      inode: '12',
      source_status: 'changed',
      sidecar_caption: null,
    }],
  }
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [projectSummary(stored)] },
  }))
  await page.route('**/api/dataset/projects/74', (route) => route.fulfill({ json: stored }))
  await openDataset(page)

  await page.getByTestId('dataset-project-selector').selectOption('74')

  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'loaded')
  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      imageIds: dm.imageIds,
      localPaths: Array.from(dm.localItemPaths.values()),
      preservedCaption: dm.captionEdits.get(-77),
    }
  })).toEqual({
    imageIds: [],
    localPaths: [],
    preservedCaption: 'preserved draft caption',
  })
})

test('Save sends expected_revision and a 409 leaves the loaded revision unchanged', async ({ page }) => {
  let updateBody: Record<string, unknown> | null = null
  const current = project(9, 'Current project', 2, [{
    position: 0,
    source_image_id: 101,
    image_id: 101,
    missing: false,
  }], null)
  await page.route('**/api/dataset/projects', (route) =>
    route.fulfill({ json: { projects: [projectSummary(current)] } }))
  await page.route('**/api/dataset/projects/9', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: current })
    updateBody = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({
      status: 409,
      json: {
        detail: {
          code: 'dataset_project_revision_conflict',
          message: 'Dataset project changed since it was loaded. Reload it before saving.',
          project_id: 9,
          expected_revision: 2,
          current_revision: 3,
        },
      },
    })
  })
  await openDataset(page)
  await page.getByTestId('dataset-project-selector').selectOption('9')
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'loaded')
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#dataset-trigger').fill('conflict_token')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [101, 102]
    dm.meta.set(102, { filename: 'library-102.png' })
    dm._renderQueue()
  })

  await page.getByTestId('dataset-project-save').click()

  await expect.poll(() => updateBody).toEqual({
    name: 'Current project',
    items: [
      { item_type: 'library', image_id: 101 },
      { item_type: 'library', image_id: 102 },
    ],
    settings: projectSettingsFor('', 'conflict_token', ''),
    expected_revision: 2,
  })
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'conflict')
  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    const draft = JSON.parse(
      localStorage.getItem('sd-image-sorter-dataset-project-session-9-r2') || '{}',
    )
    return {
      revision: dm._activeProject.revision,
      savedTrigger: dm._activeProject.settings.caption_render.trigger,
      localTrigger: (document.getElementById('dataset-trigger') as HTMLInputElement).value,
      draftTrigger: draft.settings?.caption_render?.trigger,
    }
  })).toEqual({
    revision: 2,
    savedTrigger: '',
    localTrigger: 'conflict_token',
    draftTrigger: 'conflict_token',
  })
})

test('loading over a dirty browser draft requires confirmation and exposes missing sources', async ({ page }) => {
  let readCount = 0
  const unsavedDraft = JSON.stringify({
    imageIds: [101],
    captionEdits: { 101: 'unsaved draft edit' },
    nlEdits: {},
    captionType: {},
    activeId: 101,
    local: null,
  })
  await page.addInitScript((payload) => {
    localStorage.setItem('sd-image-sorter-dataset-session', payload)
  }, unsavedDraft)
  const stored = project(12, 'Stored queue', 4, [
    { position: 0, source_image_id: 202, image_id: 202, missing: false },
    { position: 1, source_image_id: 999, image_id: null, missing: true },
  ], null)
  await page.route('**/api/dataset/projects', (route) =>
    route.fulfill({ json: { projects: [projectSummary(stored)] } }))
  await page.route('**/api/dataset/projects/12', (route) => {
    readCount += 1
    return route.fulfill({ json: stored })
  })
  await openDataset(page)

  await page.getByTestId('dataset-project-selector').selectOption('12')
  await expect(page.locator('#confirm-message')).toContainText('replace')
  expect(readCount).toBe(0)
  await acceptConfirm(page)

  await expect.poll(() => readCount).toBe(1)
  await expect(page.getByTestId('dataset-project-missing')).toBeVisible()
  await expect(page.getByTestId('dataset-project-missing')).toContainText('#999')
  expect(await page.evaluate(() => (window as any).DatasetMaker.imageIds)).toEqual([202])
  expect(await page.evaluate(() => (window as any).DatasetMaker.captionEdits.size)).toBe(0)
  expect(await page.evaluate(() => localStorage.getItem('sd-image-sorter-dataset-session'))).toBe(unsavedDraft)

  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.captionEdits.set(202, 'project browser-only edit')
  })
  await expect.poll(() => page.evaluate(() => {
    const saved = localStorage.getItem('sd-image-sorter-dataset-project-session-12-r4')
    if (!saved) return null
    return JSON.parse(saved).captionEdits['202']
  })).toBe('project browser-only edit')
  expect(await page.evaluate(() => localStorage.getItem('sd-image-sorter-dataset-session'))).toBe(unsavedDraft)

  await page.getByTestId('dataset-project-selector').selectOption('')
  await expect(page.locator('#confirm-message')).toContainText('replace')
  await acceptConfirm(page)
  await expect(page.getByTestId('dataset-project-selector')).toHaveValue('')
  expect(await page.evaluate(() => (window as any).DatasetMaker.imageIds)).toEqual([101])
  expect(await page.evaluate(() => (window as any).DatasetMaker.captionEdits.get(101))).toBe('unsaved draft edit')
})

test('pending Natural Language input is flushed before switching projects', async ({ page }) => {
  const first = project(41, 'First project', 1, [{
    position: 0,
    source_image_id: 202,
    image_id: 202,
    missing: false,
  }], null)
  const second = project(42, 'Second project', 1, [{
    position: 0,
    source_image_id: 202,
    image_id: 202,
    missing: false,
  }], null)
  await page.route('**/api/dataset/projects', (route) => route.fulfill({
    json: { projects: [projectSummary(first), projectSummary(second)] },
  }))
  await page.route(/\/api\/dataset\/projects\/(?:41|42)$/, (route) => {
    const projectId = Number(new URL(route.request().url()).pathname.split('/').pop())
    return route.fulfill({ json: projectId === first.id ? first : second })
  })
  await openDataset(page)
  await page.getByTestId('dataset-project-selector').selectOption('41')
  await expect(page.getByTestId('dataset-project-status')).toHaveAttribute('data-state', 'loaded')
  await page.locator('#dataset-tab-workbench').click()
  await expect(page.locator('#dataset-editor-nl')).toBeVisible()

  await page.locator('#dataset-editor-nl').fill('pending project A sentence')
  await page.getByTestId('dataset-project-selector').selectOption('42')

  await expect(page.locator('#confirm-message')).toContainText('caption')
  await acceptConfirm(page)
  await expect(page.getByTestId('dataset-project-selector')).toHaveValue('42')
  await expect.poll(() => page.evaluate(() => {
    const saved = localStorage.getItem('sd-image-sorter-dataset-project-session-41-r1')
    if (!saved) return null
    return JSON.parse(saved).nlEdits['202']
  })).toBe('pending project A sentence')
  expect(await page.evaluate(() => (window as any).DatasetMaker.nlEdits.has(202))).toBe(false)
})

test('project lifecycle migrates revision drafts and restores the unsaved Library queue', async ({ page }) => {
    const requests: Array<{ path: string, body: Record<string, unknown> }> = []
    await page.addInitScript(() => {
      localStorage.setItem('sd-image-sorter-dataset-session', JSON.stringify({
        imageIds: [401],
        captionEdits: {},
        nlEdits: {},
        captionType: {},
        activeId: 401,
        local: null,
      }))
    })
    let current = project(31, 'Lifecycle project', 1, [{
    position: 0,
    source_image_id: 301,
    image_id: 301,
    missing: false,
  }], null)
  const waitForAnnotationHeads = async (revision: number) => {
    await expect.poll(() => page.evaluate(() => {
      const dm = (window as any).DatasetMaker
      return {
        status: dm._annotationHeadsStatus,
        owner: dm._annotationHeadsOwner,
      }
    })).toEqual({
      status: 'ready',
      owner: { project_id: 31, project_revision: revision },
    })
  }
  await page.route('**/api/dataset/projects', (route) =>
    route.fulfill({ json: { projects: [projectSummary(current)] } }))
  await page.route('**/api/dataset/projects/31/**', (route) => {
    const path = new URL(route.request().url()).pathname
    const body = route.request().postDataJSON() as Record<string, unknown>
    requests.push({ path, body })
    if (path.endsWith('/archive')) {
      current = project(31, current.name, 2, current.items, NOW)
      return route.fulfill({ json: current })
    }
    current = project(31, current.name, 3, current.items, null)
    return route.fulfill({ json: current })
  })
  await page.route('**/api/dataset/projects/31', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: current })
    requests.push({
      path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON() as Record<string, unknown>,
    })
    return route.fulfill({ json: { deleted: true, project_id: 31 } })
  })
  await openDataset(page)
  await page.getByTestId('dataset-project-selector').selectOption('31')
  await expect(page.locator('#confirm-message')).toContainText('Project queue changes')
  await acceptConfirm(page)
  await expect.poll(() => page.evaluate(() => (
    localStorage.getItem('sd-image-sorter-dataset-project-session-31-r1')
  ))).not.toBeNull()

  await page.getByTestId('dataset-project-menu').click()
  await page.getByTestId('dataset-project-archive').click()
  await acceptConfirm(page)
  await expect(page.getByTestId('dataset-project-restore')).toBeEnabled()
  await waitForAnnotationHeads(2)
  await expect.poll(() => page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      owner: dm._annotationHeadsOwner,
      selection: dm._buildExportPayload().annotation_selections['301'],
    }
  })).toEqual({
    owner: { project_id: 31, project_revision: 2 },
    selection: { kind: 'dynamic_source' },
  })
  expect(await page.evaluate(() => (
    localStorage.getItem('sd-image-sorter-dataset-project-session-31-r1')
  ))).toBeNull()
  expect(await page.evaluate(() => (
    localStorage.getItem('sd-image-sorter-dataset-project-session-31-r2')
  ))).not.toBeNull()

  await page.getByTestId('dataset-project-menu').click()
  await page.getByTestId('dataset-project-restore').click()
  await expect(page.getByTestId('dataset-project-archive')).toBeEnabled()
  await waitForAnnotationHeads(3)
  await expect.poll(() => page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      owner: dm._annotationHeadsOwner,
      selection: dm._buildExportPayload().annotation_selections['301'],
    }
  })).toEqual({
    owner: { project_id: 31, project_revision: 3 },
    selection: { kind: 'dynamic_source' },
  })
  expect(await page.evaluate(() => (
    localStorage.getItem('sd-image-sorter-dataset-project-session-31-r2')
  ))).toBeNull()
  expect(await page.evaluate(() => (
    localStorage.getItem('sd-image-sorter-dataset-project-session-31-r3')
  ))).not.toBeNull()

  await page.getByTestId('dataset-project-menu').click()
  await page.getByTestId('dataset-project-delete').click()
  await acceptConfirm(page)
  await expect(page.getByTestId('dataset-project-selector')).toHaveValue('')

  expect(requests).toEqual([
    { path: '/api/dataset/projects/31/archive', body: { expected_revision: 1 } },
    { path: '/api/dataset/projects/31/restore', body: { expected_revision: 2 } },
    { path: '/api/dataset/projects/31', body: { expected_revision: 3 } },
  ])
  expect(await page.evaluate(() => (window as any).DatasetMaker.imageIds)).toEqual([401])
  expect(await page.evaluate(() => (
    localStorage.getItem('sd-image-sorter-dataset-project-session-31-r3')
  ))).toBeNull()
})

test('training caption version survives project reload and exports by revision ref', async ({ page }) => {
  const stored = project(120, 'Caption ledger', 1, [{
    position: 0,
    source_image_id: 101,
    image_id: 101,
    missing: false,
  }], null)
  let currentHead: AnnotationHead | null = null
  let saveBody: {
    expected_project_revision: number
    expected_head_generation: number
    content: TrainingCaptionContent
  } | null = null
  await openDataset(page)
  await page.route('**/api/annotations/projects/120/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'GET' && path.endsWith('/heads')) {
      return route.fulfill({
        json: {
          project_id: 120,
          items: currentHead === null ? [] : [currentHead],
          has_more: false,
          next_after_subject_id: null,
        },
      })
    }
    if (request.method() === 'POST' && path.endsWith('/revisions')) {
      saveBody = request.postDataJSON() as typeof saveBody
      const revision = annotationRevision(501, 9001, saveBody!.content, null, null)
      currentHead = annotationHead(101, 9001, 1, revision)
      return route.fulfill({ status: 201, json: currentHead })
    }
    return route.fulfill({ status: 404, json: { message: `Unexpected annotation path: ${path}` } })
  })

  await page.evaluate(
    async (value) => (window as any).DatasetMaker._replaceQueueWithProject(value),
    stored,
  )
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#dataset-editor-textarea').fill('saved, blue_hair')
  await expect(page.getByTestId('dataset-annotation-provenance')).toContainText('Frozen draft')
  await page.getByTestId('dataset-save-caption-version').click()
  await expect(page.getByTestId('dataset-annotation-status')).toHaveAttribute('data-state', 'saved')
  await expect(page.getByTestId('dataset-annotation-provenance')).toContainText('Manual save')
  await expect(page.getByTestId('dataset-annotation-provenance')).toContainText('User')

  await page.evaluate(() => (window as any).I18n.setLang('zh-CN'))
  await expect(page.getByTestId('dataset-annotation-provenance')).toContainText('手动保存')
  await expect(page.getByTestId('dataset-annotation-provenance')).toContainText('用户')
  await page.evaluate(() => (window as any).I18n.setLang('en'))

  expect(saveBody).toMatchObject({
    expected_project_revision: 1,
    expected_head_generation: 0,
    content: {
      content_version: 1,
      booru_caption: 'saved, blue_hair',
      nl_caption: 'caption 101',
      caption_type: 'both',
    },
  })
  expect(await page.evaluate(() => (
    (window as any).DatasetMaker._buildExportPayload().annotation_selections['101']
  ))).toEqual({ kind: 'revision_ref', revision_id: 501 })

  await page.evaluate(
    async (value) => (window as any).DatasetMaker._replaceQueueWithProject(value),
    stored,
  )

  await expect(page.locator('#dataset-editor-textarea')).toHaveValue('saved, blue_hair')
  expect(await page.evaluate(() => (
    (window as any).DatasetMaker._buildExportPayload().annotation_selections['101']
  ))).toEqual({ kind: 'revision_ref', revision_id: 501 })
})

test('malformed caption provenance fails closed before it becomes an export selection', async ({ page }) => {
  const stored = project(124, 'Malformed caption provenance', 1, [{
    position: 0,
    source_image_id: 101,
    image_id: 101,
    missing: false,
  }], null)
  const malformedRevision = {
    ...annotationRevision(901, 9201, {
      content_version: 1,
      booru_caption: 'saved, caption',
      nl_caption: 'Saved caption.',
      caption_type: 'both',
    }, null, null),
    provider: ' SmilingWolf',
  }
  await openDataset(page)
  await page.route('**/api/annotations/projects/124/**', (route) => route.fulfill({
    json: {
      project_id: 124,
      items: [annotationHead(101, 9201, 1, malformedRevision)],
      has_more: false,
      next_after_subject_id: null,
    },
  }))

  await page.evaluate(
    async (value) => (window as any).DatasetMaker._replaceQueueWithProject(value),
    stored,
  )
  await page.locator('#dataset-tab-workbench').click()

  await expect(page.getByTestId('dataset-annotation-status')).toHaveAttribute('data-state', 'error')
  await expect(page.getByTestId('dataset-annotation-status')).toContainText('Version history unavailable')
  await expect(page.getByTestId('dataset-save-caption-version')).toBeDisabled()
  await expect(page.getByTestId('dataset-caption-history')).toBeDisabled()
  expect(await page.evaluate(() => ({
    status: (window as any).DatasetMaker._annotationHeadsStatus,
    headCount: (window as any).DatasetMaker.annotationHeads.size,
  }))).toEqual({ status: 'error', headCount: 0 })
})

test('restoring caption history appends a new active revision', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stored = project(121, 'Caption history', 1, [{
    position: 0,
    source_image_id: 101,
    image_id: 101,
    missing: false,
  }], null)
  const firstContent: TrainingCaptionContent = {
    content_version: 1,
    booru_caption: 'version, one',
    nl_caption: 'First sentence.',
    caption_type: 'both',
  }
  const secondContent: TrainingCaptionContent = {
    content_version: 1,
    booru_caption: 'version, two',
    nl_caption: 'Second sentence.',
    caption_type: 'both',
  }
  const first = {
    ...annotationRevision(601, 9002, firstContent, null, null),
    source: 'wd14' as const,
    provider: 'SmilingWolf',
    model: 'wd-swinv2-tagger-v3',
    author_class: 'ai' as const,
  }
  const second = annotationRevision(602, 9002, secondContent, 601, null)
  const revisions = [second, first]
  let currentHead = annotationHead(101, 9002, 2, second)
  let restoreBody: Record<string, unknown> | null = null
  let rejectRestore = false
  let restorePostCount = 0
  await openDataset(page)
  await page.route('**/api/annotations/projects/121/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'GET' && path.endsWith('/heads')) {
      return route.fulfill({
        json: {
          project_id: 121,
          items: [currentHead],
          has_more: false,
          next_after_subject_id: null,
        },
      })
    }
    if (request.method() === 'GET' && path.endsWith('/revisions')) {
      return route.fulfill({
        json: {
          subject_id: 9002,
          revisions,
          has_more: false,
          next_before_revision_id: null,
        },
      })
    }
    if (request.method() === 'POST' && path.endsWith('/restore')) {
      restorePostCount += 1
      restoreBody = request.postDataJSON() as Record<string, unknown>
      if (rejectRestore) {
        return route.fulfill({
          status: 409,
          json: {
            code: 'annotation_head_conflict',
            message: 'Caption head changed elsewhere.',
            expected_generation: 3,
            current_generation: 4,
          },
        })
      }
      const restored = annotationRevision(603, 9002, firstContent, 602, 601)
      revisions.unshift(restored)
      currentHead = annotationHead(101, 9002, 3, restored)
      return route.fulfill({ status: 201, json: currentHead })
    }
    return route.fulfill({ status: 404, json: { message: `Unexpected annotation path: ${path}` } })
  })

  await page.evaluate(
    async (value) => (window as any).DatasetMaker._replaceQueueWithProject(value),
    stored,
  )
  await page.locator('#dataset-tab-workbench').click()
  await page.getByTestId('dataset-caption-history').click()
  const wd14Row = page.locator(
    '[data-testid="dataset-annotation-history-row"][data-revision-id="601"]',
  )
  await expect(wd14Row).toContainText('WD14')
  await expect(wd14Row).toContainText('SmilingWolf')
  await expect(wd14Row).toContainText('wd-swinv2-tagger-v3')
  await expect(wd14Row).toContainText('AI')
  const wd14Meta = wd14Row.locator('.dataset-annotation-history-meta')
  const wd14MetaLayout = await wd14Meta.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      clippedHorizontally: element.scrollWidth > element.clientWidth + 1,
      clippedVertically: element.scrollHeight > element.clientHeight + 1,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      whiteSpace: style.whiteSpace,
    }
  })
  expect(wd14MetaLayout).toEqual({
    clippedHorizontally: false,
    clippedVertically: false,
    overflowX: 'visible',
    overflowY: 'visible',
    whiteSpace: 'normal',
  })
  await page.getByTestId('dataset-annotation-restore-601').click()
  await acceptConfirm(page)

  await expect(page.getByTestId('dataset-annotation-status')).toContainText('603')
  await expect(page.getByTestId('dataset-annotation-provenance')).toContainText('Restored from #601')
  await expect(page.getByTestId('dataset-annotation-provenance')).toContainText('User')
  await expect(page.locator('#dataset-editor-textarea')).toHaveValue('version, one')
  expect(restoreBody).toEqual({
    expected_project_revision: 1,
    expected_head_generation: 2,
    revision_id: 601,
  })
  expect(await page.evaluate(() => (
    (window as any).DatasetMaker._buildExportPayload().annotation_selections['101']
  ))).toEqual({ kind: 'revision_ref', revision_id: 603 })

  const beforeConflict = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm._saveSession()
    return {
      head: dm.annotationHeads.get(101),
      textarea: (document.querySelector('#dataset-editor-textarea') as HTMLTextAreaElement).value,
      storage: localStorage.getItem('sd-image-sorter-dataset-project-session-121-r1'),
    }
  })
  rejectRestore = true
  await page.getByTestId('dataset-annotation-restore-602').click()
  await acceptConfirm(page)
  await expect(page.getByTestId('dataset-annotation-status')).toHaveAttribute('data-state', 'conflict')
  await page.evaluate(() => (window as any).I18n.setLang('zh-CN'))
  await expect(page.getByTestId('dataset-annotation-status')).toHaveAttribute('data-state', 'conflict')
  await expect(page.getByTestId('dataset-annotation-status')).toContainText('此 caption 已在其他位置改变')
  await expect(page.getByTestId('dataset-annotation-provenance')).toContainText('从 #601 恢复')
  await expect(page.getByTestId('dataset-annotation-provenance')).toContainText('用户')
  const restoredHistoryRow = page.locator(
    '[data-testid="dataset-annotation-history-row"][data-revision-id="603"]',
  )
  await expect(restoredHistoryRow).toContainText('版本来源：从 #601 恢复')
  await expect(restoredHistoryRow).toContainText('作者：用户')
  const afterConflict = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      head: dm.annotationHeads.get(101),
      textarea: (document.querySelector('#dataset-editor-textarea') as HTMLTextAreaElement).value,
      storage: localStorage.getItem('sd-image-sorter-dataset-project-session-121-r1'),
    }
  })
  expect(restorePostCount).toBe(2)
  expect(afterConflict).toEqual(beforeConflict)
})

test('stale caption save keeps draft maps DOM and storage unchanged without retry', async ({ page }) => {
  const stored = project(122, 'Caption conflict', 1, [{
    position: 0,
    source_image_id: 101,
    image_id: 101,
    missing: false,
  }], null)
  const savedContent: TrainingCaptionContent = {
    content_version: 1,
    booru_caption: 'server, saved',
    nl_caption: 'Server sentence.',
    caption_type: 'both',
  }
  const currentHead = annotationHead(
    101,
    9003,
    1,
    annotationRevision(701, 9003, savedContent, null, null),
  )
  let postCount = 0
  await openDataset(page)
  await page.route('**/api/annotations/projects/122/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'GET' && path.endsWith('/heads')) {
      return route.fulfill({
        json: {
          project_id: 122,
          items: [currentHead],
          has_more: false,
          next_after_subject_id: null,
        },
      })
    }
    if (request.method() === 'POST' && path.endsWith('/revisions')) {
      postCount += 1
      return route.fulfill({
        status: 409,
        json: {
          code: 'annotation_head_conflict',
          message: 'Caption head changed elsewhere.',
          expected_generation: 1,
          current_generation: 2,
        },
      })
    }
    return route.fulfill({ status: 404, json: { message: `Unexpected annotation path: ${path}` } })
  })

  await page.evaluate(
    async (value) => (window as any).DatasetMaker._replaceQueueWithProject(value),
    stored,
  )
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#dataset-editor-textarea').fill('local, unsaved, draft')
  const before = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm._flushPendingDatasetEdits()
    dm._saveSession()
    return {
      captionEdits: Array.from(dm.captionEdits.entries()),
      nlEdits: Array.from(dm.nlEdits.entries()),
      captionType: Array.from(dm.captionType.entries()),
      textarea: (document.querySelector('#dataset-editor-textarea') as HTMLTextAreaElement).value,
      storage: localStorage.getItem('sd-image-sorter-dataset-project-session-122-r1'),
    }
  })

  await page.getByTestId('dataset-save-caption-version').click()
  await expect(page.getByTestId('dataset-annotation-status')).toHaveAttribute('data-state', 'conflict')
  const after = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      captionEdits: Array.from(dm.captionEdits.entries()),
      nlEdits: Array.from(dm.nlEdits.entries()),
      captionType: Array.from(dm.captionType.entries()),
      textarea: (document.querySelector('#dataset-editor-textarea') as HTMLTextAreaElement).value,
      storage: localStorage.getItem('sd-image-sorter-dataset-project-session-122-r1'),
    }
  })

  expect(postCount).toBe(1)
  expect(after).toEqual(before)
})

test('mixed Library local heads do not survive a changed local source identity', async ({ page }) => {
  const localPath = 'C:\\dataset\\mixed-local.png'
  const available = project(123, 'Mixed captions', 1, [
    {
      position: 0,
      source_image_id: 101,
      image_id: 101,
      missing: false,
    },
    {
      position: 1,
      item_type: 'local',
      ds_id: 'ds:1234567890abcdef',
      path: localPath,
      size: 100,
      mtime_ns: '200',
      device: '300',
      inode: '400',
      source_status: 'available',
      sidecar_caption: null,
    },
  ], null)
  const changed: DatasetProject = {
    ...available,
    items: [
      available.items[0],
      { ...(available.items[1] as LocalProjectItem), source_status: 'changed' as const },
    ],
  }
  const libraryRevision = annotationRevision(801, 9101, {
    content_version: 1,
    booru_caption: 'library, saved',
    nl_caption: 'Library sentence.',
    caption_type: 'both',
  }, null, null)
  const localRevision = annotationRevision(802, 9102, {
    content_version: 1,
    booru_caption: 'local, saved',
    nl_caption: 'Local sentence.',
    caption_type: 'both',
  }, null, null)
  let heads: AnnotationHead[] = [
    annotationHead(101, 9101, 1, libraryRevision),
    localAnnotationHead(localPath, 9102, 1, localRevision),
  ]
  await openDataset(page)
  await page.route('**/api/annotations/projects/123/**', (route) => route.fulfill({
    json: {
      project_id: 123,
      items: heads,
      has_more: false,
      next_after_subject_id: null,
    },
  }))

  await page.evaluate(
    async (value) => (window as any).DatasetMaker._replaceQueueWithProject(value),
    available,
  )
  const availablePayload = await page.evaluate(() => (
    (window as any).DatasetMaker._buildExportPayload()
  ))
  expect(availablePayload.annotation_selections).toEqual({
    '101': { kind: 'revision_ref', revision_id: 801 },
    [localPath]: { kind: 'revision_ref', revision_id: 802 },
  })

  heads = [annotationHead(101, 9101, 1, libraryRevision)]
  await page.evaluate(
    async (value) => (window as any).DatasetMaker._replaceQueueWithProject(value),
    changed,
  )
  const changedState = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      imageIds: [...dm.imageIds],
      annotationHeadIds: [...dm.annotationHeads.keys()],
      selections: dm._buildExportPayload().annotation_selections,
    }
  })
  expect(changedState).toEqual({
    imageIds: [101],
    annotationHeadIds: [101],
    selections: { '101': { kind: 'revision_ref', revision_id: 801 } },
  })
})

test('project controls stay visible and unclipped at supported desktop widths', async ({ page }) => {
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  await page.route('**/api/dataset/projects', (route: Route) =>
    route.fulfill({ json: { projects: [] } }))
  await openDataset(page)
  await page.locator('#dataset-tab-export').click()
  await page.locator('#dataset-step-export .dataset-advanced > summary').click()

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport)
    const expectedScale = viewport.width >= 2350 ? 1.3 : 1
    await expect.poll(() => page.evaluate(() => (window as any).UiScale?.get())).toBe(expectedScale)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const layout = await page.evaluate(() => {
      const header = document.querySelector('#view-dataset .dataset-header')
      const toolbar = document.querySelector('[data-testid="dataset-project-toolbar"]')
      const selector = document.querySelector('[data-testid="dataset-project-selector"]')
      const saveAs = document.querySelector('[data-testid="dataset-project-save-as"]')
      const save = document.querySelector('[data-testid="dataset-project-save"]')
      const navigation = document.querySelector('.nav-bar')
      if (!header || !toolbar || !selector || !saveAs || !save || !navigation) {
        throw new Error('Dataset project toolbar nodes are missing')
      }
      const navigationRect = navigation.getBoundingClientRect()
      const headerRect = header.getBoundingClientRect()
      const toolbarRect = toolbar.getBoundingClientRect()
      const selectorRect = selector.getBoundingClientRect()
      const saveAsRect = saveAs.getBoundingClientRect()
      const saveRect = save.getBoundingClientRect()
      const receivesPointerAtCenter = (element: Element, rect: DOMRect) => {
        const hit = document.elementFromPoint(
          rect.left + (rect.width / 2),
          rect.top + (rect.height / 2),
        )
        return hit === element || Boolean(hit && element.contains(hit))
      }
      return {
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        viewportWidth: window.innerWidth,
        headerLeft: headerRect.left,
        headerRight: headerRect.right,
        toolbarLeft: toolbarRect.left,
        toolbarRight: toolbarRect.right,
        toolbarHeight: toolbarRect.height,
        selectorWidth: selectorRect.width,
        controlsVisible: [selectorRect, saveAsRect, saveRect].every((rect) => (
          rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= window.innerWidth
        )),
        controlsUnoccluded: [
          [selector, selectorRect],
          [saveAs, saveAsRect],
        ].every(([element, rect]) => receivesPointerAtCenter(element as Element, rect as DOMRect)),
        controlsBelowNavigation: [selectorRect, saveAsRect, saveRect].every((rect) => (
          rect.top >= navigationRect.bottom
        )),
      }
    })
    expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
    expect(layout.toolbarLeft).toBeGreaterThanOrEqual(layout.headerLeft)
    expect(layout.toolbarRight).toBeLessThanOrEqual(layout.headerRight + 1)
    expect(layout.toolbarRight).toBeLessThanOrEqual(layout.viewportWidth)
    expect(layout.toolbarHeight).toBeGreaterThan(0)
    expect(layout.selectorWidth).toBeGreaterThanOrEqual(150)
    expect(layout.controlsVisible).toBe(true)
    expect(layout.controlsUnoccluded).toBe(true)
    expect(layout.controlsBelowNavigation).toBe(true)

    await page.locator('#nav-tools-toggle').click()
    const navigationMenuUnoccluded = await page.evaluate(() => {
      const item = document.querySelector('#nav-tools-dup-cleaner')
      if (!item) throw new Error('Navigation More menu item is missing')
      const rect = item.getBoundingClientRect()
      const hit = document.elementFromPoint(
        rect.left + (rect.width / 2),
        rect.top + (rect.height / 2),
      )
      return hit === item || Boolean(hit && item.contains(hit))
    })
    expect(navigationMenuUnoccluded).toBe(true)
    await page.locator('#nav-tools-toggle').click()

    const modalCoverage = await page.evaluate(() => {
      const modal = document.querySelector('#dataset-confirm-modal')
      const navigation = document.querySelector('.nav-bar')
      if (!(modal instanceof HTMLElement) || !navigation) {
        throw new Error('Dataset modal or navigation is missing')
      }
      modal.hidden = false
      const modalRect = modal.getBoundingClientRect()
      const navigationRect = navigation.getBoundingClientRect()
      const hit = document.elementFromPoint(
        navigationRect.left + (navigationRect.width / 2),
        navigationRect.top + (navigationRect.height / 2),
      )
      const result = {
        coversViewport: modalRect.top <= 0 && modalRect.bottom >= window.innerHeight,
        ownsNavigationHit: hit === modal || Boolean(hit && modal.contains(hit)),
      }
      modal.hidden = true
      return result
    })
    expect(modalCoverage.coversViewport).toBe(true)
    expect(modalCoverage.ownsNavigationHit).toBe(true)
  }

  expect(consoleErrors).toEqual([])
  expect(failedResponses).toEqual([])
})
