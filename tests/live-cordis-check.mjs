/**
 * 实机验证（不需要重启 dsh）：用真实 dsh 源码，在**独立 Node 进程**里装配一个
 * 最小 cordis composition，把 dsh-wb-experts 的 Host 半侧真刀真枪跑一遍。
 *
 * 它回答三个问题，全部有真实运行时证据，而不是读源码的推断：
 *   A) 旧路 `connection.rpc.handle('/dsh-wb-experts', ...)` 在本机 dsh 上到底报什么错？
 *   B) 新路 `connection.fetch.register({ path:'/api/dsh-wb-experts' })` 注册后，
 *      官方 /api 共享处理器会不会把请求交给它？（走 connection 公开方法，绕过浏览器认证）
 *   C) 真实 HTTP 全链路（带自签认证 cookie）能不能拿到 448 条专家？
 *
 * 装配（与真机同一批包、同一份源码）：
 *   cordis root
 *     ├─ dsh-host-webserver      （真实 HTTP 服务器，随机端口）
 *     ├─ dsh-client-connection   （credentials 用内存桩，其余全真）
 *     └─ dsh-wb-experts          （本项目 lib/index.js）
 *
 * 跑：node tests/live-cordis-check.mjs
 * 注意：本脚本会往 ~/.dsh/wb-experts/_host-boot.log 追加几行落痕（插件自己写的），
 *       跑完在真机重启前清空该文件即可。
 */
import { pathToFileURL } from 'node:url'
import { createHash, createHmac } from 'node:crypto'

const NM = 'C:/Users/Admin/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/node_modules'
const load = (rel) => import(pathToFileURL(`${NM}/${rel}`).href)

let failed = 0
function check(label, cond, extra) {
  console.log(`${cond ? '  [OK]  ' : '  [FAIL]'} ${label}${extra === undefined ? '' : ' -> ' + extra}`)
  if (!cond) failed += 1
}
function note(label, text) {
  console.log(`  [info] ${label}${text === undefined ? '' : ' -> ' + text}`)
}

console.log('== 装配最小 cordis composition（真实 dsh 包）==')

const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
const { default: WebServer } = await load('@deepseek-ai/dsh-host-webserver/lib/index.js')
const { apply: connectionApply } = await load('@deepseek-ai/dsh-client-connection/lib/index.js')
const { apply: wbxApply, RPC_ROUTE_PATH } = await import('../lib/index.js')

/** 内存版 credentials：只需 connection 用到的 modifyRecord。 */
const credentials = {
  records: new Map(),
  async modifyRecord(key, fn) {
    const next = await fn(this.records.get(key))
    if (next !== undefined) this.records.set(key, next)
    return this.records.get(key)
  },
}

const ctx = new Context()
ctx.provide('credentials', credentials)

await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
note('webServer 已监听', `127.0.0.1:${ctx.get('webServer').port}`)

await ctx.plugin(
  { apply: connectionApply, inject: ['credentials'], name: 'client-connection' },
  { trustedHosts: [], cookieMaxAgeDays: 30 },
)

// connection 的 /api 路由由它自己的 ctx.inject(["webServer"], ...) 异步挂载，轮询等它。
const webServer = ctx.get('webServer')
const port = webServer.port
for (let i = 0; i < 60 && !webServer.prefixes.has('/api'); i += 1) {
  await new Promise((r) => setTimeout(r, 50))
}
check('官方 /api 路由已挂载', webServer.prefixes.has('/api'))

await ctx.plugin({ apply: wbxApply, inject: ['connection'], name: 'dsh-wb-experts' })
note('dsh-wb-experts Host 半侧已加载')

const connection = ctx.get('connection')

// ---- A：旧路为什么断（用探针插件在 apply 阶段复现真机场景）----------------
console.log('\n== A. 旧路 rpc.handle 的真实行为（405 根因实证）==')

// 真机场景 = 第三方插件在自己的 inject 回调 / apply 阶段调 rpc.handle。
// 用一个探针插件精确复现这个上下文（而不是在脚本顶层调 —— 那个上下文不一样，
// 实测反而能成功，见下方「apply 之后」的观察项）。
let probeError = null
await ctx.plugin({
  name: 'probe-rpc-handle',
  inject: ['connection'],
  apply(c) {
    try {
      c.connection.rpc.handle('/probe-legacy', async () => ({ ok: true, value: 1 }))
    } catch (e) {
      probeError = e
    }
  },
})
check('apply 阶段调 rpc.handle -> 抛错', probeError !== null)
if (probeError) note('异常原文', probeError.message)
check('异常点名 webServer 不可见', /webServer/.test(String(probeError && probeError.message)))
check('该通道未被注册（异常发生在 effect 内，路由没落地）', !webServer.prefixes.has('/probe-legacy'))

let lateError = null
try {
  connection.rpc.handle('/probe-late', async () => ({ ok: true, value: 1 }))
} catch (e) {
  lateError = e
}
note('apply 之后再调用（上下文差异对照）', lateError ? '抛错：' + lateError.message : '未抛错 —— 该上下文下可用')

// ---- B：新路在官方 /api 处理器里是否命中 ---------------------------------
console.log('\n== B. 新路 fetch 路由是否被官方 /api 处理器命中 ==')
const shared = connection.createSharedFetchHandler('/api')

async function viaShared(pathname, body) {
  return shared.fetch(
    new Request(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const envelope = (rpcId, endpoint, args) => ({
  type: 'client-request',
  rpcId,
  method: 'dsh-wb-experts',
  payload: { endpoint, args: args || {} },
})

const listRes = await viaShared(RPC_ROUTE_PATH, envelope('live-list', 'list'))
const listJson = await listRes.json()
check('HTTP 200', listRes.status === 200, listRes.status)
check('信封 type=server-response', listJson.type === 'server-response')
check('rpcId 原样回显', listJson.rpcId === 'live-list', listJson.rpcId)
check('result.ok=true', !!(listJson.result && listJson.result.ok === true))
const value = listJson.result && listJson.result.value
if (value) {
  note('专家数', value.experts.length)
  note('已上岗', JSON.stringify(value.staged))
  note('库路径', value.lib)
}
check('专家数 = 448', !!(value && value.experts.length === 448))

const missRes = await viaShared('/api/definitely-not-mine', envelope('live-miss', 'list'))
check('未认领路径 -> 404（证明 B 的 200 是我们的路由给的）', missRes.status === 404, missRes.status)
note('404 body', JSON.stringify(await missRes.text()))

// ---- C：真实 HTTP 全链路（自签认证 cookie）-------------------------------
console.log('\n== C. 真实 HTTP 全链路 ==')

const unauth = await fetch(`http://127.0.0.1:${port}${RPC_ROUTE_PATH}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})
check('未认证请求 -> 401（说明 /api 认证栅栏在生效）', unauth.status === 401, unauth.status)

// 复刻 BrowserAuth 的签名 cookie（常量取自 dsh-client-connection/lib/index.js:223-229）
const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const authRecord = [...credentials.records.entries()].find(([k]) => String(k).includes('browser-session'))
const secret = Buffer.from(authRecord[1].payload.secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
const authority = `127.0.0.1:${port}`
const cookieName = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest())
const issuedAt = Date.now()
const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 86400000 }
const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
const cookieValue = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`

const authed = await fetch(`http://127.0.0.1:${port}${RPC_ROUTE_PATH}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `${cookieName}=${cookieValue}` },
  body: JSON.stringify(envelope('live-http', 'list')),
})
const authedJson = await authed.json().catch(() => null)
check('带认证 -> HTTP 200', authed.status === 200, authed.status)
check('带认证 -> ok=true', !!(authedJson && authedJson.result && authedJson.result.ok === true))
const httpExperts = authedJson && authedJson.result && authedJson.result.value && authedJson.result.value.experts
check('带认证 -> 448 条专家', !!(httpExperts && httpExperts.length === 448), httpExperts && httpExperts.length)

const pingRes = await fetch(`http://127.0.0.1:${port}${RPC_ROUTE_PATH}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `${cookieName}=${cookieValue}` },
  body: JSON.stringify(envelope('live-ping', 'ping', { client: 'live-check' })),
})
const pingJson = await pingRes.json().catch(() => null)
check('ping 端点可用', !!(pingJson && pingJson.result && pingJson.result.ok === true))
note('ping value', JSON.stringify(pingJson && pingJson.result && pingJson.result.value))

const oldPath = await fetch(`http://127.0.0.1:${port}/dsh-wb-experts/list`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `${cookieName}=${cookieValue}` },
  body: '{}',
})
check('旧 path /dsh-wb-experts/list 无人认领 -> 404', oldPath.status === 404, oldPath.status)

console.log(failed === 0 ? '\n[OK] 实机验证全部通过' : `\n[FAIL] ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
