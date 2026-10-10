#!/usr/bin/env node
/**
 * 一条命令装完「专家模式」：专家库 + 插件挂载。
 *
 * 为什么需要它：完整的专家模式由**两个仓库**组成 —— 本插件（代码）+ 专家库
 * （16 MB 数据）。手工装要动 profile 的 package.json 两处、再跑 pnpm，任何一步
 * 漏掉都表现为「按钮不出现」或「面板空」，而这两种症状在 README 里要翻半天才知道原因。
 * 这个脚本把四步合成一步，并且**默认先做安全检查**：
 *
 *   ① 拉专家库（或复用已有的检出）
 *   ② 把库装到 <dsh home>/wb-experts/（走库自己的 tools/install.mjs）
 *   ③ 把插件写进 dsh profile 的 package.json（dependencies + dsh.profile.bundles 两处）
 *   ④ pnpm install
 *
 * 安全约定：
 *   * 改 profile 的 package.json **之前一定备份**（`.bak-bootstrap-<时间戳>`）
 *   * `--dry-run` 只报告不改任何文件
 *   * 已经是装好的状态就跳过（幂等），不会重复写
 *
 * 用法：
 *   node scripts/bootstrap.mjs [--dry-run] [--profile <name>] [--data-dir <path>]
 *                              [--repo <git url>] [--skip-library] [--skip-install]
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = dirname(HERE)
const PLUGIN_NAME = 'dsh-wb-experts'
const DATA_REPO = 'https://github.com/moxiuren/dsh-experts-library.git'

function flag(name) {
  return process.argv.includes(`--${name}`)
}
function opt(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const DRY = flag('dry-run')
const SKIP_LIBRARY = flag('skip-library')
const SKIP_INSTALL = flag('skip-install')
const DATA_REPO_URL = opt('repo', DATA_REPO)
/** 默认落在插件仓库的**同级目录**：两个仓库放一起，路径可预测、不污染家目录。 */
const DATA_DIR = resolve(opt('data-dir', join(dirname(PLUGIN_ROOT), 'dsh-experts-library')))

function resolveDshHome() {
  const e = process.env.DSH_HOME
  return e && e.trim() ? resolve(e.trim()) : join(homedir(), '.dsh')
}
const DSH_HOME = resolveDshHome()

/** 跑一条命令，返回 { ok, out }；不抛。 */
function run(cmd, args, cwd) {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out: out || '' }
  } catch (e) {
    const msg = `${(e && e.stdout) || ''}${(e && e.stderr) || ''}`.trim()
    return { ok: false, out: msg || (e && e.message) || 'unknown error' }
  }
}

/**
 * 跑 pnpm。
 *
 * Windows 上 pnpm 是 `pnpm.cmd` / `pnpm.ps1` 这种 shim，**不能直接 execFile** ——
 * Node 18.20 / 20.12 起（CVE-2024-27980 的修复）spawn 一个 `.cmd` 而不带 shell 会直接抛
 * `spawnSync pnpm.cmd EINVAL`。实测就是这么炸的，所以 Windows 一律走 `cmd /c`。
 */
function runPnpm(args, cwd) {
  const attempts =
    process.platform === 'win32'
      ? [
          { cmd: 'cmd', argv: ['/c', 'pnpm', ...args], via: 'cmd /c pnpm' },
          { cmd: 'cmd', argv: ['/c', 'corepack', 'pnpm', ...args], via: 'cmd /c corepack pnpm' },
        ]
      : [
          { cmd: 'pnpm', argv: args, via: 'pnpm' },
          { cmd: 'corepack', argv: ['pnpm', ...args], via: 'corepack pnpm' },
        ]

  let last = ''
  for (const a of attempts) {
    const r = run(a.cmd, a.argv, cwd)
    if (r.ok) return { ok: true, out: r.out, via: a.via }
    last = r.out
    // 只在「命令不存在」时换下一个候选；真的装失败了要立刻返回，别掩盖错误
    if (!/ENOENT|EINVAL|not recognized|不是内部或外部命令|is not recognized/i.test(r.out)) {
      return { ok: false, out: r.out, via: a.via }
    }
  }
  return { ok: false, out: last || 'pnpm 未找到', via: null }
}

const steps = []
function step(label, fn) {
  steps.push({ label, fn })
}

// ---------------------------------------------------------------------------
// ① 探测 profile
// ---------------------------------------------------------------------------
let profileDir = null
let profileName = null

step('探测 dsh profile', () => {
  const profilesRoot = join(DSH_HOME, 'profiles')
  const want = opt('profile', null)
  if (want) {
    profileDir = join(profilesRoot, want)
    profileName = want
    if (!existsSync(join(profileDir, 'package.json'))) {
      throw new Error(`profile "${want}" 下没有 package.json：${profileDir}`)
    }
  } else {
    if (!existsSync(profilesRoot)) throw new Error(`找不到 profiles 目录：${profilesRoot}`)
    const dirs = readdirSync(profilesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(profilesRoot, e.name, 'package.json')))
      .map((e) => e.name)
    if (dirs.length === 0) throw new Error(`${profilesRoot} 下没有可用的 profile`)
    if (dirs.length > 1) {
      throw new Error(`发现多个 profile（${dirs.join(', ')}），请用 --profile <name> 指定`)
    }
    profileName = dirs[0]
    profileDir = join(profilesRoot, profileName)
  }
  return `profile = ${profileName}（${profileDir}）`
})

// ---------------------------------------------------------------------------
// ② 专家库：clone（或复用）+ 安装
// ---------------------------------------------------------------------------
step('专家库', () => {
  if (SKIP_LIBRARY) return '已跳过（--skip-library）'

  if (!existsSync(DATA_DIR)) {
    const parent = dirname(DATA_DIR)
    if (!existsSync(parent)) {
      if (DRY) return `将创建 ${parent}`
      mkdirSync(parent, { recursive: true })
    }
    if (DRY) return `将 clone ${DATA_REPO_URL} -> ${DATA_DIR}`
    const r = run('git', ['clone', '--depth', '1', DATA_REPO_URL, DATA_DIR])
    if (!r.ok) throw new Error(`clone 失败（需要 git 在 PATH 里）：${r.out}`)
  }

  const installer = join(DATA_DIR, 'tools', 'install.mjs')
  const target = join(DSH_HOME, 'wb-experts')
  if (existsSync(join(target, '_index.json'))) {
    return `已存在，跳过（${target}）`
  }
  if (DRY) return `将运行 ${installer} 把库装到 ${target}`

  if (existsSync(installer)) {
    const r = run(process.execPath, [installer], DATA_DIR)
    if (!r.ok) throw new Error(`装库失败：${r.out}`)
    return `已装到 ${target}`
  }

  // 退路：库仓库里没有 install.mjs 时，自己按目录结构复制
  const src = join(DATA_DIR, 'library')
  if (!existsSync(src)) throw new Error(`${DATA_DIR} 里既没有 tools/install.mjs 也没有 library/`)
  mkdirSync(target, { recursive: true })
  cpSync(src, target, { recursive: true })
  return `已复制（退路逻辑）到 ${target}`
})

// ---------------------------------------------------------------------------
// ③ 把插件写进 profile 的 package.json（两处）
// ---------------------------------------------------------------------------
step('挂载插件到 profile', () => {
  const pkgPath = join(profileDir, 'package.json')
  const raw = readFileSync(pkgPath, 'utf-8')
  const pkg = JSON.parse(raw)

  pkg.dependencies = pkg.dependencies || {}
  const wantDep = `link:${PLUGIN_ROOT.replace(/\\/g, '/')}`
  const hasDep = pkg.dependencies[PLUGIN_NAME] === wantDep

  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
  const hasBundle = pkg.dsh.profile.bundles.includes(PLUGIN_NAME)

  if (hasDep && hasBundle) return '已挂载，跳过'

  const changed = []
  if (!hasDep) {
    pkg.dependencies[PLUGIN_NAME] = wantDep
    changed.push('dependencies')
  }
  if (!hasBundle) {
    pkg.dsh.profile.bundles.push(PLUGIN_NAME)
    changed.push('dsh.profile.bundles')
  }

  if (DRY) return `将写入 ${changed.join(' + ')}（并备份原文件）`

  // 时间戳到秒就够：toISOString 是 `2026-10-10T10:49:11.123Z`，
  // 去掉分隔符后前 14 位正好是 `YYYYMMDDHHmmss`（多切一位会带上毫秒的小数点）
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  copyFileSync(pkgPath, `${pkgPath}.bak-bootstrap-${stamp}`)
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8')
  return `已写入 ${changed.join(' + ')}（备份：package.json.bak-bootstrap-${stamp}）`
})

// ---------------------------------------------------------------------------
// ④ pnpm install
// ---------------------------------------------------------------------------
step('安装依赖', () => {
  if (SKIP_INSTALL) return '已跳过（--skip-install）'
  if (DRY) return '将运行 pnpm install'
  const r = runPnpm(['install'], profileDir)
  if (!r.ok) {
    throw new Error(
      `pnpm install 失败（via ${r.via}）：${r.out}\n` +
        `请手动执行：cd "${profileDir}" && pnpm install`,
    )
  }
  return `pnpm install 完成（via ${r.via}）`
})

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
console.log(`插件     : ${PLUGIN_ROOT}`)
console.log(`dsh home : ${DSH_HOME}`)
console.log(`数据仓库 : ${DATA_DIR}`)
console.log(DRY ? '\n模式     : dry-run（不改任何文件）\n' : '\n模式     : 实际执行\n')

let failed = false
for (const s of steps) {
  process.stdout.write(`→ ${s.label} ... `)
  try {
    const msg = s.fn()
    console.log(msg)
  } catch (e) {
    console.log('失败')
    console.error(`\n  ${e && e.message ? e.message : e}\n`)
    failed = true
    break
  }
}

if (failed) process.exit(1)

console.log('\n完成。下一步：')
console.log('  1. 重启 DSH（bundle 在启动时挂载，无法热加载）')
console.log('  2. 浏览器 Ctrl+Shift+R 刷新')
console.log('  3. 输入框左侧出现「专家」按钮；面板应显示 448 位')
console.log('\n自检：node bin/wbx.mjs doctor')
