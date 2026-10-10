/**
 * 客户端「分类 / 过滤 / 排序」逻辑测试 —— 拿**真实的 _index.json** 跑 bundle 里
 * **真实的函数**（通过 exports.__test 出口），不是跑一份副本。
 *
 * 为什么需要它：本机没有浏览器控制，面板长什么样看不见；但「15 个分类对不对、
 * 数量加不加得起来、分类过滤准不准、搜索能不能跨分类」这些是纯逻辑，必须能离线钉死。
 * 视觉部分留给 CDP（--remote-debugging-port=9223），逻辑部分不靠眼睛。
 *
 * 跑：node tests/client-logic-test.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf-8')

let failed = 0
function check(label, cond, extra) {
  console.log(`${cond ? '  [OK]  ' : '  [FAIL]'} ${label}${extra === undefined ? '' : ' -> ' + extra}`)
  if (!cond) failed += 1
}

// ---- 载入 bundle，取内部函数出口 ----------------------------------------
let loaded = null
const sandbox = {
  console,
  window: { __ModuleLoader__: { load(def) { loaded = def } } },
  document: {
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild() {} },
  },
  require: (name) => (name === 'react' ? { createElement: () => null } : {}),
  setTimeout,
  clearTimeout,
}
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })

const mod = loaded.factory(sandbox.require)
const T = mod.__test
if (!T) {
  console.error('!! bundle 没有导出 __test（分类逻辑无法离线验证）')
  process.exit(1)
}

// ---- 真实数据 -------------------------------------------------------------
const INDEX = join(homedir(), '.dsh', 'wb-experts', '_index.json')
const experts = JSON.parse(readFileSync(INDEX, 'utf-8'))
console.log(`真实专家库: ${experts.length} 位\n`)

console.log('1) buildCats —— 分类清单与数量')
const cats = T.buildCats(experts)
check('分类数 = 15', cats.names.length === 15, cats.names.length)
const sum = cats.names.reduce((n, c) => n + cats.count[c], 0)
check('各分类数量之和 = 专家总数', sum === experts.length, `${sum} / ${experts.length}`)
// 注意：分类顺序按 category 前缀序号 01..15，不是按数量、也不是按中文名字典序。
check('首位是 01-ProductDesign「产品设计」(20)',
  cats.names[0] === '产品设计' && cats.count['产品设计'] === 20,
  `${cats.names[0]} ${cats.count[cats.names[0]]}`)
check('末位是 15-BackToSchool「开学季」(11)',
  cats.names[14] === '开学季' && cats.count['开学季'] === 11,
  `${cats.names[14]} ${cats.count[cats.names[14]]}`)
check('中文名与 category 编号对得上（腾讯专区 = 13-TencentZone）',
  (experts.find((e) => e.category_zh === '腾讯专区') || {}).category === '13-TencentZone')
console.log('   顺序:', cats.names.map((c) => `${c}(${cats.count[c]})`).join(' '))
const seqOk = (() => {
  // 分类顺序必须与 category 前缀序号一致（01..15）
  const seq = {}
  for (const e of experts) if (e.category_zh) seq[e.category_zh] = parseInt(String(e.category).slice(0, 2), 10)
  for (let i = 1; i < cats.names.length; i += 1) {
    if (seq[cats.names[i - 1]] > seq[cats.names[i]]) return false
  }
  return true
})()
check('分类顺序与 category 序号一致（不是按字典序）', seqOk)

console.log('\n2) filterExperts —— 分类过滤')
check('全部（无分类、无关键词）= 448', T.filterExperts(experts, '', '').length === 448,
  T.filterExperts(experts, '', '').length)
const fin = T.filterExperts(experts, '', '金融投资')
check('分类「金融投资」= 39', fin.length === 39, fin.length)
check('分类结果确实都属于该分类', fin.every((e) => e.category_zh === '金融投资'))
const ops = T.filterExperts(experts, '', '运营人力')
check('分类「运营人力」= 17', ops.length === 17, ops.length)

console.log('\n3) filterExperts —— 关键词（跨分类）')
const kw1 = T.filterExperts(experts, 'a-share', '')
check('搜 "a-share" 命中 a-share-advisor', kw1.some((e) => e.dsh_name === 'a-share-advisor'), kw1.length)
const kw2 = T.filterExperts(experts, '金融', '')
check('搜 "金融" 能命中（分类名也进了搜索范围）', kw2.length > 0, kw2.length)
// 探针词从真实数据里取（不靠猜）：拿第一位专家中文名的前两字去搜，必须命中它自己。
const probe = String(experts[0].zh || '').slice(0, 2)
const kw3 = T.filterExperts(experts, probe, '')
check(`搜「${probe}」(取自真实数据) 至少命中 1 位`, kw3.length > 0, kw3.length)
const kw4 = T.filterExperts(experts, 'zzz-不存在-zzz', '')
check('搜不存在的词 = 0', kw4.length === 0, kw4.length)
const kw5 = T.filterExperts(experts, 'A-SHARE', '')
check('关键词大小写不敏感', kw5.length === kw1.length, `${kw5.length} vs ${kw1.length}`)

console.log('\n4) filterExperts —— 分类 + 关键词叠加')
const both = T.filterExperts(experts, 'advisor', '金融投资')
check('分类内搜索只返回该分类', both.every((e) => e.category_zh === '金融投资'), both.length)
check('分类内搜索结果 <= 该分类总数', both.length <= 39, both.length)

console.log('\n5) sortExperts —— 常用优先 → 已上岗优先 → 字典序')
const usage = { 'zzz-last': 5 }
const staged = ['yyy-mid']
const sample = [
  { dsh_name: 'aaa-first' },
  { dsh_name: 'yyy-mid' },
  { dsh_name: 'zzz-last' },
]
const sorted = T.sortExperts(sample, usage, staged).map((e) => e.dsh_name)
check('用过的最前', sorted[0] === 'zzz-last', sorted.join(' > '))
check('已上岗的次之', sorted[1] === 'yyy-mid', sorted.join(' > '))
check('其余按字典序', sorted[2] === 'aaa-first', sorted.join(' > '))
check('不修改原数组', sample[0].dsh_name === 'aaa-first')

console.log(failed === 0 ? '\n[OK] 客户端分类/过滤/排序逻辑测试通过' : `\n[FAIL] ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
