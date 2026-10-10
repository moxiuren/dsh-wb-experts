/**
 * dsh-wb-experts —— WorkBuddy 专家选择器（浏览器半侧）。
 *
 * 本文件是手工维护的 `window.__ModuleLoader__.load({ id, factory })` bundle，
 * 与 dsh-step-timings / dsh-path-paste / 官方 ui-* 插件同一形态：
 * CJS factory、无 JSX、依赖通过 factory 的 `require` 形参注入。
 * 修改后执行 `node --check lib/client.js` 验证语法，**刷新页面即生效**（客户端半侧热加载）。
 *
 * ---------------------------------------------------------------------------
 * 血泪教训（抄自 dsh-step-timings，逐条遵守）：
 *
 * 1) **必须导出 `inject` 数组**。Cordis 靠 `exports.inject` 决定等哪些服务就绪
 *    才调用 `apply`；漏掉它，`apply` 会在 `ctx.slots` 未就绪时执行 → fiber FAILED
 *    → 前端报 `web boot: N entry did not activate`，整个应用起不来。
 * 2) **`apply` 只接一个参数 `ctx`**，没有第二个 `builtins`。
 * 3) **CSS 直接插 `<style>`**，模块系统会认领未标记的 style 标签并回收。
 * 4) **`slots.register` 必须带 `id`**，且整体用 `ctx.slots.inject(key, () => ...)` 包住。
 *
 * v0.1.1 修掉的真 bug（首版面板空白）：
 *   **connection 是惰性就绪的，rpc 句柄绝不能缓存。** 首版把 `rpcOf(ctx)` 放进
 *   `useMemo([ctx])`，只在组件挂载那一刻算一次；那一刻 connection 还没就绪，
 *   于是 rpc 永久为 null，`list` 永远失败，面板永远空 —— 而且失败被静默吞掉，
 *   连个提示都没有。现在改成**每次调用现取**（与 dsh-path-paste 同一套做法），
 *   并加上失败重试与可见的诊断信息。
 *
 * v0.1.2 修掉的真 bug（HTTP 405）：
 *   旧版调 `rpc.call('/dsh-wb-experts', endpoint, args)`，而 Host 侧用
 *   `connection.rpc.handle()` 注册该通道 —— 那条路在 dsh 0.2.0-rc.2 上是坏的
 *   （根因见 lib/index.js 文件头的完整推导：`register()` 内部依赖 connection ctx
 *   上看不见的 `webServer`，异常被同步抛出，路由从未注册）。
 *   现在两端一起改走官方共享通道：
 *     Host   `connection.fetch.register({ path: '/api/dsh-wb-experts', ... })`
 *     浏览器 `rpc.call('/api', 'dsh-wb-experts', { endpoint, args })`
 *   同时把失败结果按官方 schema 归一化（`error` 是 `{code,message,details}` 对象，
 *   不是字符串），面板只显示其中的 message。
 *
 * v0.1.3 补上的功能（小莫实测反馈）：
 *   ① **面板以前只有上岗入口、没有下岗入口** —— 误点一位专家就只能干看着它带 ON。
 *      现在行内的 `ON` 标签本身就是按钮：hover 变「取消」，点它即下岗（走 Host 的
 *      `unstage` 端点，只删本插件建的 junction，专家库本体与用户自己的 skill 都不动）。
 *   ② 计数栏以前写 `300 / 448`，看着像「只加载了一半」—— 其实是 300 行渲染上限在截断。
 *      上限提到 500（448 条轻量行实测渲染无压力），并把「命中数」与「渲染数」拆开算，
 *      常态下显示真实总数「共 448 位」。
 *   ③ 底部加图例 `★n 用过次数 · ON 点它取消`，两处 hover 都有完整说明。
 *
 * v0.1.4 的调整（小莫反馈「ON 是多余的，按了都直接注入对话框了」）：
 *   **去掉常驻的 ON 标签** —— 上岗本来就是自动的（点行即用），常驻显示只是噪音。
 *   取消上岗的能力保留，改成**鼠标移到该行才浮现**的「取消上岗」小按钮；
 *   用 `visibility` 占位而不是 `display`，避免 hover 时整行文字左右跳动。
 *
 * v0.1.5 的分类二级菜单（小莫：「四百多太多太乱了」）：
 *   数据本来就有分类：`_index.json` 每条带 `category`（如 06-ContentCreative）与
 *   `category_zh`（如 内容创作），共 15 类、448 位。
 *   面板改成**左侧分类栏 + 右侧列表**：分类按 `category` 前缀序号 01..15 排序
 *   （与 WorkBuddy 官方顺序一致，不是字典序），各自带数量。
 *   有搜索词时忽略分类、跨全库搜，分类栏高亮同步回「全部」—— 界面状态永远等于实际过滤条件。
 *   行同时改成两行：列宽从 460 收到约 350 后，长 skill 名（academic-journal-selector-team-lead
 *   这种）独占一行才不会把中文名和定位挤没。
 *   逻辑抽成 `filterExperts` / `sortExperts` / `buildCats` 三个纯函数并从 `exports.__test`
 *   出口暴露，好让 tests/client-logic-test.mjs 拿真实 _index.json 跑真实代码。
 *
 * v0.1.7 「当前挂着哪几位」可见（小莫需求）：
 *   上岗的每位都进会话 skill 目录、占上下文，所以这件事必须随时看得见：
 *   ① 输入框左侧按钮上加**数字徽章**（`专家 2`），面板没打开也知道有几位在挂，hover 列出名字；
 *   ② 分类栏加一项 **`已上岗`**（有上岗时才出现）—— 它是**范围**不是分类，
 *      所以搜索时**保留**它（在已上岗里找比跳到全库更有用），这点与真实分类相反；
 *   ③ 该视图里「取消上岗」按钮**常驻显示**，进这个视图就是为了管理，不用再逐个 hover。
 * ---------------------------------------------------------------------------
 *
 * 挂载点：`conversation.input.left`（list 型插槽，session 作用域，
 * `replaceRisk: none` —— 官方语义是「输入框工具行左侧的紧凑控件」，
 * 与附件按钮同一排，追加不会顶掉任何官方 UI）。
 *
 * 选中一位专家后的动作链：
 *   ① 若未上岗 → 调 Host 建 junction（热加载，无需重启）
 *   ② 记一次使用计数（用于常用置顶）
 *   ③ 把 `/<skill> ` 写进输入框 —— 这是 dsh 原生的 skill 用户调用通道，
 *      用户接着写任务、回车，该 skill 的指令就被注入这一步。
 */

;(function () {
  try {
    window.__ModuleLoader__.load({
  id: 'dsh-wb-experts',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    /**
     * RPC 目标：官方共享通道 `/api` + 本插件的路由段。
     *
     * Host 半侧把精确 Fetch 路由挂在 `/api/dsh-wb-experts` 上，所以调用形态是
     * `rpc.call('/api', 'dsh-wb-experts', { endpoint, args })` —— 端点在 payload 里，
     * 而不是 URL 上。理由：一个精确路由就能覆盖 list/stage/unstage/touch/ping，
     * 不必注册五条 path，也不会与官方 /api 的 interceptor 抢槽位。
     */
    var RPC_CALL_CHANNEL = '/api'
    var RPC_ENDPOINT = 'dsh-wb-experts'
    /** 样式命名空间。 */
    var NS = 'dsh-wb-experts'
    /** 客户端版本（报到用）。 */
    var VERSION = '0.1.8'
    /**
     * 单次最多渲染多少行。
     *
     * 448 条轻量行（每行 3-5 个 span）实测渲染无压力，上限设 500 只是为了
     * 将来专家库暴涨时留个保险 —— **常态下永远不截断**，所以计数栏显示的是
     * 真实总数，而不是「300 / 448」这种看着像「只加载了一半」的数字。
     */
    var MAX_ROWS = 500
    /**
     * Auto Mode 用的 meta-skill 名 —— 常驻在 dsh 扫描根（~/.dsh/skills/wb-expert-finder），
     * 描述里写明「任务需要专业能力且不确定用谁时用它」，agent 看到就会自己搜库、上岗、加载。
     * 常驻成本只有一个 skill 描述，比把 448 位全挂上去（约 27K token）便宜三个数量级。
     */
    var AUTO_SKILL = 'wb-expert-finder'
    /** 分类栏里的伪分类：只看已上岗的专家（哨兵值，不会与真实分类撞名）。 */
    var STAGED_CAT = '__staged__'
    /** 数据缓存有效期（毫秒）。 */
    var CACHE_TTL = 5000
    /** 首次拉数据失败时的重试次数与间隔（connection 惰性就绪）。 */
    var RETRIES = 6
    var RETRY_MS = 400

    var CSS = [
      // 按钮对齐官方 InputBar 工具行的同排控件（源码 packages/client/ui-conversation/.../InputBar.module.css）：
      //   .add    = 28x28 图标按钮，背景 var(--dsw-specific-selector)
      //   .select = 带文字控件，font-size 13 / font-weight 500 / line-height 20 / height 28
      // 关键：<button> 默认**不继承** font-family，会落到系统 UI 字体 —— 那正是「割裂感」的根因，必须显式 inherit。
      '.dsh-wbx-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;',
      'border:0;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-specific-selector,transparent);',
      'cursor:pointer;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;',
      'font-size:13px;font-weight:500;line-height:20px;white-space:nowrap}',
      '.dsh-wbx-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.16))}',
      '.dsh-wbx-btn[data-open=true]{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.24))}',
      '.dsh-wbx-btn svg{width:14px;height:14px;flex:none}',
      // 已上岗数量徽章：常驻在按钮上 —— 不用打开面板就知道现在挂着几位专家
      // （每位都进会话 skill 目录、占上下文，这个数字值得一直在）。
      '.dsh-wbx-badge{flex:none;min-width:16px;padding:0 4px;border-radius:8px;',
      'background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.24));',
      'color:var(--dsw-alias-label-primary,inherit);font-size:11px;line-height:16px;',
      'text-align:center;font-variant-numeric:tabular-nums}',
      '.dsh-wbx-wrap{position:relative;display:inline-flex}',

      // 教训（2026-10-09，两次踩坑）：
      //   ① 不要用 --dsw-alias-bg-overlay：那是**遮罩层**色（light #e9ecf2 / dark bluish-700），
      //      拿它承载文字，浅色文字糊在浅灰底上，对比度不足。
      //   ② 更不要用 --dsw-specific-menu：它在某些主题块里被定义为 var(--dsw-menu-surface-fill)，
      //      而该变量在输入框工具行作用域内未定义。CSS 变量「已定义但值无效」会让整条
      //      background 声明在 computed-value 阶段失效并回退成 transparent ——
      //      此时 var() 的 fallback 参数**不会**生效，三层兜底也救不回来，面板会全透明。
      //   结论：浮层背景只用值确定的 token。--dsw-alias-bg-layer-2 的值是
      //   var(--dsw-static-neutral-bluish-00) / (bluish-850)，且第一版已实证有效。
      //   圆角同理：--dsw-radius-panel 是 28px（大卡片用），浮层用 --dsw-radius-md（12px）。
      '.dsh-wbx-panel{position:absolute;left:0;bottom:calc(100% + 8px);width:460px;max-width:calc(100vw - 32px);',
      'display:flex;flex-direction:column;max-height:440px;z-index:60;overflow:hidden;font-family:inherit;',
      'background:var(--dsw-alias-bg-layer-2,#22232a);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));',
      'border-radius:var(--dsw-radius-md,12px);box-shadow:0 12px 32px rgba(0,0,0,.32)}',

      '.dsh-wbx-search{display:flex;align-items:center;gap:8px;padding:10px 12px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));flex:none}',
      '.dsh-wbx-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;',
      'color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:13px;line-height:20px}',
      '.dsh-wbx-search input::placeholder{color:var(--dsw-alias-label-tertiary,#8b8b93)}',
      '.dsh-wbx-count{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b8b93);',
      'font-variant-numeric:tabular-nums}',

      // 二级结构：左侧分类栏（固定 104px）+ 右侧列表（弹性）。
      // body 用 flex:1 + min-height:0，两个子区域各自滚动、互不影响。
      '.dsh-wbx-body{display:flex;flex:1;min-height:0}',
      '.dsh-wbx-cats{flex:none;width:104px;overflow-y:auto;overscroll-behavior:contain;padding:4px;',
      'border-right:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}',
      '.dsh-wbx-cats::-webkit-scrollbar{width:6px}',
      '.dsh-wbx-cats::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.3));border-radius:3px}',
      '.dsh-wbx-cat{display:flex;align-items:center;justify-content:space-between;gap:4px;width:100%;',
      'padding:5px 7px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;',
      'cursor:pointer;text-align:left;font-family:inherit;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap}',
      '.dsh-wbx-cat:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
      '.dsh-wbx-cat[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));',
      'color:var(--dsw-alias-label-primary,inherit);font-weight:500}',
      '.dsh-wbx-cat-n{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b93);',
      'font-variant-numeric:tabular-nums}',
      '.dsh-wbx-cat[data-active=true] .dsh-wbx-cat-n{color:var(--dsw-alias-label-secondary,inherit)}',

      '.dsh-wbx-list{flex:1;min-width:0;overflow-y:auto;overscroll-behavior:contain;padding:4px}',
      '.dsh-wbx-list::-webkit-scrollbar{width:8px}',
      '.dsh-wbx-list::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.3));border-radius:4px}',
      '.dsh-wbx-list::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,rgba(127,127,127,.5))}',

      // 行改两行：skill 名独占一行（academic-journal-selector-team-lead 这种长名才不会挤掉别的信息），
      // 中文名与定位放第二行。列宽从 460 收到约 350 之后，这是必需的。
      '.dsh-wbx-row{display:flex;flex-direction:column;gap:1px;padding:7px 8px;',
      'border-radius:var(--dsw-radius-sm,6px);cursor:pointer;border:0;background:transparent;',
      'width:100%;text-align:left;font-family:inherit;font-size:13px;line-height:18px}',
      '.dsh-wbx-row[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
      '.dsh-wbx-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
      '.dsh-wbx-l1,.dsh-wbx-l2{display:flex;align-items:center;gap:6px;width:100%;min-width:0}',
      // 名字与宿主统一字体族（不用等宽体），靠字重 + 主色保持辨识度。
      '.dsh-wbx-name{flex:1;min-width:0;font-size:13px;font-weight:500;',
      'color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-wbx-zh{flex:none;max-width:62%;font-size:12px;color:var(--dsw-alias-label-secondary,inherit);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-wbx-desc{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b93);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-wbx-star{flex:none;font-size:11px;color:var(--dsw-alias-state-warn-primary,#d99a2b)}',
      // Auto Mode 入口：虚线边框与专家行区分开，视觉上像「一个建议」而不是「一位专家」。
      '.dsh-wbx-auto{display:flex;align-items:baseline;gap:8px;width:100%;margin:0 0 4px;',
      'padding:7px 8px;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.32));',
      'border-radius:var(--dsw-radius-sm,6px);background:transparent;cursor:pointer;',
      'text-align:left;font-family:inherit;font-size:12px;line-height:18px}',
      '.dsh-wbx-auto:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
      // 不可用态（Host 没能把 finder skill 写进扫描根）：置灰 + 禁指针，点它不该写进一个加载不了的 skill 名。
      '.dsh-wbx-auto-off{opacity:.55;cursor:not-allowed;border-style:solid}',
      '.dsh-wbx-auto-off:hover{background:transparent}',
      '.dsh-wbx-auto-t{flex:none;color:var(--dsw-alias-label-secondary,inherit)}',
      '.dsh-wbx-auto-d{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary,#8b8b93);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 取消上岗：默认**不可见**。上岗本来就是自动的（点行即用），常驻一个 ON 标签只是噪音；
      // 但取消能力要留着，所以鼠标移到该行才浮现。用 visibility（而非 display）占住位置，
      // 免得 hover 时整行文字左右跳动。
      '.dsh-wbx-unstage{flex:none;visibility:hidden;font-size:11px;line-height:16px;padding:0 6px;',
      'border-radius:3px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));',
      'color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;white-space:nowrap}',
      '.dsh-wbx-row:hover .dsh-wbx-unstage{visibility:visible}',
      // 在「已上岗」视图里取消按钮常驻 —— 进这个视图就是为了管理，不用再逐个 hover 找。
      '.dsh-wbx-unstage-always{visibility:visible}',
      '.dsh-wbx-unstage:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.2));',
      'color:var(--dsw-alias-label-primary,inherit)}',

      '.dsh-wbx-foot{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));',
      'font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8b8b93)}',
      '.dsh-wbx-foot kbd{font:inherit;padding:0 4px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));',
      'border-radius:3px}',
      '.dsh-wbx-legend{flex:none;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}',
      '.dsh-wbx-empty{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;padding:18px 12px;text-align:center;font-size:13px;line-height:1.7;',
      'color:var(--dsw-alias-label-tertiary,#8b8b93)}',
      '.dsh-wbx-empty code{font-size:11px;word-break:break-all}',
      '.dsh-wbx-err{color:var(--dsw-alias-label-error,#d9534f)}',
    ].join('')

    // ---- 数据层：模块级缓存，跨组件实例共享 ---------------------------------

    var cache = {
      experts: null,
      staged: null,
      usage: {},
      at: 0,
      inflight: null,
      /** 最近一次失败原因；面板空时直接显示它，不再静默。 */
      error: '',
      /** 是否已成功拉过一次。 */
      ok: false,
      /** 排障：Host 返回的库路径。 */
      lib: '',
      stage: '',
      /** Auto Mode 载体（wb-expert-finder skill）状态；null = 未知（旧版 Host）。 */
      finder: null,
    }

    /**
     * 取 `connection.rpc.call`。
     *
     * **每次都现取，绝不缓存** —— connection 服务是惰性就绪的，apply 时机
     * 早于它就绪是常态；把 null 缓存下来会让面板永久空白（v0.1.0 就是这么空的）。
     *
     * 返回 `{ rpc, why }`：失败时把**卡在哪一环**说清楚，而不是笼统的
     * 「未就绪」——面板会把它显示出来，这样不用 F12（桌面版也没有控制台）也能定位。
     */
    function rpcOf(ctx) {
      if (!ctx) return { rpc: null, why: 'ctx 缺失' }
      var connection
      try {
        var viaGet
        if (typeof ctx.get === 'function') {
          try {
            viaGet = ctx.get('connection')
          } catch (e) {
            viaGet = undefined
          }
        }
        connection = viaGet || ctx.connection
      } catch (e) {
        return { rpc: null, why: '取 connection 抛错：' + ((e && e.message) || e) }
      }
      if (!connection) return { rpc: null, why: 'connection 服务取不到' }
      if (!connection.rpc) return { rpc: null, why: 'connection.rpc 不存在' }
      if (typeof connection.rpc.call !== 'function') {
        return { rpc: null, why: 'connection.rpc.call 不是函数' }
      }
      return { rpc: connection.rpc.call.bind(connection.rpc), why: '' }
    }

    /**
     * 把官方 RPC 结果归一化成 `{ ok:true, value }` / `{ ok:false, error:字符串 }`。
     *
     * 官方失败分支的 `error` 是 `{ code, message, details }` **对象**
     * （dsh-client-connection 的 parseConnectionResponse 会逐字段校验），
     * 面板只关心 message，所以在这里压成字符串，下游代码不必关心形状。
     */
    function normalize(r) {
      if (!r || typeof r !== 'object') return { ok: false, error: 'Host 返回空响应' }
      if (r.ok) return { ok: true, value: r.value }
      var e = r.error
      if (!e) return { ok: false, error: '未知错误' }
      if (typeof e === 'string') return { ok: false, error: e }
      return { ok: false, error: e.message || e.code || '未知错误' }
    }

    /** 调 Host 端点，统一解包 { ok, value }。rpc 句柄在此现取。 */
    function call(ctx, endpoint, args) {
      var got = rpcOf(ctx)
      if (!got.rpc) {
        return Promise.resolve({ ok: false, error: got.why || 'connection 服务未就绪' })
      }
      var rpc = got.rpc
      try {
        return Promise.resolve(
          rpc(RPC_CALL_CHANNEL, RPC_ENDPOINT, { endpoint: endpoint, args: args || {} }),
        ).then(
          function (r) {
            return normalize(r)
          },
          function (e) {
            return { ok: false, error: (e && e.message) || String(e) }
          },
        )
      } catch (e) {
        return Promise.resolve({ ok: false, error: (e && e.message) || String(e) })
      }
    }

    /** 拉一次数据并写进缓存。 */
    function fetchOnce(ctx) {
      return call(ctx, 'list').then(function (r) {
        if (r.ok && r.value) {
          cache.experts = r.value.experts || []
          cache.staged = r.value.staged || []
          cache.usage = r.value.usage || {}
          cache.lib = r.value.lib || ''
          cache.stage = r.value.stage || ''
          // Auto Mode 的载体（wb-expert-finder）是否在位 —— 由 Host 在启动时安装。
          // 拿不到这个字段（旧版 Host）时按「未知」处理，仍然允许点击，不做误伤式禁用。
          cache.finder = r.value.finder || null
          cache.at = Date.now()
          cache.ok = true
          cache.error = ''
        } else {
          cache.error = r.error || '未知错误'
          cache.ok = false
        }
        return cache
      })
    }

    /**
     * 拉数据：命中 TTL 缓存直接返回；否则重试若干次 —— connection 惰性就绪，
     * 前几次 `rpcOf` 返回 null 是正常的，不该就此判死。
     */
    function load(ctx, force) {
      var now = Date.now()
      if (!force && cache.ok && cache.experts && now - cache.at < CACHE_TTL) {
        return Promise.resolve(cache)
      }
      if (cache.inflight) return cache.inflight

      var attempt = 0
      function step() {
        attempt += 1
        return fetchOnce(ctx).then(function (c) {
          if (c.ok || attempt >= RETRIES) {
            cache.inflight = null
            return c
          }
          return new Promise(function (res) {
            setTimeout(res, RETRY_MS)
          }).then(step)
        })
      }

      cache.inflight = step()
      return cache.inflight
    }

    // ---- 排序与过滤 ---------------------------------------------------------

    /** 常用优先 → 已上岗优先 → 字典序。 */
    function sortExperts(list, usage, staged) {
      var set = {}
      for (var i = 0; i < staged.length; i++) set[staged[i]] = true
      return list.slice().sort(function (a, b) {
        var ua = usage[a.dsh_name] || 0
        var ub = usage[b.dsh_name] || 0
        if (ua !== ub) return ub - ua
        var sa = set[a.dsh_name] ? 1 : 0
        var sb = set[b.dsh_name] ? 1 : 0
        if (sa !== sb) return sb - sa
        return String(a.dsh_name).localeCompare(String(b.dsh_name))
      })
    }

    /**
     * 关键词同时匹配 name / 中文名 / 英文名 / 职业 / 插件名 / 分类；
     * cat 非空时先按分类收窄（分类用中文名 category_zh）。
     */
    function filterExperts(list, q, cat) {
      var needle = q ? q.toLowerCase() : ''
      var out = []
      for (var i = 0; i < list.length; i++) {
        var e = list[i]
        if (cat && e.category_zh !== cat) continue
        if (!needle) {
          out.push(e)
          continue
        }
        var hay = [
          e.dsh_name || '',
          e.zh || '',
          e.en || '',
          e.profession || '',
          e.plugin || '',
          e.category_zh || '',
        ]
          .join(' ')
          .toLowerCase()
        if (hay.indexOf(needle) >= 0) out.push(e)
      }
      return out
    }

    /**
     * 分类清单：用 category（形如 06-ContentCreative）前两位的序号排序，
     * 与 WorkBuddy 官方分类顺序一致，而不是按中文名字典序。
     * 抽成纯函数是为了让离线测试能直接跑真实代码（tests/client-logic-test.mjs）。
     */
    function buildCats(list) {
      var count = {}
      var seq = {}
      for (var i = 0; i < list.length; i++) {
        var e = list[i]
        var c = e.category_zh
        if (!c) continue
        if (count[c] === undefined) {
          count[c] = 0
          seq[c] = parseInt(String(e.category || '').slice(0, 2), 10) || 999
        }
        count[c] += 1
      }
      var names = Object.keys(count)
      names.sort(function (a, b) {
        return seq[a] - seq[b] || a.localeCompare(b)
      })
      return { names: names, count: count }
    }

    // ---- 组件 ---------------------------------------------------------------

    var H = React.createElement

    function Icon() {
      return H(
        'svg',
        {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        H('circle', { cx: 8, cy: 5, r: 2.6 }),
        H('path', { d: 'M2.6 13.6c0-2.6 2.4-4.2 5.4-4.2s5.4 1.6 5.4 4.2' }),
      )
    }

    function WbExpertsPicker(props) {
      var ctx = props && props.__ctx
      var inputActions = props && props.inputActions

      var [open, setOpen] = React.useState(false)
      var [query, setQuery] = React.useState('')
      var [cat, setCat] = React.useState('')
      var [active, setActive] = React.useState(0)
      var [experts, setExperts] = React.useState(cache.experts || [])
      var [staged, setStaged] = React.useState(cache.staged || [])
      var [usage, setUsage] = React.useState(cache.usage || {})
      var [diag, setDiag] = React.useState('')
      var [busy, setBusy] = React.useState('')
      var [loading, setLoading] = React.useState(false)

      var wrapRef = React.useRef(null)
      var inputRef = React.useRef(null)
      var listRef = React.useRef(null)
      // ctx 存 ref：rpc 每次调用现取，这里只保证拿到最新的 ctx 对象。
      var ctxRef = React.useRef(ctx)
      ctxRef.current = ctx

      /** 把 Host 结果同步进组件状态。 */
      function applyCache(c) {
        setExperts(c.experts || [])
        setStaged(c.staged || [])
        setUsage(c.usage || {})
        setDiag(c.ok ? '' : c.error || '未取到 Host 数据')
      }

      function refresh(force) {
        setLoading(true)
        return load(ctxRef.current, force).then(function (c) {
          applyCache(c)
          setLoading(false)
          return c
        })
      }

      // 挂载：拉一次 + 向 Host 报到（排障用，日志里能看到客户端版本）
      React.useEffect(
        function () {
          var alive = true
          refresh(false).then(function (c) {
            if (!alive || !c.ok) return
            call(ctxRef.current, 'ping', { client: VERSION })
          })
          return function () {
            alive = false
          }
        },
        [],
      )

      // 打开时聚焦搜索框并强制刷新
      React.useEffect(
        function () {
          if (!open) return
          setQuery('')
          setActive(0)
          var alive = true
          refresh(true).then(function () {
            if (!alive) return
            var t = setTimeout(function () {
              if (inputRef.current) inputRef.current.focus()
            }, 0)
            cleanupTimer = t
          })
          var cleanupTimer = null
          return function () {
            alive = false
            if (cleanupTimer) clearTimeout(cleanupTimer)
          }
        },
        [open],
      )

      // 点外面关闭
      React.useEffect(
        function () {
          if (!open) return
          function onDocDown(ev) {
            if (wrapRef.current && !wrapRef.current.contains(ev.target)) setOpen(false)
          }
          document.addEventListener('mousedown', onDocDown, true)
          return function () {
            document.removeEventListener('mousedown', onDocDown, true)
          }
        },
        [open],
      )

      var stagedMap = React.useMemo(
        function () {
          var m = {}
          for (var i = 0; i < staged.length; i++) m[staged[i]] = true
          return m
        },
        [staged],
      )

      var cats = React.useMemo(
        function () {
          return buildCats(experts)
        },
        [experts],
      )

      // 有搜索词时忽略**分类**（找东西不该被分类挡住，分类栏高亮同步回「全部」）；
      // 但「已上岗」是范围不是分类，搜索时保留它 —— 在已上岗里找比跳到全库更有用。
      var shownCat = query && cat !== STAGED_CAT ? '' : cat

      // 先算「命中总数」，再截断成实际渲染行 —— 两个数分开，计数才不会骗人。
      var matched = React.useMemo(
        function () {
          var base
          if (shownCat === STAGED_CAT) {
            var on = {}
            for (var i = 0; i < staged.length; i++) on[staged[i]] = true
            base = []
            for (var j = 0; j < experts.length; j++) {
              if (on[experts[j].dsh_name]) base.push(experts[j])
            }
            base = filterExperts(base, query, '')
          } else {
            base = filterExperts(experts, query, shownCat)
          }
          return sortExperts(base, usage, staged)
        },
        [experts, query, shownCat, usage, staged],
      )

      var rows = React.useMemo(
        function () {
          return matched.slice(0, MAX_ROWS)
        },
        [matched],
      )

      React.useEffect(
        function () {
          if (!open || !listRef.current) return
          var node = listRef.current.querySelector('[data-idx="' + active + '"]')
          if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' })
        },
        [active, open, rows],
      )

      /** 把 `/<skill> ` 写进输入框 —— 走 dsh 原生的 skill 用户调用通道。 */
      function insertSlash(skillName) {
        var text = '/' + skillName + ' '
        try {
          if (inputActions && inputActions.captureInsertion && inputActions.insertText) {
            var span = inputActions.captureInsertion()
            if (inputActions.insertText(text, span)) return true
          }
          if (inputActions && inputActions.setDraft) {
            inputActions.setDraft(text)
            return true
          }
        } catch (e) {
          setDiag('写入输入框失败：' + ((e && e.message) || e))
          return false
        }
        setDiag('输入框动作不可用（inputActions 缺失）')
        return false
      }

      /** 选中一位专家：必要时先上岗，再记数，最后写进输入框。 */
      function pick(row) {
        if (!row || busy) return
        var n = row.dsh_name
        setDiag('')
        setBusy(n)

        var already = !!stagedMap[n]
        var chain = already
          ? Promise.resolve({ ok: true })
          : call(ctxRef.current, 'stage', { name: n })

        chain.then(function (r) {
          if (!r.ok) {
            setBusy('')
            setDiag('上岗失败：' + (r.error || '未知错误'))
            return
          }
          if (!already) {
            setStaged(function (prev) {
              return prev.indexOf(n) >= 0 ? prev : prev.concat([n])
            })
          }
          return call(ctxRef.current, 'touch', { name: n }).then(function () {
            setBusy('')
            if (insertSlash(n)) setOpen(false)
          })
        })
      }

      /**
       * 取消上岗：删掉 junction，把专家从 skill 扫描根摘下来。
       * 只删本插件建的上岗项（Host 侧二次校验），专家库本体与用户自己的 skill 都不动。
       */
      function unstageOne(row) {
        if (!row || busy) return
        var n = row.dsh_name
        if (!stagedMap[n]) return
        setDiag('')
        setBusy(n)
        call(ctxRef.current, 'unstage', { name: n }).then(function (r) {
          setBusy('')
          if (!r.ok) {
            setDiag('取消上岗失败：' + (r.error || '未知错误'))
            return
          }
          setStaged(function (prev) {
            return prev.filter(function (x) {
              return x !== n
            })
          })
        })
      }

      function onKeyDown(ev) {
        if (ev.key === 'Escape') {
          ev.preventDefault()
          setOpen(false)
          return
        }
        if (ev.key === 'ArrowDown') {
          ev.preventDefault()
          setActive(function (i) {
            return Math.min(i + 1, rows.length - 1)
          })
          return
        }
        if (ev.key === 'ArrowUp') {
          ev.preventDefault()
          setActive(function (i) {
            return Math.max(i - 1, 0)
          })
          return
        }
        if (ev.key === 'Enter') {
          ev.preventDefault()
          pick(rows[active])
        }
      }

      var children = []

      children.push(
        H(
          'button',
          {
            type: 'button',
            className: 'dsh-wbx-btn',
            'data-open': open ? 'true' : 'false',
            title:
              experts.length > 0
                ? 'WorkBuddy 专家（' + experts.length + ' 位）'
                : 'WorkBuddy 专家' + (diag ? '：' + diag : ''),
            onClick: function () {
              setOpen(function (v) {
                return !v
              })
            },
          },
          H(Icon, null),
          H('span', null, '专家'),
          // 常驻徽章：面板没打开时也能一眼看到「现在挂着几位专家」。
          staged.length > 0
            ? H(
                'span',
                {
                  className: 'dsh-wbx-badge',
                  title:
                    '已上岗 ' +
                    staged.length +
                    ' 位：' +
                    staged.join('、') +
                    '（点开面板可逐个取消上岗）',
                },
                String(staged.length),
              )
            : null,
        ),
      )

      if (open) {
        // Auto Mode 入口放列表最前：不确定用谁时，把「专家寻址」这个 meta-skill 写进输入框，
        // 由 agent 按任务内容自己搜库 / 上岗 / 加载。它**不带 data-idx**，所以不参与 ↑↓ 键盘导航。
        //
        // `cache.finder` 是 Host 随 list 一起回的安装状态（skill 由 Host 在启动时写入扫描根）。
        // 三态处理：null = 旧版 Host 没这个字段（照常可用，不误伤）；installed=false = 写失败，
        // 此时点它只会让输入框出现一个加载不了的 `/wb-expert-finder`，所以禁用并说明原因。
        var finderMissing = !!(cache.finder && cache.finder.installed === false)
        var autoRow = H(
          'button',
          {
            type: 'button',
            key: '__auto__',
            className: 'dsh-wbx-auto' + (finderMissing ? ' dsh-wbx-auto-off' : ''),
            disabled: finderMissing ? true : undefined,
            title: finderMissing
              ? 'Auto Mode 不可用：Host 未能写入 ' + (cache.finder.path || 'wb-expert-finder') + '（看 ~/.dsh/wb-experts/_host-boot.log）'
              : '把 /' + AUTO_SKILL + ' 写进输入框 —— 之后你直接描述任务，由 agent 自己挑专家',
            onMouseDown: function (ev) {
              ev.preventDefault()
              if (finderMissing) return
              if (insertSlash(AUTO_SKILL)) setOpen(false)
            },
          },
          H('span', { className: 'dsh-wbx-auto-t' }, '不确定用哪个？'),
          H(
            'span',
            { className: 'dsh-wbx-auto-d' },
            finderMissing ? 'Auto Mode 未就绪（' + AUTO_SKILL + ' 未安装）' : '直接把任务写出来，我自己挑专家',
          ),
        )
        var list = [autoRow]
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i]
          var isStaged = !!stagedMap[row.dsh_name]
          var cnt = usage[row.dsh_name] || 0
          list.push(
            H(
              'button',
              {
                type: 'button',
                key: row.dsh_name,
                'data-idx': i,
                'data-active': i === active ? 'true' : 'false',
                className: 'dsh-wbx-row',
                onMouseEnter: function (idx) {
                  return function () {
                    setActive(idx)
                  }
                }(i),
                onMouseDown: function (r) {
                  return function (ev) {
                    ev.preventDefault()
                    pick(r)
                  }
                }(row),
              },
              H(
                'span',
                { className: 'dsh-wbx-l1' },
                H('span', { className: 'dsh-wbx-name' }, row.dsh_name),
                cnt > 0
                  ? H('span', { className: 'dsh-wbx-star', title: '用过 ' + cnt + ' 次' }, '\u2605' + cnt)
                  : null,
                isStaged
                  ? H(
                      'span',
                      {
                        className:
                          'dsh-wbx-unstage' +
                          (shownCat === STAGED_CAT ? ' dsh-wbx-unstage-always' : ''),
                        title: '取消上岗（只删链接，专家库本体与用户自己的 skill 都不动）',
                        onMouseDown: function (r) {
                          return function (ev) {
                            // 别让事件冒到整行：点这里是「取消上岗」，不是「选用」
                            ev.preventDefault()
                            ev.stopPropagation()
                            unstageOne(r)
                          }
                        }(row),
                      },
                      '取消上岗',
                    )
                  : null,
              ),
              H(
                'span',
                { className: 'dsh-wbx-l2' },
                row.zh ? H('span', { className: 'dsh-wbx-zh' }, row.zh) : null,
                row.profession && row.profession !== row.zh
                  ? H('span', { className: 'dsh-wbx-desc' }, row.profession)
                  : null,
              ),
            ),
          )
        }

        // 左侧分类栏：全部 + 15 个分类（各带数量）。分类按钮不参与键盘 ↑↓ 导航，
        // 只用鼠标点，免得和列表抢焦点。
        var catBar = [
          H(
            'button',
            {
              type: 'button',
              key: '__all__',
              className: 'dsh-wbx-cat',
              'data-active': shownCat === '' ? 'true' : 'false',
              onClick: function () {
                setCat('')
                setActive(0)
              },
            },
            H('span', null, '全部'),
            H('span', { className: 'dsh-wbx-cat-n' }, String(experts.length)),
          ),
        ]
        // 「已上岗」紧跟「全部」：它是范围而不是分类，放最上面最顺手。
        if (staged.length > 0) {
          catBar.push(
            H(
              'button',
              {
                type: 'button',
                key: '__staged__',
                className: 'dsh-wbx-cat',
                'data-active': shownCat === STAGED_CAT ? 'true' : 'false',
                onClick: function () {
                  setCat(STAGED_CAT)
                  setActive(0)
                },
              },
              H('span', null, '已上岗'),
              H('span', { className: 'dsh-wbx-cat-n' }, String(staged.length)),
            ),
          )
        }
        for (var ci = 0; ci < cats.names.length; ci++) {
          var cname = cats.names[ci]
          catBar.push(
            H(
              'button',
              {
                type: 'button',
                key: cname,
                className: 'dsh-wbx-cat',
                'data-active': shownCat === cname ? 'true' : 'false',
                onClick: function (name) {
                  return function () {
                    setCat(name)
                    setActive(0)
                  }
                }(cname),
              },
              H('span', null, cname),
              H('span', { className: 'dsh-wbx-cat-n' }, String(cats.count[cname])),
            ),
          )
        }

        // 三种情况必须分开：Host 没数据 / 筛选没命中 / 正常有结果。
        // 注意 list 里始终含 autoRow，所以判断要看 rows.length，**不能**看 list.length。
        var rightPane
        if (experts.length === 0) {
          rightPane = H(
            'div',
            { className: 'dsh-wbx-empty' },
            H(
              'span',
              null,
              loading ? '正在读取专家库…' : '未读到专家库。',
              H('br', null),
              diag ? H('span', { className: 'dsh-wbx-err' }, diag) : 'Host 半侧没有返回数据。',
              H('br', null),
              H('code', null, cache.lib || '~/.dsh/wb-experts'),
            ),
          )
        } else if (rows.length > 0) {
          rightPane = H('div', { className: 'dsh-wbx-list', ref: listRef }, list)
        } else {
          // 有专家、但当前筛选没命中：给提示，同时把 auto 入口留着（这种时候它最有用）
          rightPane = H('div', { className: 'dsh-wbx-list' }, [
            autoRow,
            H(
              'div',
              { className: 'dsh-wbx-empty' },
              shownCat === STAGED_CAT
                ? '已上岗的专家都不在库里（可能库被换过）'
                : '没有匹配「' + query + '」的专家',
            ),
          ])
        }

        var body = H(
          'div',
          { className: 'dsh-wbx-body' },
          H('div', { className: 'dsh-wbx-cats' }, catBar),
          rightPane,
        )

        children.push(
          H(
            'div',
            { className: 'dsh-wbx-panel', onKeyDown: onKeyDown },
            H(
              'div',
              { className: 'dsh-wbx-search' },
              H('input', {
                ref: inputRef,
                value: query,
                placeholder: '搜索专家：名称 / 中文名 / 职业 / 描述…',
                onChange: function (ev) {
                  setQuery(ev.target.value)
                  setActive(0)
                },
                onKeyDown: onKeyDown,
              }),
              H(
                'span',
                {
                  className: 'dsh-wbx-count',
                  title: '渲染行数 / 命中数 / 专家库总数',
                },
                rows.length < matched.length
                  ? '显示 ' + rows.length + ' / 命中 ' + matched.length
                  : query
                    ? '命中 ' + matched.length + ' / 共 ' + experts.length
                    : '共 ' + experts.length + ' 位',
              ),
            ),
            body,
            H(
              'div',
              { className: 'dsh-wbx-foot' },
              busy
                ? H('span', null, '上岗中…')
                : diag
                  ? H('span', { className: 'dsh-wbx-err' }, diag)
                  : H('span', null, '选中即写入 /skill'),
              H(
                'span',
                { className: 'dsh-wbx-legend', title: '★n = 这位专家被用过 n 次（用过越多次排得越前）。把鼠标移到某一行，右侧会浮现「取消上岗」' },
                H('span', { className: 'dsh-wbx-star' }, '\u2605n'),
                '用过次数',
              ),
              H('span', null, H('kbd', null, '↑↓'), ' ', H('kbd', null, 'Enter'), ' ', H('kbd', null, 'Esc')),
            ),
          ),
        )
      }

      return H('div', { className: 'dsh-wbx-wrap', ref: wrapRef }, children)
    }

    // ---- 插件体 -------------------------------------------------------------

    /** 依赖的服务：插槽注册表。 */
    var inject = ['slots']

    function apply(ctx) {
      // 样式：直接插 <style>，模块系统按 data-plugin-css 认领并在 HMR 时回收。
      try {
        var style = document.createElement('style')
        style.setAttribute('data-plugin-css', NS)
        style.textContent = CSS
        document.head.appendChild(style)
      } catch (e) {
        /* 样式失败不阻塞功能 */
      }

      // 挂到输入框工具行左侧（list 插槽，追加位，replaceRisk: none）。
      ctx.slots.inject('conversation.input.left', function () {
        return ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'wb-experts',
            order: 100,
            label: '专家',
          },
          function PickerHost(props) {
            return H(WbExpertsPicker, Object.assign({}, props, { __ctx: ctx }))
          },
        )
      })
    }

    exports.apply = apply
    // 只给离线测试用的内部函数出口（dsh 运行时只读 apply / inject，多挂几个键无副作用）。
    // 有了它，tests/client-logic-test.mjs 才能拿真实的 _index.json 跑真实代码，而不是跑一份副本。
    exports.__test = { filterExperts: filterExperts, sortExperts: sortExperts, buildCats: buildCats }
    exports.inject = inject
    return module.exports
      },
    })
  } catch (err) {
    // 铁律（抄 dsh-path-paste）：客户端 bundle 必须包在「永不抛」的 IIFE 里。
    // 裸的 __ModuleLoader__.load(...) 一旦抛错会污染全局、拖垮整个前端 boot，
    // 而症状只表现为「插件没反应」，极难定位。
    console.warn('[dsh-wb-experts] bundle 装载失败:', err)
  }
})()
