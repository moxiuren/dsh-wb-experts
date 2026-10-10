/**
 * finder skill 的「内置 + 自动安装」离线自测。
 *
 * 这一支回答的是「**别的 dsh 用户能不能开箱即用**」：
 *   ① 插件自带 wb-expert-finder（Auto Mode 的载体），不依赖任何外部目录
 *   ② 启动时自动安装到扫描根，且正文里的 CLI 路径已替换成本机真实路径
 *   ③ 幂等：内容一致不重写；升级时覆盖；**不是本插件装的一律不动**
 *   ④ 全流程在 `$DSH_HOME` 指向的临时目录里跑，绝不碰用户真实的 ~/.dsh
 *
 * 跑：node tests/finder-install.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SANDBOX = join(tmpdir(), `wbx-finder-test-${process.pid}`)
const HOME = join(SANDBOX, 'dsh-home')
const STAGE = join(HOME, 'skills')
const TARGET = join(STAGE, 'wb-expert-finder', 'SKILL.md')

let failed = 0
function check(label, cond, extra) {
  console.log(`${cond ? '  [OK]  ' : '  [FAIL]'} ${label}${extra === undefined ? '' : ' -> ' + extra}`)
  if (!cond) failed += 1
}

/** 在隔离环境里跑一段 Node 脚本，打印它 import 到的真实路径。 */
function probe(script) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DSH_HOME: HOME, DSH_WBX_STAGE: STAGE },
    encoding: 'utf-8',
  })
  return JSON.parse(out.trim().split('\n').pop())
}

/** 在隔离环境里跑 CLI，返回 stdout。 */
function cli(args) {
  return execFileSync(process.execPath, [join(ROOT, 'bin', 'wbx.mjs'), ...args], {
    env: { ...process.env, DSH_HOME: HOME, DSH_WBX_STAGE: STAGE },
    encoding: 'utf-8',
  })
}

/** 跑 CLI 并接受非零退出（体检类命令在库缺失时**应该**非零退出）。 */
function cliAllowingFailure(args) {
  try {
    return { ok: true, out: cli(args) }
  } catch (e) {
    return { ok: false, out: `${(e && e.stdout) || ''}` }
  }
}

console.log(`沙箱：${SANDBOX}\n`)
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })

console.log('1) 路径解析跟随 $DSH_HOME（不再写死 ~/.dsh）')
const paths = probe(
  `import * as m from ${JSON.stringify('file:///' + join(ROOT, 'lib/index.js').replace(/\\/g, '/'))};` +
    `console.log(JSON.stringify({home:m.dshHome(),lib:m.LIB,stage:m.STAGE}))`,
)
check('dshHome 跟随 $DSH_HOME', paths.home === HOME, paths.home)
check('LIB = $DSH_HOME/wb-experts', paths.lib === join(HOME, 'wb-experts'), paths.lib)
check('STAGE = $DSH_HOME/skills', paths.stage === STAGE, paths.stage)

console.log('\n2) 首次启动：自动安装 finder skill')
check('安装前不存在', !existsSync(TARGET))
const r1 = probe(
  `import * as m from ${JSON.stringify('file:///' + join(ROOT, 'lib/index.js').replace(/\\/g, '/'))};` +
    `console.log(JSON.stringify(m.installFinderSkill()))`,
)
check('已创建', r1.installed === true && r1.reason === 'created', JSON.stringify(r1))
check('文件确实落盘', existsSync(TARGET))
const content = readFileSync(TARGET, 'utf-8')
check('正文含 name: wb-expert-finder', content.includes('name: wb-expert-finder'))
check('managedBy 标记已写入', content.includes('managedBy: dsh-wb-experts'))
check('__CLI__ 占位符已替换为真实路径', !content.includes('__CLI__') && content.includes(join(ROOT, 'bin', 'wbx.mjs')))
check('__VERSION__ 占位符已替换', !content.includes('__VERSION__'))
check('正文不再出现本机用户名写死路径', !/C:\\\\Users\\\\Admin/.test(content))

console.log('\n3) 幂等与升级')
const r2 = probe(
  `import * as m from ${JSON.stringify('file:///' + join(ROOT, 'lib/index.js').replace(/\\/g, '/'))};` +
    `console.log(JSON.stringify(m.installFinderSkill()))`,
)
check('二次安装判定为 up-to-date', r2.installed === true && r2.reason === 'up-to-date', JSON.stringify(r2))

// 模拟插件升级：改掉 managedVersion 后应被覆盖回当前版本
writeFileSync(TARGET, content.replace(/managedVersion: [\d.]+/, 'managedVersion: 0.0.1'), 'utf-8')
const r3 = probe(
  `import * as m from ${JSON.stringify('file:///' + join(ROOT, 'lib/index.js').replace(/\\/g, '/'))};` +
    `console.log(JSON.stringify(m.installFinderSkill()))`,
)
check('旧版本被覆盖', r3.installed === true && r3.reason === 'updated', JSON.stringify(r3))
check('覆盖回当前版本', readFileSync(TARGET, 'utf-8').includes('managedVersion: 0.1.8'))

console.log('\n4) 用户自己的同名 skill 神圣不可侵犯')
writeFileSync(TARGET, '---\nname: wb-expert-finder\ndescription: 我自己写的\n---\n\n我的正文\n', 'utf-8')
const r4 = probe(
  `import * as m from ${JSON.stringify('file:///' + join(ROOT, 'lib/index.js').replace(/\\/g, '/'))};` +
    `console.log(JSON.stringify(m.installFinderSkill()))`,
)
check('拒绝覆盖（reason=foreign）', r4.installed === false && r4.reason === 'foreign', JSON.stringify(r4))
check('内容原样保留', readFileSync(TARGET, 'utf-8').includes('我自己写的'))

console.log('\n5) CLI 在隔离环境里可用')
const doctor = JSON.parse(cli(['doctor', '--json']))
check('doctor 报告的库路径跟随 $DSH_HOME', doctor.lib === join(HOME, 'wb-experts'), doctor.lib)
check('doctor 报告的扫描根跟随 $DSH_HOME', doctor.stage === STAGE, doctor.stage)
check('库缺失时 doctor ok=false', doctor.ok === false)
const doctorFail = cliAllowingFailure(['doctor'])
check('库缺失时 doctor 非零退出', doctorFail.ok === false)
check('doctor 文案明确提示索引缺失', doctorFail.out.includes('缺失'), doctorFail.out.split('\n')[2])
let findFailed = false
try {
  cli(['find', '渗透'])
} catch {
  findFailed = true
}
check('库不存在时 find 非零退出并给提示', findFailed)

console.log('\n6) 最小专家库端到端（建库 -> 索引 -> find -> 上岗 -> 下岗）')
// 夹具刻意让「任务词」只出现在正文、结构化字段里完全没有：
//   `渗透` 只在 SKILL.md 正文；`测试` 只在 profession。
// 这样两条断言分别证明「正文语料是必需的」和「结构化字段本来就能命中」。
const LIB = join(HOME, 'wb-experts')
mkdirSync(join(LIB, 'fake-pentest-expert'), { recursive: true })
mkdirSync(join(LIB, 'fake-contract-expert'), { recursive: true })
writeFileSync(
  join(LIB, 'fake-pentest-expert', 'SKILL.md'),
  '---\nname: fake-pentest-expert\ndescription: 测试员甲\n---\n\n负责渗透测试与红队评估，覆盖内网横向移动。\n',
  'utf-8',
)
writeFileSync(
  join(LIB, 'fake-contract-expert', 'SKILL.md'),
  '---\nname: fake-contract-expert\ndescription: 测试员乙\n---\n\n负责合同条款审阅与法务风险提示。\n',
  'utf-8',
)
writeFileSync(
  join(LIB, '_index.json'),
  JSON.stringify([
    { dsh_name: 'fake-pentest-expert', zh: '测试员甲', en: 'Pentest', profession: '测试工程师', category: '11-SecurityCompliance', category_zh: '法务安全', expertType: 'agent', subskills: [] },
    { dsh_name: 'fake-contract-expert', zh: '测试员乙', en: 'Contract', profession: '测试工程师', category: '11-SecurityCompliance', category_zh: '法务安全', expertType: 'agent', subskills: [] },
  ]),
  'utf-8',
)

// 关键回归：`渗透` 只存在于 SKILL.md 正文，而 `_index.json` 根本没有 description 字段
// —— 不建全文索引就必然 0 命中。
const beforeIndex = JSON.parse(cli(['find', '渗透', '--json']))
check(
  '无搜索索引时命中 0（复现旧 bug）',
  beforeIndex.matched === 0 && beforeIndex.corpus === 'index-only',
  JSON.stringify({ m: beforeIndex.matched, c: beforeIndex.corpus }),
)
// 反证：结构化字段里有的词，退化模式下照样命中 —— 说明上面那个 0 是「语料缺正文」，不是搜索坏了
const control = JSON.parse(cli(['find', '测试', '--json']))
check('对照：结构化字段里的词在退化模式下仍命中', control.matched === 2, control.matched)

cli(['index'])
check('_search.json 已生成', existsSync(join(LIB, '_search.json')))

const afterIndex = JSON.parse(cli(['find', '渗透', '--json']))
check('有搜索索引后命中 1（全文命中）', afterIndex.matched === 1 && afterIndex.corpus === 'fulltext', JSON.stringify({ m: afterIndex.matched, c: afterIndex.corpus }))
check('命中的正是渗透专家', afterIndex.rows[0] && afterIndex.rows[0].name === 'fake-pentest-expert')

// 引号整串与多参数两种写法都要能用（旧文档用的是整串加引号）
const quoted = JSON.parse(cli(['find', '渗透 安全', '--json']))
const split = JSON.parse(cli(['find', '渗透', '安全', '--json']))
check('引号整串写法可用', quoted.matched >= 1, quoted.matched)
check('多参数写法与整串等价', split.matched === quoted.matched, `${split.matched} vs ${quoted.matched}`)

const useOut = JSON.parse(cli(['use', 'fake-pentest-expert', '--json']))
check('上岗成功', useOut.ok === true && useOut.staged === 1, JSON.stringify(useOut.results))
check('扫描根里出现上岗项', existsSync(join(STAGE, 'fake-pentest-expert')))
check('on 能列出', JSON.parse(cli(['on', '--json'])).staged.includes('fake-pentest-expert'))

// 用户自己的 skill 不能被 off 删掉
mkdirSync(join(STAGE, 'my-own-skill'), { recursive: true })
writeFileSync(join(STAGE, 'my-own-skill', 'SKILL.md'), '---\nname: my-own-skill\ndescription: 用户自己的\n---\n', 'utf-8')
const offForeign = JSON.parse(cli(['off', 'my-own-skill', '--json']))
check('off 拒绝删用户自己的 skill', offForeign.ok === false, JSON.stringify(offForeign.results))
check('用户自己的 skill 仍在', existsSync(join(STAGE, 'my-own-skill')))

const offOut = JSON.parse(cli(['off', 'fake-pentest-expert', '--json']))
check('下岗成功', offOut.ok === true, JSON.stringify(offOut.results))
check('上岗项已消失', !existsSync(join(STAGE, 'fake-pentest-expert')))
check('库本体未被删', existsSync(join(LIB, 'fake-pentest-expert', 'SKILL.md')))

const useBad = JSON.parse(cli(['use', '../../etc/passwd', '--json']))
check('路径穿越被拒', useBad.ok === false, JSON.stringify(useBad.results))

rmSync(SANDBOX, { recursive: true, force: true })
console.log(failed === 0 ? '\n[OK] finder 内置与自动安装自测全部通过' : `\n[FAIL] ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
