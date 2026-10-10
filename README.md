# dsh-wb-experts

**WorkBuddy 专家选择器（DSH 插件）** —— 在 DSH 输入框工具行左侧加一个「专家」按钮，点开是带**搜索框**、**说明**与**常用排序**的专家面板；选中即自动上岗（链接到 skill 扫描根）并把 `/<skill> ` 写进输入框，走 dsh 原生的 skill 用户调用通道。

> 双半侧 Cordis 插件：Host 半侧（`lib/index.js`）+ 浏览器半侧（`lib/client.js`），通过 bundle patch 挂进 DSH profile。
> 附带一个可移植的 Node CLI（`bin/wbx.mjs`）与 Auto Mode 用的 meta-skill（`skills/wb-expert-finder/`，启动时自动安装）。

## 它解决什么

把几百位专家全量挂进 skill 扫描根，成本是每会话几万 token 的描述预算；而按需挂载又要求你先记住专家的 kebab-case 名字。本插件把「找 → 选 → 上岗 → 写进输入框」压成一次点击：

- **全量常挂太贵** —— 描述全塞进会话目录会持续吃掉上下文预算。
- **记不住名字** —— 不需要先知道 skill 名，搜索即选。
- **按需上岗** —— 只有真正用到的那几位进扫描根，其余留在库里。

## 功能

- 输入框左侧 **「专家」** 按钮，带**数字徽章**（如 `专家 2`）——不用打开面板就知道当前有几位专家在岗。
- 面板左侧 **分类栏**（`全部` + 各分类，带数量）；一旦输入关键词就**跨全部分类**搜索，分类栏高亮自动回到「全部」，界面状态与实际过滤条件始终一致。
- 关键词同时匹配 **skill 名 / 中文名 / 英文名 / 职业 / 插件名 / 分类名**。
- 排序：**用过次数降序 → 已上岗优先 → 字典序**（常用自然浮到最前）。
- 每行两行显示：第一行 skill 名 + `★n`（用过 n 次），第二行中文名与定位。
- 分类栏里的 **`已上岗`** 项（有专家在岗时才出现）只看挂着的那几位，且「取消上岗」**常驻显示**，方便一次摘干净。
- 键盘 `↑` `↓` 移动，`Enter` 选用，`Esc` 关闭。
- 选中后：未上岗的先自动上岗（**热加载，不用重启**），然后把 `/<skill> ` 写进输入框。
- **反悔**：鼠标移到某一行，右侧浮现「取消上岗」，点一下即下岗（只删链接，专家库本体与用户自己的 skill 都不动）。
- 计数栏：不搜索时显示 `共 N 位`；搜索时显示 `命中 M / 共 N`。

## Auto Mode（不确定用哪个，就让 agent 自己挑）

列表最上面有一行「**不确定用哪个？**」，点它会把 `/wb-expert-finder ` 写进输入框。之后直接描述任务即可，agent 会自己搜库、上岗、加载最合适的那位专家。

- `wb-expert-finder` 是插件**自带**的 meta-skill（`skills/wb-expert-finder/SKILL.md`），插件启动时自动安装到 skill 扫描根，并把正文里的 CLI 路径替换成本机真实路径 —— 所以新用户开箱即用，不需要额外准备任何东西。
- 它常驻的代价只有**一个 skill 描述**；全量挂载则是每会话几万 token，所以插件故意不挂，改成按需上岗。
- 安装是**受管的**：只覆盖本插件写的那份（判据是 frontmatter 里的 `metadata.managedBy: dsh-wb-experts`）。你自己的同名 skill 一律不动；要长期自定义，把 `metadata` 里的 `managedBy` 删掉即可。
- 若 Host 写不进去（权限/磁盘），面板上那一行会置灰并给出原因，而不是让你写入一个加载不了的 skill 名。

## 命令行等价物：`bin/wbx.mjs`

面板能做的事，命令行都能做（agent 走的也是这条路）。只用 Node，无 Python 依赖：

```bash
node bin/wbx.mjs doctor                # 体检：库 / 索引 / 搜索索引 / 扫描根
node bin/wbx.mjs list [关键词]         # 列专家（名/中文名/英文名/职业/分类）
node bin/wbx.mjs find "渗透 安全 pentest"   # 多词 OR 全文搜索
node bin/wbx.mjs use <name> [...]      # 上岗（热加载）
node bin/wbx.mjs off <name> [...]      # 下岗（只删本库建的链接）
node bin/wbx.mjs on                    # 列出当前已上岗
node bin/wbx.mjs show <name>           # 打印某位专家的 SKILL.md
node bin/wbx.mjs index                 # 重建全文搜索索引 _search.json
node bin/wbx.mjs path                  # 打印解析出的路径（排障）
```

任何命令都可加 `--json` 拿机器可读结果。路径由 `$DSH_HOME` → `~/.dsh` 推出，也可用 `DSH_WBX_LIB` / `DSH_WBX_STAGE` 临时覆盖。

**搜索建议给 2-4 个同义词**（「渗透 安全 pentest」）：库里存的是专家的自称（「安全工程师」），你想的是任务词（「渗透测试」），单词搜会漏。

> `wbx index` 生成 `_search.json`（约 6 MB），语料是每位专家 `SKILL.md` 的**整份全文**。
> 为什么必须这么做：`_index.json` 里**没有 `description` 字段**，而专家的自我介绍写在正文里 ——
> 实测不建全文索引时 `find "渗透"` 命中 **0** 位，建了之后命中 **6** 位。

## 架构

### Host 半侧（`lib/index.js`）

在官方共享通道 `/api` 之下注册一条**精确 Fetch 路由** `/api/dsh-wb-experts`：

```js
ctx.connection.fetch.register({
  path: '/api/dsh-wb-experts',
  methods: ['POST'],
  requestBody: 'buffered',
  fetch: handleFetch,
})
```

浏览器侧调用形态：`connection.rpc.call('/api', 'dsh-wb-experts', { endpoint, args })`。

> **为什么不用 `connection.rpc.handle('/dsh-wb-experts', ...)`？**
> `HostConnectionService.register()` 末行是 `owner.effect(() => owner.webServer.register(route), ...)`，而 `owner` 就是 connection 服务自己的 `this.ctx`。Cordis 的服务可见性是「祖先 fiber 链 + 显式 inject」，不是全局注册表，webServer 只由 `ctx.inject(["webServer"])` 派生的子 ctx 可见 —— 在 connection 的 ctx 上访问 `owner.webServer` 直接抛 `cannot get property "webServer" without inject`。该异常从 `rpc.handle()` 同步抛出 → 第三方插件的 inject 回调中断 → 路由静默不落地，浏览器侧只看到 `HTTP 405`，而日志看起来「注册过了」，极具误导性。
> `fetch` 路由写的是 connection 的 `fetchRoutes` Map，由官方 `/api` 路由的共享处理器优先命中，全程不碰 webServer，是官方插件（file / upload / deliverables / log-export）在用的机制。

| 端点 | 入参 | 返回 |
|---|---|---|
| `ping` | `{client}` | 客户端报到（排障：证明浏览器半侧真的装载了） |
| `list` | — | `{experts, staged, usage, lib, stage, total, finder}` |
| `stage` | `{name}` | 建链接，`{staged, already}` |
| `unstage` | `{name}` | 删链接，`{staged, already}` |
| `touch` | `{name}` | 使用计数 +1 |
| `finder` | — | Auto Mode 载体（`wb-expert-finder`）的安装状态 |

数据源（路径由 dsh home 推出）：

- `<dsh home>/wb-experts/` —— 专家库（每个专家一个 `<name>/SKILL.md`，加一份 `_index.json`）
- `<dsh home>/skills/` —— dsh skill 扫描根
- `<dsh home>/wb-experts/_usage.json` —— 使用计数（常用排序的依据）
- `<dsh home>/wb-experts/_search.json` —— 全文搜索语料（由 `wbx index` 生成）
- `<dsh home>/wb-experts/_host-boot.log` —— 启动落痕（排障用）

> **dsh home 的解析**：官方 `dsh-skill-filesystem` 用 `resolveDshHome()`，优先级是
> 「显式配置 > `$DSH_HOME` > `~/.dsh`」。插件拿不到它的 config（Cordis 的 config 是
> `apply(ctx, config)` 的第二个参数，属于各插件自己），所以按同样优先级读 `$DSH_HOME`。
> 不 import 官方那个包是因为它是 dsh 自身的依赖，不在本插件的依赖树里。

信封严格贴合官方 schema：请求 `{ type:"client-request", rpcId, method, payload }`，响应 `{ type:"server-response", rpcId, result }`，`result = { ok:true, value } | { ok:false, error:{ code, message, details } }` —— `error` 必须是对象，浏览器侧会逐字段校验。

**安全边界**：`stage` / `unstage` 只接受 `^[a-z0-9][a-z0-9-]*$` 且必须在库内真实存在的名字（杜绝路径穿越）；`unstage` 额外校验目标确实是本插件建的链接（真实路径落在专家库内），**绝不删用户自己的 skill**。finder skill 的安装同样只覆盖带 `managedBy` 标记的那份。

### 浏览器半侧（`lib/client.js`）

- 挂载点 `conversation.input.left`（list 插槽，session 作用域，`replaceRisk: none` —— 追加位，不顶掉官方 UI）
- 无 JSX，用 `React.createElement`；样式直接插 `<style data-plugin-css>`，由模块系统按插件认领并回收
- 写入输入框走 `inputActions.captureInsertion()` + `inputActions.insertText(text, span)`（Lexical 真实状态机），而不是直接改 DOM

## 安装

前置：一个可用的 DSH 安装，且已有一份专家库落在 `<dsh home>/wb-experts/`（`<name>/SKILL.md` + `_index.json`）。本仓库**不含**专家档案数据（见下方「专家库从哪来」）。

1. 把插件放到任意目录，然后在 DSH profile 的 `package.json` 里**两处**都加：

```jsonc
{
  "dependencies": {
    "dsh-wb-experts": "link:/path/to/dsh-wb-experts"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-wb-experts"
      ]
    }
  }
}
```

2. 安装依赖：`pnpm install`
3. **重启 DSH**（bundle 在启动时挂载；Host 半侧的 RPC 通道与 finder skill 的安装都在启动时做），然后浏览器 `Ctrl+Shift+R`
4. 建一次搜索索引：`node bin/wbx.mjs index`（约 6 MB，一次性）

> 只加 `dependencies` 不会加载插件，**必须**同时加进 `dsh.profile.bundles`。

卸载：两处各删一行 → `pnpm install` → 重启。已安装的 `wb-expert-finder` 需要手动删除（插件不会再清理它，以免误删你改过的那份）。

### 专家库从哪来

本仓库只发布**插件本体**，不包含 WorkBuddy 的专家档案。你需要自己准备一份 `<dsh home>/wb-experts/`：

- 目录结构：每个专家一个 `<name>/SKILL.md`（YAML frontmatter 必填 `name` + `description`），可选 `<name>/references/`
- 索引：`_index.json`，数组，每条至少含 `dsh_name`（kebab-case，与目录同名）；推荐再带 `zh` / `en` / `profession` / `category` / `category_zh` / `expertType` / `subskills`（面板的分类栏、中文名、排序都依赖这些字段）
- 建好库后跑 `node bin/wbx.mjs index` 生成全文搜索语料
- 体检：`node bin/wbx.mjs doctor`

任何来源的专家/skill 只要符合上面的结构都能用，不限于 WorkBuddy。

## 排障

- **按钮没出现**：确认 `bundles` 里有 `dsh-wb-experts`，然后重启 + `Ctrl+Shift+R`。浏览器控制台搜 `dsh-wb-experts`。
- **面板打开但列表空**：Host 侧读不到 `<dsh home>/wb-experts/_index.json`。跑 `node bin/wbx.mjs doctor` 看它解析出的路径是否与你的实际库一致（不一致就是 `$DSH_HOME` 的问题）。
- **搜不到想要的专家**：先 `node bin/wbx.mjs index` 建全文索引；再给 2-4 个同义词。
- **Auto Mode 那一行置灰**：Host 没能把 `wb-expert-finder` 写进扫描根。看 `<dsh home>/wb-experts/_host-boot.log` 里的 `finder skill:` 行。
- **选中后 `/name` 没生效**：确认该 skill 已上岗（`<dsh home>/skills/<name>` 是指向专家库的链接）；新上岗的 skill 需要几毫秒让文件系统 watcher 刷新，写完任务再回车通常已足够。
- **`transport failure ... HTTP 405`**：RPC 路由没落地。看 `_host-boot.log` —— 正常应有 `RPC 路由 /api/dsh-wb-experts 注册成功（connection.fetch.register）`。若出现 `cannot get property "webServer" without inject`，说明有人把它改回了 `connection.rpc.handle`（那条路在部分 DSH 版本上不通，见上文）。
- **前端起不来**：检查 `lib/client.js` 是否漏了 `exports.inject` —— 症状是 `web boot: N entry did not activate`。

## 测试

```bash
npm test    # 串跑下面四支
```

```bash
node tests/host-selftest.mjs        # Host 半侧分发逻辑 + 信封/边界（mock cordis ctx）
node tests/client-logic-test.mjs    # 浏览器半侧纯逻辑（拿真实 _index.json 跑真实代码）
node tests/finder-install.mjs       # finder 内置安装/幂等/升级/不覆盖用户 skill + CLI 端到端
node tests/stage-roundtrip.mjs      # 上岗 / 下岗往返
node tests/live-cordis-check.mjs    # 用真实 dsh 源码在独立 Node 进程装配最小 cordis，实测路由注册
```

`tests/finder-install.mjs` 全程在 `$DSH_HOME` 指向的临时目录里跑，不碰你真实的 `~/.dsh`。
`tests/live-cordis-check.mjs` 不需要重启 DSH，也不影响正在运行的实例。

## License

MIT
