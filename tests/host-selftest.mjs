/**
 * Host 半侧离线自测：mock 一个 cordis ctx，把 Fetch 路由抓出来直接调。
 *
 * 回答两个问题：
 *   ① Host 侧到底能不能返回 448 条专家（数据层）
 *   ② 信封是否严格贴合官方 schema（传输层）—— 尤其是失败分支的
 *      `error` 必须是 `{ code, message, details }` 对象，字符串会让浏览器侧
 *      的 parseConnectionResponse 直接判非法。
 *
 * 跑：node tests/host-selftest.mjs
 */
import { apply, RPC_ROUTE_PATH } from '../lib/index.js'

let route = null
let handleTried = false

const ctx = {
  inject(deps, cb) {
    cb({
      connection: {
        fetch: {
          register: (r) => {
            route = r
            return () => {}
          },
        },
        // 模拟真机行为：旧路 rpc.handle 内部访问 connection ctx 上看不见的 webServer，
        // 同步抛错。apply 必须吞掉它、不中断主路注册。
        rpc: {
          handle: () => {
            handleTried = true
            throw new Error('cannot get property "webServer" without inject')
          },
        },
      },
    })
  },
  effect(cb) {
    return cb()
  },
  logger: { info() {} },
}

let failed = 0
function check(label, cond, extra) {
  console.log(`${cond ? '  [OK]  ' : '  [FAIL]'} ${label}${extra === undefined ? '' : ' -> ' + extra}`)
  if (!cond) failed += 1
}

apply(ctx)

console.log('1) ctx.inject 已调用，注册的 Fetch 路由:')
check('route 存在', !!route)
check('path 正确', route && route.path === RPC_ROUTE_PATH, route && route.path)
check('methods 含 POST', !!(route && route.methods && route.methods.includes('POST')))
check('requestBody=buffered', !!(route && route.requestBody === 'buffered'))
check('旧路 rpc.handle 被试探且异常被吞', handleTried)

const URL_BASE = 'http://127.0.0.1' + RPC_ROUTE_PATH

function raw(method, body, headers) {
  return route.fetch(
    new Request(URL_BASE, {
      method,
      headers: headers === undefined ? { 'content-type': 'application/json' } : headers,
      body,
    }),
  )
}

function call(endpoint, args, rpcId) {
  return raw(
    'POST',
    JSON.stringify({
      type: 'client-request',
      rpcId: rpcId || 't-' + endpoint,
      method: 'dsh-wb-experts',
      payload: { endpoint, args: args || {} },
    }),
  )
}

/** 校验失败分支的错误形状（官方 schema 硬要求）。 */
function errorShape(e) {
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.code === 'string' &&
    typeof e.message === 'string' &&
    !!e.details &&
    typeof e.details === 'object'
  )
}

console.log('\n2) 信封与端点')

const pingRes = await call('ping', { client: 'selftest' }, 'rpc-ping')
const ping = await pingRes.json()
check('ping HTTP 200', pingRes.status === 200, pingRes.status)
check('信封 type=server-response', ping.type === 'server-response')
check('rpcId 原样回显', ping.rpcId === 'rpc-ping', ping.rpcId)
check('ping ok=true', !!(ping.result && ping.result.ok === true))
console.log('   ping value:', JSON.stringify(ping.result && ping.result.value))

const listRes = await call('list')
const list = await listRes.json()
check('list ok=true', !!(list.result && list.result.ok === true))
const v = list.result && list.result.value
if (v) {
  console.log('   experts:', v.experts.length)
  console.log('   staged :', v.staged.length, v.staged.slice(0, 5).join(', '))
  console.log('   usage  :', JSON.stringify(v.usage))
  console.log('   lib    :', v.lib)
  console.log('   stage  :', v.stage)
  console.log('   第一条 :', JSON.stringify(v.experts[0]).slice(0, 160))
  check('专家数 = 448', v.experts.length === 448, v.experts.length)
  // list 顺带回 Auto Mode 载体的安装状态（面板据此决定「不确定用哪个？」那一行是否可用）
  check('list 带 finder 状态', !!v.finder, JSON.stringify(v.finder))
  check('finder 状态含 path', !!(v.finder && typeof v.finder.path === 'string'), v.finder && v.finder.path)
  console.log('   finder :', JSON.stringify(v.finder))
}

console.log('\n3) 安全防线与失败信封')

const bad = await (await call('stage', { name: '../../etc/passwd' })).json()
check('路径穿越被拒', !!(bad.result && bad.result.ok === false), JSON.stringify(bad.result && bad.result.error))
check('失败 error 是 {code,message,details}', errorShape(bad.result && bad.result.error))

const unknown = await (await call('stage', { name: 'no-such-expert-xyz' })).json()
check('未知专家被拒', !!(unknown.result && unknown.result.ok === false))
check('未知专家 error 形状合法', errorShape(unknown.result && unknown.result.error))
console.log('   error.message:', unknown.result && unknown.result.error && unknown.result.error.message)

const unstageOwn = await (await call('unstage', { name: 'notion-agent-hub' })).json()
check('不删用户自己的 skill', !!(unstageOwn.result && unstageOwn.result.ok === false))
console.log('   error.message:', unstageOwn.result && unstageOwn.result.error && unstageOwn.result.error.message)

const noSuchEp = await (await call('nope-xyz')).json()
check('未知端点被拒', !!(noSuchEp.result && noSuchEp.result.ok === false))
check('未知端点 code 带标记', !!(noSuchEp.result && noSuchEp.result.error.code.endsWith('/unknown-endpoint')))

console.log('\n4) 传输层边界')

const badEnvelope = await (
  await raw('POST', JSON.stringify({ type: 'wrong', rpcId: 'rpc-bad' }))
).json()
check('非法信封返回 ok=false', !!(badEnvelope.result && badEnvelope.result.ok === false))
check('非法信封保留 rpcId', badEnvelope.rpcId === 'rpc-bad', badEnvelope.rpcId)

const wrongType = await raw('POST', '{}', { 'content-type': 'text/plain' })
check('content-type 非 JSON -> 415', wrongType.status === 415, wrongType.status)

const notJson = await raw('POST', 'not json at all')
check('body 非 JSON -> 400', notJson.status === 400, notJson.status)

const getRes = await route.fetch(new Request(URL_BASE, { method: 'GET' }))
check('GET -> 404', getRes.status === 404, getRes.status)

console.log(failed === 0 ? '\n[OK] Host 半侧自测全部通过' : `\n[FAIL] ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
