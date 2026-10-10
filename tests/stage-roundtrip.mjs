/**
 * 上岗 / 下岗往返测试（**会真的建、真的删一个 junction**，但净变化为零）。
 *
 * 为什么需要它：面板的「取消上岗」按钮走的是 Host 的 `unstage` 端点，而离线自测
 * 只覆盖了「拒绝非法名 / 拒绝删用户自己的 skill」两条拒绝路径，**成功路径从没跑过**。
 * 小莫马上要用这个按钮，所以这里把「上岗 -> 确认挂上 -> 下岗 -> 确认摘掉」整条走一遍，
 * 并断言结束后 `~/.dsh/skills` 的专家上岗集合与开跑前**完全一致**。
 *
 * 跑：node tests/stage-roundtrip.mjs
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dispatch } from '../lib/index.js'

let failed = 0
function check(label, cond, extra) {
  console.log(`${cond ? '  [OK]  ' : '  [FAIL]'} ${label}${extra === undefined ? '' : ' -> ' + extra}`)
  if (!cond) failed += 1
}

const STAGE = join(homedir(), '.dsh', 'skills')

const before = await dispatch('list', {})
if (!before.ok) {
  console.error('list 失败:', JSON.stringify(before.error))
  process.exit(1)
}
const stagedBefore = before.value.staged.slice().sort()
console.log('开跑前已上岗:', stagedBefore.length, JSON.stringify(stagedBefore))

// 挑一位当前未上岗的专家做往返
const target = before.value.experts.map((e) => e.dsh_name).find((n) => stagedBefore.indexOf(n) === -1)
if (!target) {
  console.error('专家库里找不到未上岗的专家，跳过')
  process.exit(1)
}
console.log('测试目标:', target)

console.log('\n1) 上岗')
const s = await dispatch('stage', { name: target })
check('stage ok', s.ok, JSON.stringify(s.value || s.error))
check('junction 已建立', existsSync(join(STAGE, target)))

const mid = await dispatch('list', {})
check('list 里能看到它已上岗', mid.value.staged.indexOf(target) !== -1, JSON.stringify(mid.value.staged))

console.log('\n2) 下岗（面板「取消上岗」按钮走的就是这个端点）')
const u = await dispatch('unstage', { name: target })
check('unstage ok', u.ok, JSON.stringify(u.value || u.error))
check('junction 已摘除', !existsSync(join(STAGE, target)))

const after = await dispatch('list', {})
const stagedAfter = after.value.staged.slice().sort()
check('上岗集合回到原状（净变化为零）', JSON.stringify(stagedAfter) === JSON.stringify(stagedBefore), JSON.stringify(stagedAfter))

console.log('\n3) 幂等与防线')
const u2 = await dispatch('unstage', { name: target })
check('重复下岗不报错（already）', u2.ok && u2.value.already === true, JSON.stringify(u2.value || u2.error))
const u3 = await dispatch('unstage', { name: 'notion-agent-hub' })
check('仍然拒绝删用户自己的 skill', !u3.ok, u3.ok ? '' : u3.error.message)

console.log(failed === 0 ? '\n[OK] 上岗/下岗往返测试通过' : `\n[FAIL] ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
