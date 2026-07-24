import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CHECKER_PATH = REPO_ROOT / "tests" / "e2e" / "scripts" / "desktop-viewport-contract.mjs"
MINIMUM_VIEWPORT_WIDTH = 1280


def _browser_automation_sources() -> list[Path]:
    e2e_root = REPO_ROOT / "tests" / "e2e"
    sources = [
        path
        for pattern in ("*.js", "*.mjs", "*.ts")
        for path in e2e_root.rglob(pattern)
        if "node_modules" not in path.parts
    ]
    sources.extend(
        path
        for path in (REPO_ROOT / "scripts").glob("*.js")
        if "playwright" in path.read_text(encoding="utf-8").lower()
    )
    return sorted(set(sources))


def _run_checker(paths: list[Path]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "node",
            str(CHECKER_PATH),
            "--minimum-width",
            str(MINIMUM_VIEWPORT_WIDTH),
            *(str(path) for path in paths),
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        check=False,
        encoding="utf-8",
        text=True,
    )


def _write_fixture(tmp_path: Path, name: str, source: str) -> Path:
    path = tmp_path / name
    path.write_text(source, encoding="utf-8")
    return path


def test_browser_automation_targets_supported_desktop_widths_only() -> None:
    result = _run_checker(_browser_automation_sources())

    assert result.returncode == 0, result.stdout + result.stderr


def test_checker_rejects_indirect_unsupported_viewports(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "indirect-viewports.spec.ts",
        """
const directViewport = { width: 1024, height: 768 }
page.setViewportSize(directViewport)

for (const viewport of [{ width: 960, height: 720 }]) {
  page.setViewportSize(viewport)
}

const DESKTOP_VIEWPORTS = [{ width: 800, height: 720 }]
function openDesktop(browser, viewport) {
  browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
}
for (const viewport of DESKTOP_VIEWPORTS) {
  openDesktop(browser, viewport)
}

defineConfig({ use: { viewport: { width: 700, height: 700 } } })
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "1024px" in result.stdout
    assert "960px" in result.stdout
    assert "800px" in result.stdout
    assert "700px" in result.stdout


def test_checker_ignores_image_dimensions(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "image-metadata.spec.ts",
        """
const images = [
  { id: 1, filename: 'portrait.png', width: 390, height: 844 },
  { id: 2, filename: 'square.png', width: 1024, height: 1024 },
]
publishImageMetadata(images)
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 0, result.stdout + result.stderr


def test_checker_rejects_unresolved_viewport_widths(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "unresolved-viewport.spec.ts",
        "page.setViewportSize(resolveViewport())\n",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "unresolved viewport width" in result.stdout.lower()


def test_checker_follows_property_call_receivers(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "main-catch-wrapper.js",
        """
async function main() {
  const viewport = { width: 640, height: 480 }
  await page.setViewportSize(viewport)
}

main().catch((error) => console.error(error))
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "640px" in result.stdout


def test_checker_rejects_mobile_playwright_device_presets(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "mobile-device-preset.spec.ts",
        """
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  projects: [{ use: { ...devices['iPhone 13'] } }],
})
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_rejects_unresolved_playwright_device_presets(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "dynamic-device-preset.spec.ts",
        """
import { defineConfig, devices } from '@playwright/test'

const presetName = process.env.PLAYWRIGHT_DEVICE
export default defineConfig({
  projects: [{ use: { ...devices[presetName] } }],
})
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "unresolved viewport width" in result.stdout.lower()


def test_checker_follows_playwright_device_binding_aliases(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "device-binding-alias.spec.ts",
        """
import { devices } from '@playwright/test'

const presets = devices
browser.newContext(presets['iPhone 13'])
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_follows_commonjs_device_binding_aliases(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "commonjs-device-binding-alias.js",
        """
async function main() {
  const { devices: presets } = require('@playwright/test')
  browser.newContext(presets['iPhone 13'])
}

main()
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_respects_shadowed_playwright_device_bindings(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "shadowed-device-binding.spec.ts",
        """
import { devices } from '@playwright/test'

function main() {
  const devices = {
    'Desktop Chrome': { viewport: { width: 390, height: 844 } },
  }
  browser.newContext(devices['Desktop Chrome'])
}

main()
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_follows_playwright_namespace_imports(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "namespace-device-binding.spec.ts",
        """
import * as pw from '@playwright/test'

browser.newContext(pw.devices['iPhone 13'])
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_follows_commonjs_playwright_module_aliases(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "commonjs-module-device-binding.js",
        """
const pw = require('@playwright/test')

browser.newContext(pw.devices['iPhone 13'])
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_follows_hoisted_commonjs_device_bindings(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "hoisted-commonjs-device-binding.js",
        """
function main() {
  if (true) {
    var { devices: presets } = require('@playwright/test')
  }
  browser.newContext(presets['iPhone 13'])
}

main()
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_follows_function_scoped_device_var_aliases(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "function-scoped-device-var.spec.ts",
        """
import { devices } from '@playwright/test'

function main() {
  if (true) {
    var presets = devices
  }
  browser.newContext(presets['iPhone 13'])
}

main()
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_follows_function_scoped_viewport_options(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "function-scoped-viewport-options.js",
        """
function main() {
  if (true) {
    var options = { viewport: { width: 390, height: 844 } }
  }
  browser.newContext(options)
}

main()
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_respects_function_scoped_var_shadowing_playwright_device_binding(
    tmp_path: Path,
) -> None:
    fixture = _write_fixture(
        tmp_path,
        "function-scoped-var-shadow.spec.ts",
        """
import { devices } from '@playwright/test'

function main() {
  if (true) {
    var devices = {
      'Desktop Chrome': { viewport: { width: 390, height: 844 } },
    }
  }
  browser.newContext(devices['Desktop Chrome'])
}

main()
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_resolves_bound_local_viewport_keys(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "bound-local-viewport-key.spec.ts",
        """
const localDevices = {
  phone: { viewport: { width: 390, height: 844 } },
}
const key = 'phone'
browser.newContext(localDevices[key])
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_rejects_unresolved_local_viewport_keys(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "dynamic-local-viewport-key.spec.ts",
        """
const localDevices = {
  phone: { viewport: { width: 390, height: 844 } },
}
const key = process.env.DEVICE
browser.newContext(localDevices[key])
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "unresolved viewport width" in result.stdout.lower()


def test_checker_follows_for_of_object_binding_patterns(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "for-of-object-binding.spec.ts",
        """
for (const { options } of [
  { options: { viewport: { width: 390, height: 844 } } },
]) {
  browser.newContext(options)
}
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_follows_for_of_array_binding_patterns(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "for-of-array-binding.spec.ts",
        """
for (const [options] of [
  [{ viewport: { width: 390, height: 844 } }],
]) {
  browser.newContext(options)
}
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_rejects_unresolved_for_of_binding_patterns(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "unresolved-for-of-binding.spec.ts",
        """
for (const { options } of resolveCases()) {
  browser.newContext(options)
}
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "unresolved viewport width" in result.stdout.lower()


def test_checker_rejects_unresolved_browser_options(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "unresolved-browser-options.spec.ts",
        "browser.newContext(resolveOptions())\n",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "unresolved viewport width" in result.stdout.lower()


def test_checker_rejects_unresolved_define_config_use_options(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "unresolved-define-config.spec.ts",
        """
defineConfig({ use: resolveOptions() })
defineConfig({ use: { ...resolveOptions() } })
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "unresolved viewport width" in result.stdout.lower()


def test_checker_preserves_unknown_overrides_alongside_known_widths(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "unknown-overrides.spec.ts",
        """
browser.newContext({
  viewport: { width: 1440, height: 900 },
  ...resolveOptions(),
})

const options = condition
  ? { viewport: { width: 1440, height: 900 } }
  : resolveOptions()
browser.newContext(options)

defineConfig({
  use: {
    viewport: { width: 1440, height: 900 },
    ...resolveOptions(),
  },
})
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert result.stdout.count("unknown-overrides.spec.ts:") == 3
    assert "unresolved viewport width" in result.stdout.lower()


def test_checker_respects_later_known_object_properties(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "known-overrides.spec.ts",
        """
browser.newContext({
  ...resolveOptions(),
  viewport: { width: 1440, height: 900 },
})

browser.newContext({
  viewport: {
    ...resolveViewport(),
    width: 1440,
    height: 900,
  },
})

browser.newContext({
  viewport: { width: 390, height: 844 },
  ...{ viewport: { width: 1440, height: 900 } },
})

defineConfig({
  use: {
    ...resolveOptions(),
    viewport: { width: 1440, height: 900 },
  },
})
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 0, result.stdout + result.stderr
    assert "passed for 4 configured site(s)" in result.stdout


def test_checker_respects_known_spreads_reached_through_property_access(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "known-property-spreads.spec.ts",
        """
const presets = {
  desktop: { viewport: { width: 1440, height: 900 } },
}
const desktop = presets.desktop

browser.newContext({
  viewport: { width: 390, height: 844 },
  ...presets.desktop,
})
browser.newContext({
  viewport: { width: 390, height: 844 },
  ...presets['desktop'],
})
browser.newContext({
  viewport: { width: 390, height: 844 },
  ...desktop,
})
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 0, result.stdout + result.stderr
    assert "passed for 3 configured site(s)" in result.stdout


def test_checker_follows_computed_viewport_properties(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "computed-viewport.spec.ts",
        """
const key = 'viewport'
browser.newContext({
  viewport: { width: 1440, height: 900 },
  ['viewport']: { width: 390, height: 844 },
})
browser.newContext({
  viewport: { width: 1440, height: 900 },
  [key]: { width: 390, height: 844 },
})
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert result.stdout.count("computed-viewport.spec.ts:") == 2
    assert "390px" in result.stdout


def test_checker_respects_later_known_property_after_computed_property(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "computed-overridden.spec.ts",
        """
browser.newContext({
  ['viewport']: { width: 390, height: 844 },
  viewport: { width: 1440, height: 900 },
})
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 0, result.stdout + result.stderr


def test_checker_rejects_unresolved_computed_viewport_properties(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "dynamic-computed-viewport.spec.ts",
        """
browser.newContext({
  viewport: { width: 1440, height: 900 },
  [resolveKey()]: { width: 390, height: 844 },
})
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "unresolved viewport width" in result.stdout.lower()


def test_checker_rejects_mixed_static_dynamic_computed_keys(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "mixed-computed-viewport.spec.ts",
        """
const key = condition ? 'viewport' : resolveKey()
browser.newContext({
  viewport: { width: 390, height: 844 },
  [key]: { width: 1440, height: 900 },
})

const presets = {
  desktop: { viewport: { width: 1440, height: 900 } },
}
const presetName = condition ? 'desktop' : resolveName()
browser.newContext({
  viewport: { width: 390, height: 844 },
  ...presets[presetName],
})
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "unresolved viewport width" in result.stdout.lower()


def test_checker_rejects_unresolved_define_config_projects(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "unresolved-projects.spec.ts",
        "defineConfig({ projects: resolveProjects() })\n",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "unresolved viewport width" in result.stdout.lower()


def test_checker_ignores_unrelated_dynamic_define_config_values(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "dynamic-unrelated-config.spec.ts",
        "defineConfig({ reporter: resolveReporter() })\n",
    )

    result = _run_checker([fixture])

    assert result.returncode == 0, result.stdout + result.stderr


def test_checker_ignores_bare_fixture_use_callbacks(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "fixture-use-callback.spec.ts",
        """
fixture: async ({}, use) => {
  await use(resolveFixtureValue())
}
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 0, result.stdout + result.stderr


def test_checker_ignores_non_playwright_member_use_calls(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "non-playwright-use.spec.ts",
        "fixtures.use(resolveFixtureValue())\n",
    )

    result = _run_checker([fixture])

    assert result.returncode == 0, result.stdout + result.stderr


def test_checker_follows_aliased_playwright_test_use_calls(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "aliased-playwright-use.spec.ts",
        """
import { test as scenario } from '@playwright/test'

scenario.use({ viewport: { width: 390, height: 844 } })
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_follows_project_fixture_test_use_calls(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "project-fixture-use.spec.ts",
        """
import { test as scenario } from '../fixtures/click-ledger'

scenario.use({ viewport: { width: 390, height: 844 } })
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_follows_extended_playwright_test_use_calls(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "extended-playwright-use.spec.ts",
        """
import { test } from '@playwright/test'

const scenario = test.extend({})
scenario.use({ viewport: { width: 390, height: 844 } })
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_ignores_unrelated_relative_test_use_calls(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "unrelated-relative-test-use.spec.ts",
        """
import { test } from './domain'

test.use(resolveDomainValue())
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 0, result.stdout + result.stderr


def test_checker_respects_function_declaration_shadowing_of_playwright_test(
    tmp_path: Path,
) -> None:
    fixture = _write_fixture(
        tmp_path,
        "function-shadowed-playwright-test.spec.ts",
        """
import { test } from '@playwright/test'

function main() {
  function test() {}
  test.use(resolveDomainValue())
}

main()
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 0, result.stdout + result.stderr


def test_checker_merges_function_declarations_with_same_named_var_bindings(
    tmp_path: Path,
) -> None:
    fixture = _write_fixture(
        tmp_path,
        "function-var-merge.spec.ts",
        """
import { test as playwrightTest } from '@playwright/test'

function main() {
  function scenario() {}
  var scenario = playwrightTest
  scenario.use({ viewport: { width: 390, height: 844 } })
}

main()
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" in result.stdout


def test_checker_does_not_treat_object_rest_as_a_same_named_property(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "for-of-object-rest.spec.ts",
        """
for (const {...options} of [{
  options: { viewport: { width: 390, height: 844 } },
  extra: true,
}]) {
  browser.newContext(options)
}
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" not in result.stdout
    assert "unresolved viewport width" in result.stdout.lower()


def test_checker_does_not_treat_variable_object_rest_as_a_same_named_property(
    tmp_path: Path,
) -> None:
    fixture = _write_fixture(
        tmp_path,
        "variable-object-rest.spec.ts",
        """
const {...options} = {
  options: { viewport: { width: 390, height: 844 } },
  extra: true,
}
browser.newContext(options)
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "390px" not in result.stdout
    assert "unresolved viewport width" in result.stdout.lower()


def test_checker_follows_named_callback_bindings(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "named-test-callback.spec.ts",
        """
const mobileTest = async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
}

test('mobile', mobileTest)
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "1024px" in result.stdout


def test_checker_follows_aliased_callback_bindings(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        "aliased-test-callback.spec.ts",
        """
const mobileTest = async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 720 })
}
const aliasedMobileTest = mobileTest

test('mobile', aliasedMobileTest)
""",
    )

    result = _run_checker([fixture])

    assert result.returncode == 1
    assert "960px" in result.stdout
