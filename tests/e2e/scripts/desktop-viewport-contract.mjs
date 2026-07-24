#!/usr/bin/env node

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const requireFromScript = createRequire(import.meta.url)
const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const ts = requireFromScript(path.join(scriptsDir, '..', 'node_modules', 'typescript', 'lib', 'typescript.js'))
const { devices: playwrightDevices } = requireFromScript('@playwright/test')
const PLAYWRIGHT_MODULE_REFERENCE = Object.freeze({ kind: 'playwright-module' })
const PLAYWRIGHT_DEVICES_REFERENCE = Object.freeze({ kind: 'playwright-devices' })
const PLAYWRIGHT_TEST_REFERENCE = Object.freeze({ kind: 'playwright-test' })
const UNKNOWN_REFERENCE = Object.freeze({ kind: 'unknown' })
const LEXICAL_BINDINGS = Symbol('lexical-bindings')
const VAR_SCOPE = Symbol('var-scope')

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return null
}

function unwrapExpression(node) {
  let current = node
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isPartiallyEmittedExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function makeReference(node, environment) {
  return { kind: 'expression', node, environment }
}

function environmentBinding(environment, name) {
  const lexicalBindings = environment.get(LEXICAL_BINDINGS)
  if (lexicalBindings instanceof Set && lexicalBindings.has(name)) {
    return environment.get(name)
  }
  const varScope = environment.get(VAR_SCOPE)
  if (varScope instanceof Map && varScope.has(name)) return varScope.get(name)
  return environment.get(name)
}

function childEnvironment(environment) {
  const child = new Map(environment)
  child.set(LEXICAL_BINDINGS, new Set())
  return child
}

function resolveBinding(reference, seenBindings) {
  if (reference.kind !== 'expression') return null
  const node = unwrapExpression(reference.node)
  if (!ts.isIdentifier(node)) return null

  const binding = environmentBinding(reference.environment, node.text)
  if (!binding || seenBindings.has(binding)) return null
  return binding
}

function staticPropertyNameResolution(reference, seenBindings) {
  if (reference.kind !== 'expression') return { names: [], unresolved: true }
  const node = unwrapExpression(reference.node)
  const binding = resolveBinding(reference, seenBindings)
  if (binding) {
    const nextSeen = new Set(seenBindings)
    nextSeen.add(binding)
    return staticPropertyNameResolution(binding, nextSeen)
  }

  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return { names: [node.text], unresolved: false }
  }
  if (ts.isConditionalExpression(node)) {
    const resolutions = [node.whenTrue, node.whenFalse].map((branch) =>
      staticPropertyNameResolution(
        makeReference(branch, reference.environment),
        new Set(seenBindings),
      ),
    )
    return {
      names: resolutions.flatMap((resolution) => resolution.names),
      unresolved: resolutions.some((resolution) => resolution.unresolved),
    }
  }
  return { names: [], unresolved: true }
}

function staticPropertyNames(reference, seenBindings) {
  return staticPropertyNameResolution(reference, seenBindings).names
}

function propertyNameResolution(name, environment, seenBindings) {
  const directName = propertyNameText(name)
  if (directName !== null) return { names: [directName], unresolved: false }
  if (!ts.isComputedPropertyName(name)) return { names: [], unresolved: false }
  return staticPropertyNameResolution(makeReference(name.expression, environment), seenBindings)
}

function accessedPropertyName(node) {
  const expression = unwrapExpression(node)
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (!ts.isElementAccessExpression(expression) || !expression.argumentExpression) return null
  const argument = unwrapExpression(expression.argumentExpression)
  return ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)
    ? argument.text
    : null
}

function resolvePlaywrightValue(reference, seenBindings) {
  if (
    reference.kind === PLAYWRIGHT_MODULE_REFERENCE.kind
    || reference.kind === PLAYWRIGHT_DEVICES_REFERENCE.kind
    || reference.kind === PLAYWRIGHT_TEST_REFERENCE.kind
  ) {
    return reference
  }
  if (reference.kind !== 'expression') return null

  const node = unwrapExpression(reference.node)
  if (ts.isIdentifier(node)) {
    const binding = environmentBinding(reference.environment, node.text)
    if (!binding || seenBindings.has(binding)) return null
    const nextSeen = new Set(seenBindings)
    nextSeen.add(binding)
    return resolvePlaywrightValue(binding, nextSeen)
  }
  if (isPlaywrightRequireCall(node)) return PLAYWRIGHT_MODULE_REFERENCE
  if (ts.isCallExpression(node)) {
    const callTarget = unwrapExpression(node.expression)
    if (!ts.isPropertyAccessExpression(callTarget) || callTarget.name.text !== 'extend') {
      return null
    }
    const receiver = resolvePlaywrightValue(
      makeReference(callTarget.expression, reference.environment),
      new Set(seenBindings),
    )
    return receiver?.kind === PLAYWRIGHT_TEST_REFERENCE.kind
      ? PLAYWRIGHT_TEST_REFERENCE
      : null
  }
  const propertyName = accessedPropertyName(node)
  if (!['devices', 'test'].includes(propertyName)) return null

  const moduleReference = resolvePlaywrightValue(
    makeReference(node.expression, reference.environment),
    new Set(seenBindings),
  )
  if (moduleReference?.kind !== PLAYWRIGHT_MODULE_REFERENCE.kind) return null
  return propertyName === 'devices' ? PLAYWRIGHT_DEVICES_REFERENCE : PLAYWRIGHT_TEST_REFERENCE
}

function playwrightDevicePreset(reference) {
  if (reference.kind !== 'expression') return null
  const node = unwrapExpression(reference.node)
  let registryExpression = null
  let presetName = null
  if (ts.isElementAccessExpression(node)) {
    registryExpression = node.expression
    const argument = node.argumentExpression && unwrapExpression(node.argumentExpression)
    if (argument && ts.isStringLiteralLike(argument)) presetName = argument.text
  } else if (ts.isPropertyAccessExpression(node)) {
    registryExpression = node.expression
    presetName = node.name.text
  }
  if (registryExpression === null) return null

  const registry = resolvePlaywrightValue(
    makeReference(registryExpression, reference.environment),
    new Set(),
  )
  if (registry?.kind !== PLAYWRIGHT_DEVICES_REFERENCE.kind) return null
  if (
    presetName === null
    || !Object.prototype.hasOwnProperty.call(playwrightDevices, presetName)
  ) {
    return { matched: true, viewport: null }
  }

  const preset = playwrightDevices[presetName]
  if (typeof preset !== 'object' || preset === null) {
    throw new TypeError(`Playwright device preset ${presetName} must be an object`)
  }
  const viewport = preset.viewport
  if (
    typeof viewport !== 'object'
    || viewport === null
    || !Number.isInteger(viewport.width)
    || viewport.width < 1
  ) {
    throw new TypeError(`Playwright device preset ${presetName} must define a positive viewport width`)
  }

  const viewportNode = ts.factory.createObjectLiteralExpression([
    ts.factory.createPropertyAssignment(
      ts.factory.createIdentifier('width'),
      ts.factory.createNumericLiteral(viewport.width),
    ),
  ])
  return {
    matched: true,
    viewport: makeReference(viewportNode, reference.environment),
  }
}

function playwrightDevicePropertyReferences(reference, propertyName) {
  const preset = playwrightDevicePreset(reference)
  if (preset === null) return null
  if (propertyName !== 'viewport') return []
  return [preset.viewport || reference]
}

function objectDefinitelyDefinesProperty(reference, propertyName, seenBindings) {
  if (reference.kind === PLAYWRIGHT_MODULE_REFERENCE.kind) return propertyName === 'devices'
  if (reference.kind !== 'expression') return false

  const node = unwrapExpression(reference.node)
  const binding = resolveBinding(reference, seenBindings)
  if (binding) {
    const nextSeen = new Set(seenBindings)
    nextSeen.add(binding)
    return objectDefinitelyDefinesProperty(binding, propertyName, nextSeen)
  }

  const deviceProperties = playwrightDevicePropertyReferences(reference, propertyName)
  if (deviceProperties !== null) return deviceProperties.length > 0

  if (ts.isObjectLiteralExpression(node)) {
    for (let index = node.properties.length - 1; index >= 0; index -= 1) {
      const property = node.properties[index]
      if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        const nameResolution = propertyNameResolution(
          property.name,
          reference.environment,
          new Set(seenBindings),
        )
        if (
          nameResolution.names.length > 0
          && nameResolution.names.every((name) => name === propertyName)
        ) {
          return true
        }
      }
      if (
        ts.isSpreadAssignment(property)
        && objectDefinitelyDefinesProperty(
          makeReference(property.expression, reference.environment),
          propertyName,
          new Set(seenBindings),
        )
      ) {
        return true
      }
    }
    return false
  }

  if (ts.isPropertyAccessExpression(node)) {
    const parentReferences = objectPropertyReferences(
      makeReference(node.expression, reference.environment),
      node.name.text,
      new Set(seenBindings),
    )
    return parentReferences.length > 0 && parentReferences.every((parentReference) =>
      objectDefinitelyDefinesProperty(parentReference, propertyName, new Set(seenBindings)),
    )
  }

  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const accessedNameResolution = staticPropertyNameResolution(
      makeReference(node.argumentExpression, reference.environment),
      new Set(seenBindings),
    )
    if (accessedNameResolution.names.length === 0) return false
    if (accessedNameResolution.unresolved) return false
    const parentReferences = accessedNameResolution.names.flatMap((accessedName) =>
      objectPropertyReferences(
        makeReference(node.expression, reference.environment),
        accessedName,
        new Set(seenBindings),
      ),
    )
    return parentReferences.length > 0 && parentReferences.every((parentReference) =>
      objectDefinitelyDefinesProperty(parentReference, propertyName, new Set(seenBindings)),
    )
  }

  if (ts.isConditionalExpression(node)) {
    return [node.whenTrue, node.whenFalse].every((branch) =>
      objectDefinitelyDefinesProperty(
        makeReference(branch, reference.environment),
        propertyName,
        new Set(seenBindings),
      ),
    )
  }

  return false
}

function objectPropertyReferences(reference, propertyName, seenBindings) {
  if (reference.kind === PLAYWRIGHT_MODULE_REFERENCE.kind) {
    return propertyName === 'devices' ? [PLAYWRIGHT_DEVICES_REFERENCE] : []
  }
  if (reference.kind === UNKNOWN_REFERENCE.kind) return [UNKNOWN_REFERENCE]
  if (reference.kind !== 'expression') return []

  const node = unwrapExpression(reference.node)
  const binding = resolveBinding(reference, seenBindings)
  if (binding) {
    const nextSeen = new Set(seenBindings)
    nextSeen.add(binding)
    return objectPropertyReferences(binding, propertyName, nextSeen)
  }

  const deviceProperties = playwrightDevicePropertyReferences(reference, propertyName)
  if (deviceProperties !== null) return deviceProperties

  if (ts.isObjectLiteralExpression(node)) {
    const matches = []
    for (let index = node.properties.length - 1; index >= 0; index -= 1) {
      const property = node.properties[index]
      if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        const nameResolution = propertyNameResolution(
          property.name,
          reference.environment,
          new Set(seenBindings),
        )
        if (nameResolution.names.includes(propertyName)) {
          const valueNode = ts.isPropertyAssignment(property) ? property.initializer : property.name
          matches.push(makeReference(valueNode, reference.environment))
        }
        if (nameResolution.unresolved) matches.push(UNKNOWN_REFERENCE)
        if (
          nameResolution.names.length > 0
          && nameResolution.names.every((name) => name === propertyName)
        ) {
          return matches
        }
      } else if (ts.isSpreadAssignment(property)) {
        const spreadReference = makeReference(property.expression, reference.environment)
        matches.push(
          ...objectPropertyReferences(
            spreadReference,
            propertyName,
            new Set(seenBindings),
          ),
        )
        if (objectDefinitelyDefinesProperty(spreadReference, propertyName, new Set(seenBindings))) {
          return matches
        }
      }
    }
    return matches
  }

  if (ts.isPropertyAccessExpression(node)) {
    const parentReferences = objectPropertyReferences(
      makeReference(node.expression, reference.environment),
      node.name.text,
      new Set(seenBindings),
    )
    return parentReferences.flatMap((parentReference) =>
      objectPropertyReferences(parentReference, propertyName, new Set(seenBindings)),
    )
  }

  if (ts.isElementAccessExpression(node)) {
    const argumentReference = node.argumentExpression
      ? makeReference(node.argumentExpression, reference.environment)
      : UNKNOWN_REFERENCE
    const accessedNameResolution = staticPropertyNameResolution(
      argumentReference,
      new Set(seenBindings),
    )
    if (accessedNameResolution.names.length === 0) return [UNKNOWN_REFERENCE]
    const parentReferences = accessedNameResolution.names.flatMap((accessedName) =>
      objectPropertyReferences(
        makeReference(node.expression, reference.environment),
        accessedName,
        new Set(seenBindings),
      ),
    )
    if (parentReferences.length === 0) return [UNKNOWN_REFERENCE]
    if (accessedNameResolution.unresolved) parentReferences.push(UNKNOWN_REFERENCE)
    return parentReferences.flatMap((parentReference) =>
      objectPropertyReferences(parentReference, propertyName, new Set(seenBindings)),
    )
  }

  if (ts.isConditionalExpression(node)) {
    return [node.whenTrue, node.whenFalse].flatMap((branch) =>
      objectPropertyReferences(
        makeReference(branch, reference.environment),
        propertyName,
        new Set(seenBindings),
      ),
    )
  }

  return [UNKNOWN_REFERENCE]
}

function numericResolution(reference, seenBindings) {
  if (reference.kind === UNKNOWN_REFERENCE.kind) return { values: [], unresolved: true }
  if (reference.kind !== 'expression') return { values: [], unresolved: true }
  const node = unwrapExpression(reference.node)
  const binding = resolveBinding(reference, seenBindings)
  if (binding) {
    const nextSeen = new Set(seenBindings)
    nextSeen.add(binding)
    return numericResolution(binding, nextSeen)
  }

  if (ts.isNumericLiteral(node)) {
    return { values: [Number(node.text)], unresolved: false }
  }

  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    const value = Number(node.operand.text)
    if (node.operator === ts.SyntaxKind.MinusToken) {
      return { values: [-value], unresolved: false }
    }
    if (node.operator === ts.SyntaxKind.PlusToken) {
      return { values: [value], unresolved: false }
    }
  }

  if (ts.isPropertyAccessExpression(node)) {
    return combineNumericResolutions(objectPropertyReferences(
      makeReference(node.expression, reference.environment),
      node.name.text,
      new Set(seenBindings),
    ).map((propertyReference) => numericResolution(propertyReference, new Set(seenBindings))))
  }

  if (ts.isConditionalExpression(node)) {
    return combineNumericResolutions([node.whenTrue, node.whenFalse].map((branch) =>
      numericResolution(makeReference(branch, reference.environment), new Set(seenBindings)),
    ))
  }

  return { values: [], unresolved: true }
}

function combineNumericResolutions(resolutions) {
  return {
    values: resolutions.flatMap((resolution) => resolution.values),
    unresolved: resolutions.some((resolution) => resolution.unresolved),
  }
}

function defineConfigViewportReferences(reference) {
  const directUseReferences = objectPropertyReferences(reference, 'use', new Set())
  const projectReferences = objectPropertyReferences(reference, 'projects', new Set())
    .flatMap((projectsReference) => iterableReferences(projectsReference, new Set()))
  const projectUseReferences = projectReferences.flatMap((projectReference) =>
    objectPropertyReferences(projectReference, 'use', new Set()),
  )
  return [...directUseReferences, ...projectUseReferences].flatMap((useReference) =>
    objectPropertyReferences(useReference, 'viewport', new Set()),
  )
}

function objectNumericPropertyResolution(reference, propertyName) {
  return combineNumericResolutions(
    objectPropertyReferences(reference, propertyName, new Set())
      .map((propertyReference) => numericResolution(propertyReference, new Set())),
  )
}

function iterableReferences(reference, seenBindings) {
  if (reference.kind === UNKNOWN_REFERENCE.kind) return [UNKNOWN_REFERENCE]
  if (reference.kind !== 'expression') return [UNKNOWN_REFERENCE]
  const node = unwrapExpression(reference.node)
  const binding = resolveBinding(reference, seenBindings)
  if (binding) {
    const nextSeen = new Set(seenBindings)
    nextSeen.add(binding)
    return iterableReferences(binding, nextSeen)
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) => {
      if (ts.isSpreadElement(element)) {
        return iterableReferences(
          makeReference(element.expression, reference.environment),
          new Set(seenBindings),
        )
      }
      return [makeReference(element, reference.environment)]
    })
  }

  if (ts.isConditionalExpression(node)) {
    return [node.whenTrue, node.whenFalse].flatMap((branch) =>
      iterableReferences(makeReference(branch, reference.environment), new Set(seenBindings)),
    )
  }

  return [UNKNOWN_REFERENCE]
}

function callName(expression) {
  const node = unwrapExpression(expression)
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return null
}

function scriptKindFor(fileName) {
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

function isPlaywrightModuleName(moduleName) {
  return ['@playwright/test', 'playwright'].includes(moduleName)
}

function isPlaywrightRequireCall(node) {
  const expression = unwrapExpression(node)
  if (
    !ts.isCallExpression(expression)
    || !ts.isIdentifier(expression.expression)
    || expression.expression.text !== 'require'
    || expression.arguments.length !== 1
  ) {
    return false
  }
  const moduleName = unwrapExpression(expression.arguments[0])
  return ts.isStringLiteralLike(moduleName) && isPlaywrightModuleName(moduleName.text)
}

function directCommonJsPlaywrightBindings(declaration) {
  if (!declaration.initializer) return []

  if (ts.isObjectBindingPattern(declaration.name) && isPlaywrightRequireCall(declaration.initializer)) {
    return declaration.name.elements.flatMap((element) => {
      const importedName = element.propertyName
        ? propertyNameText(element.propertyName)
        : propertyNameText(element.name)
      if (!ts.isIdentifier(element.name)) return []
      if (importedName === 'devices') {
        return [[element.name.text, PLAYWRIGHT_DEVICES_REFERENCE]]
      }
      if (importedName === 'test') return [[element.name.text, PLAYWRIGHT_TEST_REFERENCE]]
      return []
    })
  }

  const initializer = unwrapExpression(declaration.initializer)
  if (!ts.isIdentifier(declaration.name)) return []
  if (isPlaywrightRequireCall(initializer)) {
    return [[declaration.name.text, PLAYWRIGHT_MODULE_REFERENCE]]
  }
  if (accessedPropertyName(initializer) !== 'devices') return []
  if (isPlaywrightRequireCall(initializer.expression)) {
    return [[declaration.name.text, PLAYWRIGHT_DEVICES_REFERENCE]]
  }
  return []
}

function playwrightImportBindings(sourceFile) {
  const importBindings = []
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const moduleName = statement.moduleSpecifier.text
    const isPlaywrightModule = isPlaywrightModuleName(moduleName)
    const normalizedModuleName = moduleName.replaceAll('\\', '/')
    const isPlaywrightFixtureModule = normalizedModuleName.startsWith('.')
      && normalizedModuleName.split('/').includes('fixtures')
    if (!isPlaywrightModule && !isPlaywrightFixtureModule) continue

    const importClause = statement.importClause
    if (!importClause) continue
    if (isPlaywrightModule && importClause.name) {
      importBindings.push([importClause.name.text, PLAYWRIGHT_MODULE_REFERENCE])
    }
    const bindings = importClause.namedBindings
    if (isPlaywrightModule && bindings && ts.isNamespaceImport(bindings)) {
      importBindings.push([bindings.name.text, PLAYWRIGHT_MODULE_REFERENCE])
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text || element.name.text
        if (isPlaywrightModule && importedName === 'devices') {
          importBindings.push([element.name.text, PLAYWRIGHT_DEVICES_REFERENCE])
        } else if (importedName === 'test') {
          importBindings.push([element.name.text, PLAYWRIGHT_TEST_REFERENCE])
        }
      }
    }
  }
  return importBindings
}

function analyzeSource(sourceText, fileName, minimumWidth) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  )
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostics = sourceFile.parseDiagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      .join('; ')
    throw new SyntaxError(`Could not parse browser automation source ${fileName}: ${diagnostics}`)
  }

  const functionDeclarations = new Map()
  const functionScopedDeclarations = new Set()
  const sites = new Map()

  function collectFunctions(node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functionDeclarations.set(node.name.text, node)
    }
    ts.forEachChild(node, collectFunctions)
  }

  function recordSite(node, kind, resolution) {
    const key = `${kind}:${node.pos}:${node.end}`
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    const site = sites.get(key) || {
      file: fileName,
      line: position.line + 1,
      column: position.character + 1,
      kind,
      widths: new Set(),
      unresolved: false,
    }
    for (const width of resolution.values) site.widths.add(width)
    if (resolution.unresolved || resolution.values.length === 0) site.unresolved = true
    sites.set(key, site)
  }

  function callableReference(expression, environment, seenBindings) {
    const node = unwrapExpression(expression)
    if (
      ts.isArrowFunction(node)
      || ts.isFunctionExpression(node)
      || ts.isFunctionDeclaration(node)
    ) {
      return { node, environment }
    }
    if (!ts.isIdentifier(node)) return null

    const binding = environmentBinding(environment, node.text)
    if (binding?.kind === 'expression' && !seenBindings.has(binding)) {
      const nextSeen = new Set(seenBindings)
      nextSeen.add(binding)
      const callable = callableReference(binding.node, binding.environment, nextSeen)
      if (callable) return callable
    }

    const declaration = functionDeclarations.get(node.text)
    return declaration ? { node: declaration, environment } : null
  }

  function inspectViewportCall(node, environment) {
    const name = callName(node.expression)
    if (name === 'setViewportSize') {
      const argument = node.arguments[0]
      const resolution = argument
        ? objectNumericPropertyResolution(makeReference(argument, environment), 'width')
        : { values: [], unresolved: true }
      recordSite(node, 'setViewportSize', resolution)
      return
    }

    if (name === 'defineConfig' && node.arguments.length > 0) {
      const viewportReferences = defineConfigViewportReferences(
        makeReference(node.arguments[0], environment),
      )
      if (viewportReferences.length === 0) return

      const resolution = combineNumericResolutions(viewportReferences.map((viewportReference) =>
        objectNumericPropertyResolution(viewportReference, 'width'),
      ))
      recordSite(node, 'defineConfig.viewport', resolution)
      return
    }

    if (!['newContext', 'newPage', 'use'].includes(name) || node.arguments.length === 0) return
    if (name === 'use' && ts.isIdentifier(unwrapExpression(node.expression))) return
    if (name === 'use') {
      const callExpression = unwrapExpression(node.expression)
      if (!ts.isPropertyAccessExpression(callExpression)) return
      const receiver = resolvePlaywrightValue(
        makeReference(callExpression.expression, environment),
        new Set(),
      )
      if (receiver?.kind !== PLAYWRIGHT_TEST_REFERENCE.kind) return
    }

    const optionsReference = makeReference(node.arguments[0], environment)
    const viewportReferences = objectPropertyReferences(optionsReference, 'viewport', new Set())
    if (viewportReferences.length === 0) return

    const resolution = combineNumericResolutions(viewportReferences.map((viewportReference) =>
      objectNumericPropertyResolution(viewportReference, 'width'),
    ))
    recordSite(node, `${name}.viewport`, resolution)
  }

  function walkFunction(callable, argumentReferences, activeFunctions) {
    if (activeFunctions.has(callable.node)) return

    const functionEnvironment = childEnvironment(callable.environment)
    functionEnvironment.set(VAR_SCOPE, functionEnvironment)
    callable.node.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) return
      functionEnvironment.get(LEXICAL_BINDINGS).add(parameter.name.text)
      const argumentReference = argumentReferences[index]
      if (argumentReference) {
        functionEnvironment.set(parameter.name.text, argumentReference)
      } else if (parameter.initializer) {
        functionEnvironment.set(
          parameter.name.text,
          makeReference(parameter.initializer, functionEnvironment),
        )
      } else {
        functionEnvironment.set(parameter.name.text, UNKNOWN_REFERENCE)
      }
    })

    const nextActiveFunctions = new Set(activeFunctions)
    nextActiveFunctions.add(callable.node)
    if (callable.node.body && ts.isBlock(callable.node.body)) {
      for (const statement of callable.node.body.statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.name) continue
        functionScopedDeclarations.add(statement)
        functionEnvironment.set(
          statement.name.text,
          makeReference(statement, functionEnvironment),
        )
      }
    }
    if (callable.node.body) walk(callable.node.body, functionEnvironment, nextActiveFunctions)
  }

  function walk(node, environment, activeFunctions) {
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      const blockEnvironment = ts.isSourceFile(node) ? environment : childEnvironment(environment)
      for (const statement of node.statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.name) continue
        if (functionScopedDeclarations.has(statement)) continue
        blockEnvironment.set(statement.name.text, makeReference(statement, blockEnvironment))
        blockEnvironment.get(LEXICAL_BINDINGS).add(statement.name.text)
      }
      for (const statement of node.statements) {
        walk(statement, blockEnvironment, activeFunctions)
      }
      return
    }

    if (ts.isFunctionDeclaration(node)) return

    if (ts.isVariableStatement(node)) {
      const isBlockScoped = (node.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0

      function bindVariable(name, reference) {
        if (isBlockScoped) {
          environment.set(name, reference)
          environment.get(LEXICAL_BINDINGS).add(name)
          return
        }
        const varScope = environment.get(VAR_SCOPE)
        if (!(varScope instanceof Map)) {
          throw new TypeError('Browser automation analyzer lost the current var scope')
        }
        varScope.set(name, reference)
      }

      for (const declaration of node.declarationList.declarations) {
        const bindingEnvironment = childEnvironment(environment)
        if (!declaration.initializer) {
          if (ts.isIdentifier(declaration.name)) {
            bindVariable(declaration.name.text, UNKNOWN_REFERENCE)
          } else if (ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) {
              if (ts.isIdentifier(element.name)) {
                bindVariable(element.name.text, UNKNOWN_REFERENCE)
              }
            }
          }
          continue
        }

        const directBindings = new Map(directCommonJsPlaywrightBindings(declaration))
        if (ts.isIdentifier(declaration.name)) {
          bindVariable(
            declaration.name.text,
            directBindings.get(declaration.name.text)
              || makeReference(declaration.initializer, bindingEnvironment),
          )
        } else if (ts.isObjectBindingPattern(declaration.name)) {
          const sourceReference = makeReference(declaration.initializer, bindingEnvironment)
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue
            if (element.dotDotDotToken) {
              bindVariable(element.name.text, UNKNOWN_REFERENCE)
              continue
            }
            const directBinding = directBindings.get(element.name.text)
            if (directBinding) {
              bindVariable(element.name.text, directBinding)
              continue
            }
            const sourceName = element.propertyName
              ? propertyNameText(element.propertyName)
              : element.name.text
            const references = sourceName === null
              ? []
              : objectPropertyReferences(sourceReference, sourceName, new Set())
            bindVariable(
              element.name.text,
              references.length === 1 ? references[0] : UNKNOWN_REFERENCE,
            )
          }
        }
        const initializer = unwrapExpression(declaration.initializer)
        if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) {
          walk(initializer, bindingEnvironment, activeFunctions)
        }
      }
      return
    }

    if (ts.isForOfStatement(node)) {
      const elements = iterableReferences(makeReference(node.expression, environment), new Set())
      const declarationList = ts.isVariableDeclarationList(node.initializer)
        ? node.initializer
        : null
      const declaration = declarationList?.declarations[0] || null

      function bindLoopPattern(pattern, reference, loopEnvironment, isBlockScoped) {
        if (ts.isIdentifier(pattern)) {
          if (isBlockScoped) {
            loopEnvironment.set(pattern.text, reference)
            loopEnvironment.get(LEXICAL_BINDINGS).add(pattern.text)
          } else {
            const varScope = loopEnvironment.get(VAR_SCOPE)
            if (!(varScope instanceof Map)) {
              throw new TypeError('Browser automation analyzer lost the current var scope')
            }
            varScope.set(pattern.text, reference)
          }
          return
        }

        if (ts.isObjectBindingPattern(pattern)) {
          for (const bindingElement of pattern.elements) {
            if (bindingElement.dotDotDotToken) {
              bindLoopPattern(
                bindingElement.name,
                UNKNOWN_REFERENCE,
                loopEnvironment,
                isBlockScoped,
              )
              continue
            }
            const propertyName = bindingElement.propertyName
              ? propertyNameText(bindingElement.propertyName)
              : ts.isIdentifier(bindingElement.name) ? bindingElement.name.text : null
            const references = propertyName === null
              ? []
              : objectPropertyReferences(reference, propertyName, new Set())
            bindLoopPattern(
              bindingElement.name,
              references.length === 1 ? references[0] : UNKNOWN_REFERENCE,
              loopEnvironment,
              isBlockScoped,
            )
          }
          return
        }

        const itemReferences = iterableReferences(reference, new Set())
        pattern.elements.forEach((bindingElement, index) => {
          if (ts.isOmittedExpression(bindingElement)) return
          bindLoopPattern(
            bindingElement.name,
            itemReferences[index] || UNKNOWN_REFERENCE,
            loopEnvironment,
            isBlockScoped,
          )
        })
      }

      if (declaration && elements.length > 0) {
        for (const element of elements) {
          const loopEnvironment = childEnvironment(environment)
          const isBlockScoped = (declarationList.flags & ts.NodeFlags.BlockScoped) !== 0
          bindLoopPattern(declaration.name, element, loopEnvironment, isBlockScoped)
          walk(node.statement, loopEnvironment, activeFunctions)
        }
      } else {
        const loopEnvironment = childEnvironment(environment)
        if (declaration) {
          const isBlockScoped = (declarationList.flags & ts.NodeFlags.BlockScoped) !== 0
          bindLoopPattern(declaration.name, UNKNOWN_REFERENCE, loopEnvironment, isBlockScoped)
        }
        walk(node.statement, loopEnvironment, activeFunctions)
      }
      return
    }

    if (ts.isCallExpression(node)) {
      inspectViewportCall(node, environment)
      const callable = callableReference(node.expression, environment, new Set())
      if (callable) {
        walkFunction(
          callable,
          node.arguments.map((argument) => makeReference(argument, environment)),
          activeFunctions,
        )
      } else {
        walk(node.expression, environment, activeFunctions)
        for (const argument of node.arguments) {
          const argumentNode = unwrapExpression(argument)
          const argumentCallable = callableReference(argumentNode, environment, new Set())
          if (argumentCallable) {
            walkFunction(
              argumentCallable,
              [],
              activeFunctions,
            )
          } else {
            walk(argumentNode, environment, activeFunctions)
          }
        }
      }
      return
    }

    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      walkFunction({ node, environment }, [], activeFunctions)
      return
    }

    ts.forEachChild(node, (child) => walk(child, environment, activeFunctions))
  }

  collectFunctions(sourceFile)
  const importBindings = playwrightImportBindings(sourceFile)
  const rootEnvironment = new Map(importBindings)
  rootEnvironment.set(VAR_SCOPE, rootEnvironment)
  rootEnvironment.set(LEXICAL_BINDINGS, new Set(importBindings.map(([name]) => name)))
  walk(sourceFile, rootEnvironment, new Set())

  const resolvedSites = [...sites.values()]
    .map((site) => ({
      ...site,
      widths: [...site.widths].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.line - right.line || left.column - right.column)
  return {
    sites: resolvedSites,
    violations: resolvedSites
      .map((site) => ({
        ...site,
        widths: site.widths.filter((width) => width < minimumWidth),
      }))
      .filter((site) => site.widths.length > 0),
    unresolved: resolvedSites.filter((site) => site.unresolved),
  }
}

function parseArguments(argumentsList) {
  if (argumentsList.length < 3 || argumentsList[0] !== '--minimum-width') {
    throw new TypeError(
      'Usage: desktop-viewport-contract.mjs --minimum-width <pixels> <source files...>',
    )
  }
  const minimumWidth = Number(argumentsList[1])
  if (!Number.isInteger(minimumWidth) || minimumWidth < 1) {
    throw new RangeError(`minimum width must be a positive integer, received ${argumentsList[1]}`)
  }
  return { minimumWidth, sourcePaths: argumentsList.slice(2) }
}

function formatSite(site) {
  return `${site.file}:${site.line}:${site.column} ${site.kind}`
}

function main(argumentsList) {
  const { minimumWidth, sourcePaths } = parseArguments(argumentsList)
  const analyses = sourcePaths.map((sourcePath) => {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Browser automation source does not exist: ${sourcePath}`)
    }
    const sourceText = fs.readFileSync(sourcePath, 'utf8')
    return analyzeSource(sourceText, sourcePath, minimumWidth)
  })
  const sites = analyses.flatMap((analysis) => analysis.sites)
  const violations = analyses.flatMap((analysis) => analysis.violations)
  const unresolved = analyses.flatMap((analysis) => analysis.unresolved)

  if (violations.length > 0) {
    console.log(`Unsupported desktop viewport widths below ${minimumWidth}px:`)
    for (const violation of violations) {
      console.log(`- ${formatSite(violation)}: ${violation.widths.map((width) => `${width}px`).join(', ')}`)
    }
  }
  if (unresolved.length > 0) {
    console.log('Unresolved viewport width configuration:')
    for (const site of unresolved) console.log(`- ${formatSite(site)}`)
  }
  if (violations.length === 0 && unresolved.length === 0) {
    console.log(`Desktop viewport contract passed for ${sites.length} configured site(s).`)
    return 0
  }
  return 1
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
