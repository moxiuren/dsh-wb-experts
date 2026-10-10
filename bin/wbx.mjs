#!/usr/bin/env node
/**
 * wbx —— WorkBuddy 专家库在 dsh 里的「上岗 / 下岗」命令行。
 *
 * 与 lib/index.js 用**同一套路径解析与同一套判定**：库在 `<dshHome>/wb-experts`，
 * 上岗就是把它 junction / symlink 到扫描根 `<dshHome>/skills`。dsh-skill-filesystem
 * 用 Chokidar 监视该根，增删**无需重启**，下一个模型步骤就会刷新会话目录。
 *
 * 为什么用 Node 而不是 Python：
 *   dsh 用户必然有 node（harness 自己就是 node 跑的），不一定有 python；
 *   而且 python 版把 `C:\Users\Admin\...` 写死在源码里，换台机器就废。
 *   路径一律由 `$DSH_HOME` → `~/.dsh` 推出来（与官方 resolveDshHome 同优先级）。
 *
 * 用法：
 *   node bin/wbx.mjs list [关键词]      列出库中专家（关键词匹配 名/中文名/英文名/职业）
 *   node bin/wbx.mjs find <关键词...>   多词 OR 搜索（整份 SKILL.md 全文）
 *   node bin/wbx.mjs use <name> [...]   上岗（建链接，热加载生效）
 *   node bin/wbx.mjs off <name> [...]   下岗（只删本库建的链接）
 *   node bin/wbx.mjs on                 列出当前已上岗
 *   node bin/wbx.mjs show <name>        打印某位专家的 SKILL.md
 *   node bin/wbx.mjs index              重建搜索索引 `_search.json`（换库/换版本后跑一次）
 *   node bin/wbx.mjs doctor             体检：库、索引、扫描根、搜索索引是否齐备
 *   node bin/wbx.mjs path               打印解析出的库/扫描根路径（排障用）
 *
 * 加 `--json` 输出机器可读结果（agent 更好消费）。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要一个 `_search.json`（实测结论，别删）：
 *
 * `_index.json` **没有 `description` 字段**（生成器只写了 12 个结构化字段），
 * 所以「按描述搜」这条路以前是假的 —— 实测 448 位里 `渗透` 命中 0 位、
 * `pentest` 命中 0 位，而正文里其实分别有 6 位。
 * 更糟的是**只搜 frontmatter description 也不够**：`渗透` 在 description 里同样 0 位，
 * 全文命中 6 位 —— 专家的自我介绍写在正文里，不在 description 里。
 *
 * 所以搜索语料必须取**整份 SKILL.md 全文**（小写化 + 空白归一），
 * 落成 `_search.json` 一次生成、反复使用：448 份全文约 3 MB，加载约几十毫秒，
 * 比每次搜索现场读 448 个文件（约 3 MB IO）快一个数量级。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/**
 * dsh home：与官方 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` 同优先级。
 * 我们不复用那个包 —— 它是 dsh 自身的依赖，不在本插件的依赖树里，import 会失败。
 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

const DSH_HOME = resolveDshHome()
/** 专家库根：448 个 `<name>/SKILL.md` + `_index.json`，**不在扫描根里**，所以零上下文开销。 */
const LIB = process.env.DSH_WBX_LIB ? resolve(process.env.DSH_WBX_LIB) : join(DSH_HOME, 'wb-experts')
/** dsh skill 扫描根（官方 user-dsh，rank 400）。 */
const STAGE = process.env.DSH_WBX_STAGE ? resolve(process.env.DSH_WBX_STAGE) : join(DSH_HOME, 'skills')
const INDEX = join(LIB, '_index.json')
const SEARCH = join(LIB, '_search.json')

/** 合法 skill 名：与 Host 半侧同一正则，杜绝路径穿越。 */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const JSON_OUT = process.argv.includes('--json')
/** 去掉 `--json` 后的位置参数。 */
const argv = process.argv.slice(2).filter((a) => a !== '--json')

function fail(msg) {
  if (JSON_OUT) process.stdout.write(`${JSON.stringify({ ok: false, error: String(msg) })}\n`)
  else process.stderr.write(`${msg}\n`)
  process.exit(1)
}

function load() {
  if (!existsSync(INDEX)) {
    fail(`库索引不存在：${INDEX}\n先用转换器生成专家库（见 README「前置条件」），或检查 $DSH_HOME。`)
  }
  try {
    const data = JSON.parse(readFileSync(INDEX, 'utf-8'))
    if (!Array.isArray(data)) throw new Error('索引不是数组')
    return data
  } catch (e) {
    fail(`库索引无法解析：${INDEX}\n${e && e.message ? e.message : e}`)
  }
}

/**
 * 当前已上岗的专家名。
 *
 * 判据是**真实路径落在专家库内**，而不是「目录存在」—— 扫描根里还混着用户自己的
 * skill，那些不该被算成本库的上岗项，更不该被 `off` 删掉。
 */
function staged() {
  let libReal
  try {
    libReal = realpathSync(LIB)
  } catch {
    return []
  }
  let entries
  try {
    entries = readdirSync(STAGE, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    let real
    try {
      real = realpathSync(join(STAGE, e.name))
    } catch {
      continue // 断链的链接：忽略
    }
    // 必须真在库内（realpath 前缀 + 分隔符边界），避免 `wb-experts-old` 这类同前缀误判
    if (real === libReal || real.startsWith(libReal + sep)) out.push(e.name)
  }
  return out.sort()
}

/** 建目录链接。Windows 用 junction（`mklink /J`，不需要管理员）；其余平台用 symlink。 */
function link(src, dst) {
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', dst, src], { windowsHide: true, stdio: 'pipe' })
    } else {
      execFileSync('ln', ['-s', src, dst], { stdio: 'pipe' })
    }
    return { ok: true, message: '' }
  } catch (e) {
    const out = `${(e && e.stdout) || ''}${(e && e.stderr) || ''}`.trim()
    return { ok: false, message: out || (e && e.message) || 'unknown error' }
  }
}

/** 删目录链接。`rmdir` 只摘链接，不会递归删掉源目录里的内容。 */
function unlink(dst) {
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'rmdir', dst], { windowsHide: true, stdio: 'pipe' })
    } else {
      execFileSync('rm', ['-f', dst], { stdio: 'pipe' })
    }
    return { ok: true, message: '' }
  } catch (e) {
    const out = `${(e && e.stdout) || ''}${(e && e.stderr) || ''}`.trim()
    return { ok: false, message: out || (e && e.message) || 'unknown error' }
  }
}

/** 一行摘要用的字段（索引里字段缺失时用空串兜底）。 */
function row(r) {
  return {
    name: r.dsh_name,
    zh: r.zh || '',
    en: r.en || '',
    profession: r.profession || '',
    category: r.category || '',
    category_zh: r.category_zh || '',
    expertType: r.expertType || '',
    subskills: (r.subskills || []).length,
  }
}

/** 结构化字段的 haystack（`_search.json` 缺失时的兜底语料）。 */
function structHay(r) {
  return [r.dsh_name, r.zh, r.en, r.profession, r.category, r.category_zh, r.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/** 从 SKILL.md 里取 frontmatter 的 description（取不到返回空串）。 */
function frontmatterDescription(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m) return ''
  const d = m[1].match(/^description:\s*(.+)$/m)
  if (!d) return ''
  return d[1].trim().replace(/^["']|["']$/g, '')
}

/** 空白归一（搜索语料没必要保留换行与缩进）。 */
function squash(s) {
  return s.replace(/\s+/g, ' ').trim()
}

/** 读取搜索索引；缺失或过期返回 null（调用方退回结构化字段）。 */
function loadSearch() {
  if (!existsSync(SEARCH)) return null
  try {
    const data = JSON.parse(readFileSync(SEARCH, 'utf-8'))
    if (!data || !Array.isArray(data.rows)) return null
    return new Map(data.rows.map((r) => [r.name, r.text]))
  } catch {
    return null
  }
}

/**
 * 重建 `_search.json`：把每份 SKILL.md 的**全文**归一成一行搜索语料。
 *
 * 只收 `<name>/SKILL.md` 主文件，不收 `references/` 子技能 —— 子技能是专家的
 * 附属材料，把它并进语料会让「按任务词找专家」的信噪比变差。
 */
function cmdIndex() {
  const idx = load()
  const rows = []
  const missing = []
  for (const r of idx) {
    const f = join(LIB, r.dsh_name, 'SKILL.md')
    if (!existsSync(f)) {
      missing.push(r.dsh_name)
      continue
    }
    const text = readFileSync(f, 'utf-8')
    // 语料 = 结构化字段 + description + 正文全文
    const blob = squash(`${structHay(r)} ${frontmatterDescription(text)} ${text}`).toLowerCase()
    rows.push({ name: r.dsh_name, text: blob })
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const payload = { version: 1, builtFrom: INDEX, count: rows.length, rows }
  // 原子替换：先写临时文件再 rename，避免半截文件被后续 find 读到
  const tmp = `${SEARCH}.tmp`
  writeFileSync(tmp, JSON.stringify(payload), 'utf-8')
  try {
    renameSync(tmp, SEARCH)
  } catch {
    writeFileSync(SEARCH, JSON.stringify(payload), 'utf-8')
  }
  const size = existsSync(SEARCH) ? statSync(SEARCH).size : 0
  if (JSON_OUT) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, built: rows.length, missing, file: SEARCH, bytes: size })}\n`,
    )
    return
  }
  process.stdout.write(`搜索索引已重建：${rows.length} 位 -> ${SEARCH}（${(size / 1048576).toFixed(1)} MB）\n`)
  if (missing.length) process.stdout.write(`注意：${missing.length} 位缺 SKILL.md，未进索引：${missing.slice(0, 5).join(', ')}…\n`)
}

function cmdList(kw) {
  const idx = load()
  const k = (kw || '').toLowerCase()
  const on = new Set(staged())
  const rows = idx.filter((r) => {
    if (!k) return true
    return structHay(r).includes(k)
  })
  if (JSON_OUT) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, total: idx.length, matched: rows.length, staged: [...on], rows: rows.map((r) => ({ ...row(r), staged: on.has(r.dsh_name) })) })}\n`,
    )
    return
  }
  process.stdout.write(`库内 ${idx.length} 位专家，匹配 ${rows.length} 位（[ON] = 已上岗）\n\n`)
  for (const r of rows) {
    const mark = on.has(r.dsh_name) ? '[ON] ' : '     '
    process.stdout.write(`${mark}${r.dsh_name.padEnd(34)} ${(r.zh || '').padEnd(12)} ${r.profession || ''}\n`)
  }
  process.stdout.write(`\n上岗目录：${STAGE}\n`)
}

/**
 * 多词 **OR** 匹配，语料是整份 SKILL.md 全文（见文件头 `_search.json` 一节）。
 *
 * 为什么必须多词：库里存的是专家的**自称**（「安全工程师」），而人想的是**任务词**
 * （「渗透测试」）。单词子串匹配会直接漏掉，一次给 2-4 个同义词命中率高得多。
 */
function cmdFind(args) {
  const idx = load()
  /**
   * 关键词：**每个参数再按空白拆一次**。
   *
   * 为什么不能只取参数本身：文档里的用法是 `find "渗透 安全 pentest"`（整串加引号，
   * 与旧 python 版一致），而 shell 会把它作为**一个**参数递进来。若只按参数拆词，
   * 就会拿 `"渗透 安全 pentest"` 整串去 includes —— 必然 0 命中。
   * 两种写法都支持：`find "渗透 安全 pentest"` 与 `find 渗透 安全 pentest` 等价。
   */
  const list = (args || [])
    .flatMap((a) => String(a).split(/\s+/))
    .map((k) => k.toLowerCase())
    .filter(Boolean)
  if (list.length === 0) fail('find 需要至少一个关键词：wbx.mjs find "渗透 安全 pentest"')

  const search = loadSearch()
  const corpusOf = search
    ? (r) => search.get(r.dsh_name) || structHay(r)
    : (r) => structHay(r)

  const hits = idx.filter((r) => {
    const hay = corpusOf(r)
    return list.some((k) => hay.includes(k))
  })
  const degraded = search === null
  if (JSON_OUT) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, keywords: list, matched: hits.length, corpus: degraded ? 'index-only' : 'fulltext', rows: hits.map(row) })}\n`,
    )
    return
  }
  process.stdout.write(`命中 ${hits.length} 位（关键词 ${list.join(' / ')}）：\n\n`)
  for (const r of hits) {
    const x = row(r)
    process.stdout.write(`${x.name.padEnd(34)} ${x.zh.padEnd(14)} ${x.profession}\n`)
    process.stdout.write(
      `     子技能 ${x.subskills} 个 | 分类 ${x.category_zh} (${x.category}) | ${x.expertType}\n`,
    )
  }
  if (degraded) {
    process.stdout.write(
      `\n[注意] 没有搜索索引 ${SEARCH}，本次只搜了结构化字段（命中率低）。\n       跑一次 \`wbx index\` 重建（约 3 MB，一次性）。\n`,
    )
  }
}

function cmdUse(names) {
  const idx = new Map(load().map((r) => [r.dsh_name, r]))
  if (names.length === 0) fail('use 需要至少一个专家名')
  try {
    mkdirSync(STAGE, { recursive: true })
  } catch {
    /* 已存在即忽略 */
  }
  const results = []
  for (const n of names) {
    if (!NAME_RE.test(n)) {
      results.push({ name: n, ok: false, message: '非法名称（只允许 [a-z0-9-]）' })
      continue
    }
    if (!idx.has(n)) {
      results.push({ name: n, ok: false, message: '库里没有这位专家（用 find/list 查准确名字）' })
      continue
    }
    const dst = join(STAGE, n)
    if (existsSync(dst)) {
      results.push({ name: n, ok: true, already: true, message: '已上岗' })
      continue
    }
    const r = link(join(LIB, n), dst)
    const rec = idx.get(n)
    results.push({
      name: n,
      ok: r.ok,
      already: false,
      zh: rec.zh || '',
      profession: rec.profession || '',
      message: r.ok ? '上岗成功' : r.message,
    })
  }
  const okCount = results.filter((r) => r.ok).length
  if (JSON_OUT) {
    process.stdout.write(
      `${JSON.stringify({ ok: okCount === results.length, staged: okCount, failed: results.length - okCount, results })}\n`,
    )
    return
  }
  for (const r of results) {
    process.stdout.write(
      r.ok
        ? `[上岗] ${r.name}${r.already ? '（已存在）' : ''}  ->  ${r.zh || ''} ${r.profession || ''}\n`
        : `[失败] ${r.name}: ${r.message}\n`,
    )
  }
  process.stdout.write(
    `\n完成 ${okCount} 个 / 失败 ${results.length - okCount} 个。dsh 会热加载，下一个模型步骤即可用 skill 工具加载。\n`,
  )
}

function cmdOff(names) {
  if (names.length === 0) fail('off 需要至少一个专家名')
  const on = new Set(staged())
  const results = []
  for (const n of names) {
    const dst = join(STAGE, n)
    if (!existsSync(dst)) {
      results.push({ name: n, ok: true, already: true, message: '未上岗' })
      continue
    }
    // 只删本库建的上岗项 —— 用户自己的 skill 绝不动
    if (!on.has(n)) {
      results.push({ name: n, ok: false, message: '该名称不是本库上岗的专家，拒绝删除' })
      continue
    }
    const r = unlink(dst)
    results.push({ name: n, ok: r.ok, already: false, message: r.ok ? '已下岗' : r.message })
  }
  const okCount = results.filter((r) => r.ok).length
  if (JSON_OUT) {
    process.stdout.write(
      `${JSON.stringify({ ok: okCount === results.length, unstaged: okCount, failed: results.length - okCount, results })}\n`,
    )
    return
  }
  for (const r of results) {
    process.stdout.write(
      r.ok ? `[下岗] ${r.name}${r.already ? '（本来就未上岗）' : ''}\n` : `[失败] ${r.name}: ${r.message}\n`,
    )
  }
  process.stdout.write(`\n共下岗 ${okCount} 个。\n`)
}

function cmdOn() {
  const on = staged()
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ ok: true, count: on.length, staged: on })}\n`)
    return
  }
  process.stdout.write(`当前上岗 ${on.length} 位：\n`)
  if (on.length === 0) process.stdout.write('  （无）\n')
  else for (const n of on) process.stdout.write(`  ${n}\n`)
}

function cmdShow(name) {
  if (!name || !NAME_RE.test(name)) fail('show 需要一个合法的专家名')
  const p = join(LIB, name, 'SKILL.md')
  if (!existsSync(p)) fail(`库里没有 ${name}`)
  process.stdout.write(readFileSync(p, 'utf-8'))
}

/** 体检：把「能不能用」的每个前置条件逐个查出来，而不是等搜索返回 0 才猜。 */
function cmdDoctor() {
  const libExists = existsSync(LIB)
  const idxExists = existsSync(INDEX)
  let total = 0
  if (idxExists) {
    try {
      total = JSON.parse(readFileSync(INDEX, 'utf-8')).length
    } catch {
      /* 上面已判 */
    }
  }
  const searchExists = existsSync(SEARCH)
  const report = {
    ok: libExists && idxExists && total > 0,
    dshHome: DSH_HOME,
    lib: LIB,
    libExists,
    index: INDEX,
    indexExists: idxExists,
    experts: total,
    searchIndex: SEARCH,
    searchIndexExists: searchExists,
    stage: STAGE,
    staged: staged(),
  }
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return
  }
  process.stdout.write(
    `dsh home     : ${report.dshHome}\n` +
      `专家库       : ${report.lib} ${libExists ? '✓' : '✗ 不存在'}\n` +
      `库索引       : ${idxExists ? `✓ ${total} 位` : '✗ 缺失（用转换器生成）'}\n` +
      `搜索索引     : ${searchExists ? '✓' : '✗ 缺失 —— find 命中率会很低，跑一次 `wbx index`'}\n` +
      `扫描根       : ${report.stage}\n` +
      `已上岗       : ${report.staged.length ? report.staged.join(', ') : '（无）'}\n`,
  )
  if (!report.ok) process.exit(1)
}

function cmdPath() {
  const info = {
    ok: true,
    dshHome: DSH_HOME,
    lib: LIB,
    stage: STAGE,
    index: INDEX,
    searchIndex: SEARCH,
    libExists: existsSync(LIB),
    staged: staged(),
  }
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify(info)}\n`)
    return
  }
  process.stdout.write(
    `dsh home : ${info.dshHome}\n库       : ${info.lib}${info.libExists ? '' : '（不存在）'}\n扫描根   : ${info.stage}\n索引     : ${info.index}\n搜索索引 : ${info.searchIndex}\n已上岗   : ${info.staged.length ? info.staged.join(', ') : '（无）'}\n`,
  )
}

function usage() {
  const self = process.argv[1] || 'wbx.mjs'
  process.stdout.write(
    `wbx —— WorkBuddy 专家库上岗管理器（库 ${LIB}）\n\n` +
      `用法：node ${self} <命令> [参数] [--json]\n\n` +
      `  list [关键词]      列出专家（关键词匹配 名/中文名/英文名/职业/分类）\n` +
      `  find <关键词...>   多词 OR 搜索（整份 SKILL.md 全文）\n` +
      `  use <name> [...]   上岗（建链接，热加载生效）\n` +
      `  off <name> [...]   下岗（只删本库建的链接）\n` +
      `  on                 列出当前已上岗\n` +
      `  show <name>        打印某位专家的 SKILL.md\n` +
      `  index              重建搜索索引 _search.json\n` +
      `  doctor             体检库/索引/扫描根\n` +
      `  path               打印解析出的路径（排障用）\n`,
  )
}

function main() {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'list':
      return cmdList(rest[0])
    case 'find':
      return cmdFind(rest)
    case 'use':
      return cmdUse(rest)
    case 'off':
      return cmdOff(rest)
    case 'on':
      return cmdOn()
    case 'show':
      return cmdShow(rest[0])
    case 'index':
      return cmdIndex()
    case 'doctor':
      return cmdDoctor()
    case 'path':
      return cmdPath()
    default:
      return usage()
  }
}

main()
