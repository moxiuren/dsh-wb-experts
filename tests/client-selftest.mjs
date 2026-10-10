/**
 * 浏览器半侧离线自测：在 vm 沙箱里跑 lib/client.js，验证
 *   ① bundle 能执行且不抛错（IIFE 包裹是否生效）
 *   ② `__ModuleLoader__.load` 被调用且 id 正确
 *   ③ factory 返回的模块导出 apply / inject
 *   ④ apply(mockCtx) 时插槽注册的 key / id / order 正确
 *
 * 跑：node tests/client-selftest.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf-8')

let loaded = null
let styleInserted = 0

const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load(def) {
        loaded = def
      },
    },
  },
  document: {
    createElement() {
      return {
        setAttribute() {},
        textContent: '',
      }
    },
    head: {
      appendChild() {
        styleInserted += 1
      },
    },
  },
  // factory 的 require 形参：apply 阶段只把 react 存起来，不渲染
  require(name) {
    if (name === 'react') return { createElement: () => null }
    return {}
  },
  setTimeout,
  clearTimeout,
}

vm.createContext(sandbox)

try {
  vm.runInContext(src, sandbox, { filename: 'client.js' })
  console.log('1) bundle 执行: 未抛错')
} catch (e) {
  console.error('1) bundle 执行抛错:', e.message)
  process.exit(1)
}

if (!loaded) {
  console.error('!! __ModuleLoader__.load 未被调用')
  process.exit(1)
}
console.log('2) __ModuleLoader__.load 被调用, id =', loaded.id)

const mod = loaded.factory(sandbox.require)
console.log('3) 导出:', Object.keys(mod).join(', '))
if (typeof mod.apply !== 'function') {
  console.error('!! 缺 apply')
  process.exit(1)
}
if (!Array.isArray(mod.inject)) {
  console.error('!! 缺 inject 数组（这是前端起不来的头号原因）')
  process.exit(1)
}
console.log('   inject =', JSON.stringify(mod.inject))

let reg = null
const ctx = {
  slots: {
    inject(key, cb) {
      cb()
      console.log('4) slots.inject key =', key)
    },
    register(opts, comp) {
      reg = { opts, comp }
      return () => {}
    },
  },
}

mod.apply(ctx)

if (!reg) {
  console.error('!! 没有注册任何插槽')
  process.exit(1)
}
console.log('5) 注册插槽:', JSON.stringify(reg.opts))
console.log('   组件是函数:', typeof reg.comp === 'function')
console.log('6) <style> 插入次数:', styleInserted)

const ok =
  loaded.id === 'dsh-wb-experts' &&
  reg.opts.name === 'conversation.input.left' &&
  reg.opts.id === 'wb-experts' &&
  typeof reg.comp === 'function' &&
  styleInserted === 1

console.log(ok ? '\n[OK] 客户端半侧自测通过' : '\n[FAIL] 自测不通过')
process.exit(ok ? 0 : 1)
