# dsh-wb-experts

**WorkBuddy 专家选择器（DSH 插件）** —— 在 DSH 输入框工具行左侧加一个「专家」按钮，点开是带**搜索框**、**说明**与**常用排序**的专家面板；选中即自动上岗（junction 到 skill 扫描根）并把 `/<skill> ` 写进输入框，走 dsh 原生的 skill 用户调用通道。

> 双半侧 Cordis 插件：Host 半侧（`lib/index.js`）+ 浏览器半侧（`lib/client.js`），通过 bundle patch 挂进 DSH profile。

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

### Auto Mode

列表最上面有一行「**不确定用哪个？**」，点它会把 `/wb-expert-finder ` 写进输入框。之后直接描述任务即可，agent 会自己搜库、上岗、加载最合适的那位专家。

机制上不复杂，但值得说清楚：

- `wb-expert-finder` 是一个**常驻 skill**（放在 dsh 的 skill 扫描根里），描述里写明「任务需要专业能力、且不确定用谁时用它」，任何 agent 看到任务就能自己想起来用。
- 它常驻的代价只有**一个 skill 描述**；全量挂载则是每会话几万 token，所以插件故意不挂，改成按需上岗。
- 搜索建议给 **2-4 个同义词**（库里存的是专家自称「安全工程师」，你想的是任务词「渗透测试」，单词搜会漏）。

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
| `list` | — | `{experts, staged, usage, lib, stage, total}` |
| `stage` | `{name}` | 建链接，`{staged, already}` |
| `unstage` | `{name}` | 删链接，`{staged, already}` |
| `touch` | `{name}` | 使用计数 +1 |

数据源（均相对当前用户主目录）：

- `~/.dsh/wb-experts/` —— 专家库（每个专家一个 `<name>/SKILL.md`，加一份 `_index.json`）
- `~/.dsh/skills/` —— dsh skill 扫描根
- `~/.dsh/wb-experts/_usage.json` —— 使用计数（常用排序的依据）
- `~/.dsh/wb-experts/_host-boot.log` —— 启动落痕（排障用）

信封严格贴合官方 schema：请求 `{ type:"client-request", rpcId, method, payload }`，响应 `{ type:"server-response", rpcId, result }`，`result = { ok:true, value } | { ok:false, error:{ code, message, details } }` —— `error` 必须是对象，浏览器侧会逐字段校验。

**安全边界**：`stage` / `unstage` 只接受 `^[a-z0-9][a-z0-9-]*$` 且必须在库内真实存在的名字（杜绝路径穿越）；`unstage` 额外校验目标确实是本插件建的链接（真实路径落在专家库内），**绝不删用户自己的 skill**。

### 浏览器半侧（`lib/client.js`）

- 挂载点 `conversation.input.left`（list 插槽，session 作用域，`replaceRisk: none` —— 追加位，不顶掉官方 UI）
- 无 JSX，用 `React.createElement`；样式直接插 `<style data-plugin-css>`，由模块系统按插件认领并回收
- 写入输入框走 `inputActions.captureInsertion()` + `inputActions.insertText(text, span)`（Lexical 真实状态机），而不是直接改 DOM

## 安装

前置：一个可用的 DSH 安装，且已有一份专家库落在 `~/.dsh/wb-experts/`（`<name>/SKILL.md` + `_index.json`）。本仓库**不含**专家档案数据。

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
3. **重启 DSH**（bundle 在启动时挂载；Host 半侧的 RPC 通道无法热加载），然后浏览器 `Ctrl+Shift+R`

> 只加 `dependencies` 不会加载插件，**必须**同时加进 `dsh.profile.bundles`。

卸载：两处各删一行 → `pnpm install` → 重启。

## 排障

- **按钮没出现**：确认 `bundles` 里有 `dsh-wb-experts`，然后重启 + `Ctrl+Shift+R`。浏览器控制台搜 `dsh-wb-experts`。
- **面板打开但列表空**：Host 侧读不到 `~/.dsh/wb-experts/_index.json`，重建专家库索引即可。
- **选中后 `/name` 没生效**：确认该 skill 已上岗（`~/.dsh/skills/<name>` 是指向专家库的链接）；新上岗的 skill 需要几毫秒让文件系统 watcher 刷新，写完任务再回车通常已足够。
- **`transport failure ... HTTP 405`**：RPC 路由没落地。看 `~/.dsh/wb-experts/_host-boot.log` —— 正常应有 `RPC 路由 /api/dsh-wb-experts 注册成功（connection.fetch.register）`。若出现 `cannot get property "webServer" without inject`，说明有人把它改回了 `connection.rpc.handle`（那条路在部分 DSH 版本上不通，见上文）。
- **前端起不来**：检查 `lib/client.js` 是否漏了 `exports.inject` —— 症状是 `web boot: N entry did not activate`。

## 测试

```bash
node tests/host-selftest.mjs        # Host 半侧分发逻辑
node tests/client-logic-test.mjs    # 浏览器半侧纯逻辑（拿真实 _index.json 跑真实代码）
node tests/client-selftest.mjs      # 浏览器半侧自检
node tests/stage-roundtrip.mjs      # 上岗 / 下岗往返
node tests/live-cordis-check.mjs    # 用真实 dsh 源码在独立 Node 进程装配最小 cordis，实测路由注册与端到端
```

`tests/live-cordis-check.mjs` 不需要重启 DSH，也不影响正在运行的实例。

## License

MIT
