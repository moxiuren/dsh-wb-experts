/**
 * dsh-wb-experts —— WorkBuddy 专家选择器（Host 半侧）。
 *
 * 职责：把磁盘上的 WorkBuddy 专家库暴露给浏览器半侧，并负责「上岗 / 下岗」——
 * 也就是把某个专家目录 junction 到 dsh 的 skill 扫描根，让 dsh-skill-filesystem
 * 把它当成一个可加载的 skill。
 *
 * 数据源（路径都由 dsh home 推出，见下方 dshHome()）：
 *   LIB   = <dsh home>/wb-experts/           专家库（<name>/SKILL.md + _index.json）
 *   STAGE = <dsh home>/skills/               dsh skill 扫描根（rank 400）
 *   USAGE = <dsh home>/wb-experts/_usage.json  使用计数，用于「常用置顶」
 *
 * ---------------------------------------------------------------------------
 * v0.1.8 的三件事（都是为了「别的 dsh 用户能直接用」）：
 *
 * ① **路径不再写死 `~/.dsh`**。官方 dsh-skill-filesystem 用 resolveDshHome()
 *    解析扫描根，优先级是「显式配置 > $DSH_HOME > ~/.dsh」。本插件拿不到它的
 *    config（Cordis 的 config 是 apply(ctx, config) 的第二个参数，属于各插件自己），
 *    所以按同样优先级读 $DSH_HOME。写死会让自定义 DSH_HOME 的用户装完只看到空面板。
 *
 * ② **内置 Auto Mode 的 finder skill**。以前 `wb-expert-finder` 只存在于开发者本机
 *    的 `~/.dsh/skills/`，别人装了插件点「不确定用哪个？」会写入一个加载不了的 skill 名。
 *    现在它随包发布（`skills/wb-expert-finder/SKILL.md`），apply 时自动安装到扫描根，
 *    并把正文里的 `__CLI__` 占位符替换成本机真实的 CLI 路径。
 *    保护：只覆盖**本插件装的**那份（判据是 frontmatter 的 `metadata.managedBy`），
 *    用户自己的同名 skill 一律不动。
 *
 * ③ **CLI 换成 Node 实现**（`bin/wbx.mjs`）。旧 python 版把 `C:\Users\Admin\...`
 *    写死在源码里，换机器即废；而且 dsh 用户必然有 node、不一定有 python。
 *    顺带修掉一个让 finder 变成摆设的 bug：`_index.json` **没有 description 字段**，
 *    所以「按描述搜」以前是假的（实测 `渗透` 命中 0 位，而正文里有 6 位）。
 *    现在 `wbx index` 生成整份 SKILL.md 全文的搜索语料 `_search.json`。
 *
 * ---------------------------------------------------------------------------
 * v0.1.2 修掉的真 bug（HTTP 405 根因）—— 这一节是排障结论，别删：
 *
 * 旧版走 `connection.rpc.handle('/dsh-wb-experts', handler)`，浏览器侧一律
 * `transport failure ... HTTP 405`。三条实测事实：
 *   a) POST /dsh-wb-experts/list -> 405，GET -> 404（= 落到 SPA 兜底，路由不存在）
 *   b) POST /api/...             -> 401（= /api 路由活着，只是没过认证）
 *   c) 本机 dsh-path-paste / dsh-raw-html-v2 同样 405，且 `rpc.handle(` 在整个
 *      dsh node_modules 里零官方调用点
 *
 * 根因（读源码确证，非推测）：
 *   `HostConnectionService.register()` 末行是
 *       `owner.effect(() => owner.webServer.register(route), ...)`
 *   而 `owner` 就是 connection 服务自己的 `this.ctx`（client-connection 插件 ctx）。
 *   Cordis 的服务可见性是「祖先 fiber 链 + 显式 inject」，不是全局注册表
 *   （cordis/lib/index.js:673-699 的 ReflectService.handler.get）；webServer 只由
 *   `ctx.inject(["webServer"], ...)` 派生的子 ctx 可见，因此在 connection 的 ctx 上
 *   `owner.webServer` 直接抛 `cannot get property "webServer" without inject`。
 *   该异常从 `rpc.handle()` 同步抛出 → 第三方插件的 inject 回调中断 → 路由从未注册。
 *   因为异常发生在落痕行之后，日志看起来「注册过了」，极具误导性。
 *
 * 正路（官方同款，本文件 v0.1.2 采用）：
 *   `ctx.connection.fetch.register({ path: '/api/<name>', methods: ['POST'], ... })`
 *   —— 写进 connection 的 `fetchRoutes` Map，由官方 /api 路由的
 *   `createSharedFetchHandler` 优先命中（优先于 interceptor），全程不碰 webServer。
 *   官方使用者：dsh-api-session-controller（/api/file）、dsh-client-file-upload、
 *   dsh-client-ui-deliverables、dsh-session-log-export。
 *
 * 顺带否决的两条路（交接文档 §5 的建议）：
 *   * `rpc.intercept('/api', ...)` —— `/api` 的 interceptor 已被 dsh-api-gateway
 *     的 typertGateway 独占（dsh-api-gateway/lib/index.js:624），重复注册会抛
 *     `shared RPC channel "/api" already has an interceptor`。
 *   * 直接 `webServer.register` —— 需要 webServer 在插件 ctx 上可见，仍要先
 *     inject 它，且要自己处理认证（admit）与信封，不如 fetch 路由省事。
 *
 * 通道协议（浏览器侧 `connection.rpc.call('/api', 'dsh-wb-experts', { endpoint, args })`）：
 *   path     = /api/dsh-wb-experts
 *   payload  = { endpoint, args }
 *   endpoint = list      → { experts: [...], staged: [name], usage: {name: n} }
 *   endpoint = stage     → args { name } → 建 junction，返回 { staged: true }
 *   endpoint = unstage   → args { name } → 删 junction，返回 { staged: false }
 *   endpoint = touch     → args { name } → 计数 +1，返回 { usage }
 *   endpoint = ping      → args { client } → 客户端报到（排障用：证明浏览器半侧装载了）
 *
 * 信封必须严格贴合官方 schema（dsh-client-connection/lib/index.js:484-515）：
 *   请求 { type:"client-request", rpcId:string, method:string, payload:unknown }
 *   响应 { type:"server-response", rpcId, result }
 *        result = { ok:true, value } | { ok:false, error:{ code, message, details } }
 *   **error 必须是对象**：浏览器侧 parseConnectionResponse 会校验
 *   `error.code` / `error.message` / `error.details` 三者皆在，否则整个响应被判非法。
 *
 * 为什么上岗必须由 Host 做：junction 是文件系统操作，浏览器沙箱里做不了；
 * 而且 skill 扫描根在用户目录下，只有 Host 进程有稳定的绝对路径上下文。
 */

import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 稳定 Cordis 插件名。 */
const name = 'dsh-wb-experts'
/** 依赖的宿主服务：RPC 路由由 connection 提供。 */
const inject = ['connection']

/**
 * dsh home 解析：与官方 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` **同优先级**
 * （显式配置 > `$DSH_HOME` > `~/.dsh`）。
 *
 * 为什么不直接 import 那个包：它是 dsh 自身的依赖，**不在本插件的依赖树里**，
 * 从插件的安装目录 import 会解析失败。而且插件的 config 是 `apply(ctx, config)` 的
 * 第二个参数（skill-filesystem 的 `dshHome` 在它自己的 config 里），第三方插件拿不到，
 * 所以能读的只有环境变量这一层。
 *
 * 写死 `~/.dsh` 会让 `DSH_HOME` 自定义的用户装完插件后看到空面板 —— 这正是
 * 0.1.8 修掉的移植性问题。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/** 本插件包根目录（lib/ 的上一级），用于定位随包内置的 skill 与 CLI。 */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/** 随包内置的 CLI（上岗/下岗/搜索），安装 finder skill 时把它的绝对路径写进正文。 */
const CLI_PATH = join(PLUGIN_ROOT, 'bin', 'wbx.mjs')
/** 随包内置的 finder skill 源文件。 */
const FINDER_SRC = join(PLUGIN_ROOT, 'skills', 'wb-expert-finder', 'SKILL.md')

/**
 * 路由段名：浏览器侧 `rpc.call('/api', 'dsh-wb-experts', ...)`。
 */
const RPC_CALL_CHANNEL = '/api'
/** 路由段名：浏览器侧 `rpc.call('/api', 'dsh-wb-experts', ...)`。 */
const RPC_ENDPOINT = 'dsh-wb-experts'
/** 精确 Fetch 路由的 pathname。 */
const RPC_ROUTE_PATH = `${RPC_CALL_CHANNEL}/${RPC_ENDPOINT}`
/** 旧版通道名：只用于落痕实证「这条路在本机确实不通」，不再作为主路。 */
const LEGACY_CHANNEL = '/dsh-wb-experts'

/** 专家库根目录。 */
const LIB = join(dshHome(), 'wb-experts')
/** dsh 的 skill 扫描根（user-dsh，rank 400）。 */
const STAGE = join(dshHome(), 'skills')
/** 库索引（由 wb_experts_to_dsh_skill.py 生成）。 */
const INDEX_FILE = join(LIB, '_index.json')
/** 使用计数，用于常用置顶。 */
const USAGE_FILE = join(LIB, '_usage.json')
/** 启动落痕：用来从文件系统侧确认 Host 半侧到底有没有被 bundle 加载。 */
const BOOT_LOG = join(LIB, '_host-boot.log')

/** 错误消息提取。 */
function msg(e) {
  return e && e.message ? e.message : String(e)
}

/** 往启动落痕里追加一行（失败静默 —— 排障辅助不该影响主流程）。 */
function trace(line) {
  try {
    mkdirSync(LIB, { recursive: true })
    appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${line}\n`, 'utf-8')
  } catch {
    /* 忽略 */
  }
}

/** 统一成功返回。 */
function ok(value) {
  return { ok: true, value }
}

/**
 * 统一失败返回。
 * `error` 必须是 `{ code, message, details }` —— 浏览器侧 schema 会逐字段校验。
 */
function fail(message, code = `${name}/error`) {
  return { ok: false, error: { code, message: String(message), details: {} } }
}

/** 读 JSON，失败返回兜底值。 */
function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return fallback
  }
}

/** 专家库索引（448 条）。文件不存在时返回空数组而不是抛错。 */
function loadExperts() {
  const list = readJson(INDEX_FILE, [])
  return Array.isArray(list) ? list : []
}

/**
 * Auto Mode 的 meta-skill 名 —— 常驻在扫描根（`<dsh home>/skills/wb-expert-finder`）。
 * 浏览器半侧点「不确定用哪个？」就是把这个名字写进输入框。
 */
const FINDER_SKILL = 'wb-expert-finder'

/** finder skill 的安装目标目录。 */
const FINDER_DIR = join(STAGE, FINDER_SKILL)
/** finder skill 的安装目标文件。 */
const FINDER_DST = join(FINDER_DIR, 'SKILL.md')

/** 本插件版本（与 package.json 对齐；写进 finder skill 的 metadata 作为升级判据）。 */
const PLUGIN_VERSION = '0.1.8'

/**
 * 读出随包内置的 finder skill 正文，并把路径占位符替换成本机真实路径。
 *
 * 为什么不预先把路径写进文件：插件装在哪台机器、哪个目录是安装时才知道的；
 * 写死就会像 0.1.7 之前那样只在本机可用。
 */
function finderSource() {
  const raw = readFileSync(FINDER_SRC, 'utf-8')
  return raw.replaceAll('__CLI__', CLI_PATH).replaceAll('__VERSION__', PLUGIN_VERSION)
}

/**
 * 从一份 SKILL.md 里取 `metadata.managedBy`（没有则返回空串）。
 *
 * 只做**极简** YAML 解析：我们要的两个键都在文件头部的前几行，且都是标量，
 * 引入一个 YAML 依赖只为读一个标记不值得。解析不到就返回空串 —— 语义是
 * 「不是本插件管的」，宁可不动它。
 */
function managedBy(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m) return ''
  const line = m[1].match(/^\s*managedBy:\s*(.+)$/m)
  return line ? line[1].trim().replace(/^["']|["']$/g, '') : ''
}

/**
 * 安装 / 更新 finder skill（Auto Mode 的载体）。
 *
 * 三种情形：
 *   ① 目标不存在            → 写入（插件自带，所以新用户开箱即用）
 *   ② 目标是我们装的旧版本  → 覆盖（插件升级时同步正文）
 *   ③ 目标不是我们管的      → **不动**（用户自己的同名 skill 神圣不可侵犯）
 *
 * 幂等：内容一致时直接返回，不做无谓写入（避免触发 watcher 重扫）。
 */
function installFinderSkill() {
  let want
  try {
    want = finderSource()
  } catch (e) {
    trace(`finder skill 源文件读不到，跳过安装：${msg(e)}`)
    return { installed: false, reason: 'source-missing' }
  }

  const exists = existsSync(FINDER_DST)
  if (exists) {
    let cur = ''
    try {
      cur = readFileSync(FINDER_DST, 'utf-8')
    } catch (e) {
      trace(`finder skill 读不到，跳过：${msg(e)}`)
      return { installed: false, reason: 'unreadable' }
    }
    if (managedBy(cur) !== name) {
      trace(`finder skill 已存在且不是本插件安装的，不覆盖：${FINDER_DST}`)
      return { installed: false, reason: 'foreign' }
    }
    if (cur === want) return { installed: true, reason: 'up-to-date' }
  }

  try {
    mkdirSync(FINDER_DIR, { recursive: true })
    writeFileSync(FINDER_DST, want, 'utf-8')
    trace(`finder skill 已安装：${FINDER_DST}`)
    return { installed: true, reason: exists ? 'updated' : 'created' }
  } catch (e) {
    trace(`finder skill 安装失败：${msg(e)}`)
    return { installed: false, reason: `write-failed: ${msg(e)}` }
  }
}

/** 使用计数表。 */
function loadUsage() {
  const u = readJson(USAGE_FILE, {})
  return u && typeof u === 'object' && !Array.isArray(u) ? u : {}
}

/** 落盘使用计数（原子替换，避免半截文件）。 */
function saveUsage(usage) {
  try {
    mkdirSync(LIB, { recursive: true })
    const tmp = `${USAGE_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(usage, null, 2), 'utf-8')
    // rename 在同卷上是原子的；失败则退回直接写。
    try {
      renameSync(tmp, USAGE_FILE)
    } catch {
      writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2), 'utf-8')
    }
  } catch {
    /* 计数写失败不影响主流程 */
  }
}

/**
 * 当前已上岗的专家名。
 *
 * 判据是**真实路径落在专家库内**，而不是「目录存在」——`~/.dsh/skills` 下
 * 还有用户自己的 skill（如 notion-agent-hub 是指向 Vault 的符号链接），
 * 那些不该被算成本插件的上岗项。
 */
function stagedSet() {
  const out = []
  let libReal
  try {
    libReal = realpathSync(LIB)
  } catch {
    return out
  }
  let entries
  try {
    entries = readdirSync(STAGE, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    const p = join(STAGE, e.name)
    try {
      if (realpathSync(p).startsWith(libReal)) out.push(e.name)
    } catch {
      /* 断链的 junction：忽略 */
    }
  }
  return out
}

/** 跑一条 cmd 命令（junction 的建/删都走 cmd，Node 原生 API 在 Windows 上不建 junction）。 */
function runCmd(args) {
  return new Promise((resolve) => {
    execFile('cmd', ['/c', ...args], { windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, message: String(stderr || err.message).trim() })
      else resolve({ ok: true, message: String(stdout).trim() })
    })
  })
}

/** 合法性：名字必须是库里真实存在的一个 skill 目录，杜绝路径穿越。 */
function resolveExpert(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return null
  const dir = join(LIB, name)
  if (!existsSync(join(dir, 'SKILL.md'))) return null
  return dir
}

/** 上岗：把专家目录 junction 到扫描根。 */
async function stage(name) {
  const dir = resolveExpert(name)
  if (!dir) return fail(`未知专家：${name}`)
  const dst = join(STAGE, name)
  if (existsSync(dst)) return ok({ staged: true, already: true })
  try {
    mkdirSync(STAGE, { recursive: true })
  } catch {
    /* 已存在即忽略 */
  }
  const r = await runCmd(['mklink', '/J', dst, dir])
  if (!r.ok) return fail(`上岗失败：${r.message}`)
  return ok({ staged: true, already: false })
}

/** 下岗：删 junction（rmdir 只删链接，不动源目录）。 */
async function unstage(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return fail('非法名称')
  const dst = join(STAGE, name)
  if (!existsSync(dst)) return ok({ staged: false, already: true })
  // 只删指向专家库的链接，别动用户自己的 skill。
  const staged = stagedSet()
  if (!staged.includes(name)) return fail('该名称不是本插件上岗的专家，拒绝删除')
  const r = await runCmd(['rmdir', dst])
  if (!r.ok) return fail(`下岗失败：${r.message}`)
  return ok({ staged: false, already: false })
}

/** finder skill 的安装状态（随 list 一起返回，省一次 RPC）。 */
function finderStatus() {
  if (!existsSync(FINDER_DST)) return { installed: false, managed: false, path: FINDER_DST }
  let managed = false
  try {
    managed = managedBy(readFileSync(FINDER_DST, 'utf-8')) === name
  } catch {
    /* 读不到就当不是我们管的 */
  }
  return { installed: true, managed, path: FINDER_DST }
}

/**
 * 业务分发：endpoint + args → `{ ok, value }` / `{ ok:false, error:{...} }`。
 * 与传输层解耦，便于离线自测直接调用。
 */
async function dispatch(endpoint, args) {
  trace(`RPC 收到 ${endpoint}`)
  const a = args && typeof args === 'object' ? args : {}
  try {
    if (endpoint === 'ping') {
      const v = a.client ? a.client : 'unknown'
      trace(`ping 来自客户端版本 ${v}`)
      return ok({ host: true, client: v, lib: LIB, stage: STAGE })
    }

    if (endpoint === 'list') {
      const experts = loadExperts()
      const staged = stagedSet()
      const usage = loadUsage()
      return ok({
        experts,
        staged,
        usage,
        lib: LIB,
        stage: STAGE,
        total: experts.length,
        // Auto Mode 的载体状态：面板据此决定「不确定用哪个？」那一行是否可用
        finder: finderStatus(),
      })
    }

    if (endpoint === 'finder') {
      return ok({ name: FINDER_SKILL, cli: CLI_PATH, ...finderStatus() })
    }

    if (endpoint === 'stage') return await stage(a.name)
    if (endpoint === 'unstage') return await unstage(a.name)

    if (endpoint === 'touch') {
      const n = a.name
      if (typeof n !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(n)) return fail('非法名称')
      const usage = loadUsage()
      usage[n] = (Number(usage[n]) || 0) + 1
      saveUsage(usage)
      return ok({ usage })
    }

    return fail(`未知端点：${endpoint}`, `${name}/unknown-endpoint`)
  } catch (e) {
    return fail(msg(e))
  }
}

/** 组装官方 server-response 信封。 */
function envelope(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result })
}

/**
 * 精确 Fetch 路由的处理器。
 *
 * 这里手工实现了一遍官方 `rpcFetchHandler`（dsh-client-connection/lib/index.js:673-702）
 * 的信封语义 —— 因为该函数未导出，而 `rpc.intercept('/api', ...)` 的槽位已被
 * dsh-api-gateway 的 typertGateway 独占。逐条对齐：
 *   * 非 POST → 404
 *   * content-type 非 application/json → 415
 *   * body 非 JSON → 400
 *   * 信封非法 → 200 + `{ok:false, error:{...}}`（保持 rpcId 可关联）
 *   * 业务抛错 → 500（与官方一致）
 *
 * @param request - 标准 Request（requestBody 已声明为 buffered）。
 * @returns 标准 Response。
 */
async function handleFetch(request) {
  try {
    if (request.method !== 'POST') return new Response('not found', { status: 404 })
    const mediaType = String(request.headers.get('content-type') || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase()
    if (mediaType !== 'application/json') {
      return new Response('content type must be application/json', { status: 415 })
    }

    let body
    try {
      body = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }

    const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
    if (!body || typeof body !== 'object' || body.type !== 'client-request') {
      trace('收到非法信封（缺 type=client-request）')
      return envelope(rpcId, fail('非法请求信封：缺 type=client-request', `${name}/bad-envelope`))
    }

    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {}
    const endpoint = typeof payload.endpoint === 'string' ? payload.endpoint : ''
    return envelope(rpcId, await dispatch(endpoint, payload.args))
  } catch (e) {
    trace(`RPC 处理异常：${msg(e)}`)
    return new Response(`handler failure: ${String(e)}`, { status: 500 })
  }
}

/**
 * Host 插件体：装好 Auto Mode 的 finder skill，并把专家库挂到官方 `/api` 路由之下。
 *
 * 顺序有讲究：**先装 finder skill，再注册路由**。装 skill 只碰文件系统，
 * 不依赖 connection，所以放在最外层 —— 万一 connection 不可用，Auto Mode 至少还在。
 * 包 try/catch 是因为「装不上」只该损失一个可选功能，绝不该让插件整体 apply 失败
 * （那会让整个 web boot 掉一个 entry）。
 *
 * @param ctx - Host 根上下文。
 */
export function apply(ctx) {
  trace(`apply 进入 pid=${process.pid}`)

  // ---- 0. 内置的 Auto Mode finder skill（开箱即用，不依赖专家库）--------
  try {
    const r = installFinderSkill()
    trace(`finder skill: installed=${r.installed} reason=${r.reason} -> ${FINDER_DST}`)
  } catch (e) {
    trace(`finder skill 安装异常：${msg(e)}`)
  }

  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection
    if (!connection) {
      trace('connection 服务取不到，放弃注册')
      return
    }
    const hasFetch = !!(connection.fetch && typeof connection.fetch.register === 'function')
    const hasRpc = !!(connection.rpc && typeof connection.rpc.handle === 'function')
    trace(`connection 注入回调执行 hasFetch=${hasFetch} hasRpc=${hasRpc}`)

    // ---- 主路：精确 Fetch 路由（官方机制，不碰 webServer）----------------
    if (hasFetch) {
      try {
        ctx.effect(
          () =>
            connection.fetch.register({
              path: RPC_ROUTE_PATH,
              methods: ['POST'],
              requestBody: 'buffered',
              fetch: handleFetch,
            }),
          `${name}: ${RPC_ROUTE_PATH} Fetch route`,
        )
        trace(`RPC 路由 ${RPC_ROUTE_PATH} 注册成功（connection.fetch.register）`)
      } catch (e) {
        trace(`RPC 路由 ${RPC_ROUTE_PATH} 注册失败：${msg(e)}`)
      }
    } else {
      trace('connection.fetch 不可用，无法注册 /api 路由')
    }

    // ---- 留痕：实证旧路 rpc.handle 在本机为什么不通 -----------------------
    // 只试一次并把异常写进落痕。它既是「405 根因」的永久证据，也不影响主路
    // （register() 的 effect 抛错后，Cordis 会把这次 effect 的残留清理干净）。
    if (hasRpc) {
      try {
        connection.rpc.handle(LEGACY_CHANNEL, dispatch)
        trace(`旧路 rpc.handle(${LEGACY_CHANNEL}) 注册成功（本机罕见，说明 webServer 可见）`)
      } catch (e) {
        trace(`旧路 rpc.handle(${LEGACY_CHANNEL}) 注册失败（预期，405 根因证据）：${msg(e)}`)
      }
    }
  })
}

export {
  name,
  inject,
  dispatch,
  handleFetch,
  RPC_ROUTE_PATH,
  RPC_CALL_CHANNEL,
  RPC_ENDPOINT,
  LEGACY_CHANNEL,
  // 供离线自测直接调用（不启动 dsh 也能验证文件系统行为）
  dshHome,
  installFinderSkill,
  finderSource,
  managedBy,
  FINDER_SKILL,
  FINDER_DST,
  CLI_PATH,
  PLUGIN_VERSION,
  LIB,
  STAGE,
}
