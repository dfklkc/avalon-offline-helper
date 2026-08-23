'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.nyc_output',
  'coverage',
  'miniprogram_npm',
  'node_modules'
])

// Native Mini Program components and WXML language elements. Keeping this as
// an explicit allowlist makes an accidental HTML/custom tag fail in CI.
const NATIVE_WXML_TAGS = new Set([
  'ad',
  'ad-custom',
  'audio',
  'block',
  'button',
  'camera',
  'canvas',
  'channel-live',
  'channel-video',
  'checkbox',
  'checkbox-group',
  'cover-image',
  'cover-view',
  'editor',
  'form',
  'functional-page-navigator',
  'grid-view',
  'icon',
  'image',
  'import',
  'include',
  'input',
  'keyboard-accessory',
  'label',
  'lifestyle',
  'list-view',
  'live-player',
  'live-pusher',
  'map',
  'match-media',
  'movable-area',
  'movable-view',
  'navigation-bar',
  'navigator',
  'official-account',
  'open-data',
  'page-container',
  'page-meta',
  'picker',
  'picker-view',
  'picker-view-column',
  'progress',
  'radio',
  'radio-group',
  'rich-text',
  'root-portal',
  'scroll-view',
  'share-element',
  'slider',
  'slot',
  'snapshot',
  'sticky-header',
  'sticky-section',
  'swiper',
  'swiper-item',
  'switch',
  'template',
  'text',
  'textarea',
  'video',
  'view',
  'voip-room',
  'web-view',
  'wxs'
])

const failures = []

function relativePath(filePath) {
  return path.relative(PROJECT_ROOT, filePath).split(path.sep).join('/') || '.'
}

function fail(message) {
  failures.push(message)
}

function walkFiles(directory) {
  const files = []
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    fail(`无法读取目录 ${relativePath(directory)}: ${error.message}`)
    return files
  }

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(entryPath))
    else if (entry.isFile()) files.push(entryPath)
  }
  return files
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    fail(`无法读取 ${relativePath(filePath)}: ${error.message}`)
    return null
  }
}

function jsonLocation(source, error) {
  const match = /position\s+(\d+)/i.exec(error.message || '')
  if (!match) return ''
  const position = Number(match[1])
  const prefix = source.slice(0, position)
  const lines = prefix.split('\n')
  return `:${lines.length}:${lines.at(-1).length + 1}`
}

function parseJsonFile(filePath) {
  const source = readText(filePath)
  if (source == null) return null
  try {
    return JSON.parse(source)
  } catch (error) {
    fail(`${relativePath(filePath)}${jsonLocation(source, error)} JSON 无法解析: ${error.message}`)
    return null
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function collectPageRoutes(appConfig) {
  const routes = []
  if (!appConfig || typeof appConfig !== 'object' || Array.isArray(appConfig)) {
    fail('miniprogram/app.json 顶层必须是对象')
    return routes
  }

  if (!Array.isArray(appConfig.pages) || appConfig.pages.length === 0) {
    fail('miniprogram/app.json 必须注册至少一个 pages 页面')
  } else {
    routes.push(...appConfig.pages)
  }

  const subpackages = appConfig.subPackages || appConfig.subpackages || []
  if (!Array.isArray(subpackages)) {
    fail('miniprogram/app.json 的 subPackages 必须是数组')
  } else {
    for (const [index, subpackage] of subpackages.entries()) {
      if (!subpackage || typeof subpackage.root !== 'string' || !Array.isArray(subpackage.pages)) {
        fail(`miniprogram/app.json subPackages[${index}] 必须包含 root 和 pages[]`)
        continue
      }
      const root = subpackage.root.replace(/^\/+|\/+$/g, '')
      routes.push(...subpackage.pages.map((page) => `${root}/${page}`))
    }
  }

  return routes
}

function normalizePageRoute(route, miniprogramRoot) {
  if (typeof route !== 'string' || !route.trim()) {
    fail(`app.json 中存在非法页面路径: ${JSON.stringify(route)}`)
    return null
  }
  const normalized = route.trim().replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.endsWith('/') || normalized.includes('..')) {
    fail(`app.json 页面路径不安全: ${route}`)
    return null
  }
  const basePath = path.resolve(miniprogramRoot, normalized)
  if (!isInside(miniprogramRoot, basePath)) {
    fail(`app.json 页面路径越界: ${route}`)
    return null
  }
  return { route: normalized, basePath }
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length
}

function maskExceptNewlines(value) {
  return value.replace(/[^\n]/g, ' ')
}

function validateWxmlTags(filePath) {
  const source = readText(filePath)
  if (source == null) return { source: '', tagCount: 0 }
  const withoutComments = source
    .replace(/<!--[\s\S]*?-->/g, maskExceptNewlines)
    .replace(
      /(<wxs\b[^>]*>)([\s\S]*?)(<\/wxs\s*>)/gi,
      (full, opening, body, closing) => `${opening}${maskExceptNewlines(body)}${closing}`
    )
    .replace(/\{\{[\s\S]*?\}\}/g, maskExceptNewlines)
  const tagPattern = /<\/?\s*([A-Za-z][A-Za-z0-9-]*)\b/g
  let tagCount = 0
  let match
  while ((match = tagPattern.exec(withoutComments))) {
    tagCount += 1
    const tag = match[1]
    const normalizedTag = tag.toLowerCase()
    if (tag !== normalizedTag) {
      fail(`${relativePath(filePath)}:${lineNumberAt(withoutComments, match.index)} WXML 标签必须小写: <${tag}>`)
    } else if (!NATIVE_WXML_TAGS.has(normalizedTag)) {
      fail(`${relativePath(filePath)}:${lineNumberAt(withoutComments, match.index)} 非原生 WXML 标签: <${tag}>`)
    }
  }
  return { source, tagCount }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasStaticHandler(pageSource, handlerName) {
  const name = escapeRegExp(handlerName)
  const patterns = [
    new RegExp(`(?:^|[,{;\\s])(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`, 'm'),
    new RegExp(`(?:^|[,{;\\s])${name}\\s*:\\s*(?:async\\s+)?function\\b`, 'm'),
    new RegExp(`(?:^|[,{;\\s])${name}\\s*:\\s*(?:async\\s+)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>`, 'm'),
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`),
    new RegExp(`(?:^|[,{;\\s])${name}\\s*(?:,|\\})`, 'm')
  ]
  return patterns.some((pattern) => pattern.test(pageSource))
}

function validateEventHandlers(wxmlPath, pageJsPath) {
  const wxmlSource = readText(wxmlPath)
  const pageSource = readText(pageJsPath)
  if (wxmlSource == null || pageSource == null) return 0
  const source = wxmlSource.replace(/<!--[\s\S]*?-->/g, maskExceptNewlines)
  const eventPattern = /\b((?:capture-)?(?:bind|catch)[A-Za-z0-9_:-]*)\s*=\s*(['"])([^'"]*)\2/g
  const checkedHandlers = new Set()
  let eventCount = 0
  let match

  while ((match = eventPattern.exec(source))) {
    eventCount += 1
    const attribute = match[1]
    const handlerName = match[3].trim()
    const line = lineNumberAt(source, match.index)
    if (!/^[A-Za-z_$][\w$]*$/.test(handlerName)) {
      fail(`${relativePath(wxmlPath)}:${line} ${attribute} 必须引用静态处理器名，当前为 ${JSON.stringify(handlerName)}`)
      continue
    }
    if (checkedHandlers.has(handlerName)) continue
    checkedHandlers.add(handlerName)
    if (!hasStaticHandler(pageSource, handlerName)) {
      fail(`${relativePath(wxmlPath)}:${line} 处理器 ${handlerName} 未在 ${relativePath(pageJsPath)} 中找到`)
    }
  }
  return eventCount
}

function checkJavaScript(filePath) {
  const result = spawnSync(process.execPath, ['--check', filePath], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  })
  if (result.error) {
    fail(`${relativePath(filePath)} 无法执行 node --check: ${result.error.message}`)
    return
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    fail(`${relativePath(filePath)} JavaScript 语法检查失败${detail ? `:\n${detail}` : ''}`)
  }
}

function main() {
  const allFiles = walkFiles(PROJECT_ROOT)
  const jsonFiles = allFiles.filter((filePath) => path.extname(filePath) === '.json')
  const parsedJson = new Map()
  for (const jsonPath of jsonFiles) {
    const parsed = parseJsonFile(jsonPath)
    if (parsed != null) parsedJson.set(path.resolve(jsonPath), parsed)
  }

  const projectConfigPath = path.join(PROJECT_ROOT, 'project.config.json')
  const projectConfig = parsedJson.get(projectConfigPath)
  const configuredRoot = projectConfig && typeof projectConfig.miniprogramRoot === 'string'
    ? projectConfig.miniprogramRoot
    : 'miniprogram/'
  const miniprogramRoot = path.resolve(PROJECT_ROOT, configuredRoot)
  if (!isInside(PROJECT_ROOT, miniprogramRoot) || !fs.existsSync(miniprogramRoot)) {
    fail(`小程序根目录不存在或越界: ${configuredRoot}`)
  }

  const appJsonPath = path.join(miniprogramRoot, 'app.json')
  const appConfig = parsedJson.get(appJsonPath)
  if (!fs.existsSync(appJsonPath)) fail(`${relativePath(appJsonPath)} 不存在`)
  const rawRoutes = appConfig ? collectPageRoutes(appConfig) : []
  const seenRoutes = new Set()
  const pages = []
  for (const rawRoute of rawRoutes) {
    const page = normalizePageRoute(rawRoute, miniprogramRoot)
    if (!page) continue
    if (seenRoutes.has(page.route)) {
      fail(`app.json 重复注册页面: ${page.route}`)
      continue
    }
    seenRoutes.add(page.route)
    pages.push(page)
  }

  let eventCount = 0
  for (const page of pages) {
    const requiredFiles = Object.fromEntries(
      ['.js', '.json', '.wxml', '.wxss'].map((extension) => [extension, `${page.basePath}${extension}`])
    )
    for (const [extension, filePath] of Object.entries(requiredFiles)) {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        fail(`app.json 页面 ${page.route} 缺少 ${extension} 文件: ${relativePath(filePath)}`)
      }
    }
    if (fs.existsSync(requiredFiles['.js']) && fs.existsSync(requiredFiles['.wxml'])) {
      eventCount += validateEventHandlers(requiredFiles['.wxml'], requiredFiles['.js'])
    }
  }

  const wxmlFiles = allFiles.filter((filePath) => path.extname(filePath) === '.wxml')
  let tagCount = 0
  for (const wxmlPath of wxmlFiles) {
    tagCount += validateWxmlTags(wxmlPath).tagCount
  }

  const jsFiles = allFiles.filter((filePath) => path.extname(filePath) === '.js')
  for (const jsPath of jsFiles) checkJavaScript(jsPath)

  if (failures.length > 0) {
    console.error(`\n小程序静态校验失败（${failures.length} 项）:`)
    failures.forEach((message, index) => console.error(`${index + 1}. ${message}`))
    process.exitCode = 1
    return
  }

  console.log(
    `小程序静态校验通过: ${pages.length} 个页面, ${jsonFiles.length} 个 JSON, ` +
    `${wxmlFiles.length} 个 WXML / ${tagCount} 个标签, ${eventCount} 个事件绑定, ${jsFiles.length} 个 JS。`
  )
}

main()
