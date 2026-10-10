/**
 * dsh-wb-experts —— WorkBuddy 专家选择器（Host 半侧）。
 *
 * 职责：把磁盘上的 WorkBuddy 专家库暴露给浏览器半侧，并负责「上岗 / 下岗」——
 * 也就是把某个专家目录 junction 到 dsh 的 skill 扫描根，让 dsh-skill-filesystem
 * 把它当成一个可加载的 skill。
 *
 * 数据源：
 *   LIB   = ~/.dsh/wb-experts/           专家库（448 个 <name>/SKILL.md + _index.json）
 *   STAGE = ~/.dsh/skills/               dsh skill 扫描根（rank 400）
 *   USAGE = ~/.dsh/wb-experts/_usage.json  使用计数，用于「常用置顶」
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
import { join } from 'node:path'

/** 稳定 Cordis 插件名。 */
const name = 'dsh-wb-experts'
/** 依赖的宿主服务：RPC 路由由 connection 提供。 */
const inject = ['connection']
/**
 * 浏览器侧调用时使用的 channel（官方共享通道）。
 * 注意：这里**不是**要注册一个叫 /api 的 RPC 通道，而是把我们的精确 Fetch 路由
 * 挂在 /api 之下，由官方 /api 路由转发进来。
 */
const RPC_CALL_CHANNEL = '/api'
/** 路由段名：浏览器侧 `rpc.call('/api', 'dsh-wb-experts', ...)`。 */
const RPC_ENDPOINT = 'dsh-wb-experts'
/** 精确 Fetch 路由的 pathname。 */
const RPC_ROUTE_PATH = `${RPC_CALL_CHANNEL}/${RPC_ENDPOINT}`
/** 旧版通道名：只用于落痕实证「这条路在本机确实不通」，不再作为主路。 */
const LEGACY_CHANNEL = '/dsh-wb-experts'

/** 专家库根目录。 */
const LIB = join(homedir(), '.dsh', 'wb-experts')
/** dsh 的 skill 扫描根（user-dsh，rank 400）。 */
const STAGE = join(homedir(), '.dsh', 'skills')
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
      })
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
 * Host 插件体：把专家库挂到官方 `/api` 路由之下。
 * @param ctx - Host 根上下文。
 */
export function apply(ctx) {
  trace(`apply 进入 pid=${process.pid}`)
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

export { name, inject, dispatch, handleFetch, RPC_ROUTE_PATH, RPC_CALL_CHANNEL, RPC_ENDPOINT, LEGACY_CHANNEL }
