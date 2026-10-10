---
name: wb-expert-finder
description: Find and load the right WorkBuddy domain expert on demand. Use when a task needs specialist expertise (A-share/finance analysis, legal review, HR, security audit, penetration testing, game dev, marketing, data, Tencent Cloud, etc.) and the best-fitting expert is unclear, or when the user asks to find, pick, or auto-select an expert. Searches the local expert library across 15 categories and stages the match as a loadable skill.
metadata:
  managedBy: dsh-wb-experts
  managedVersion: __VERSION__
---

# WorkBuddy 专家寻址（Auto Mode）

本机有一整套 **WorkBuddy 专家**（约 448 位）已转成 dsh skill，但**故意没有全挂扫描根**
（全量描述约 27K token／会话，挂全会把上下文吃掉）。它们躺在库里**按需上岗**。

**不要**让用户自己挑。判断任务需要什么专业能力，然后按下面三步把最合适的那位请上来。

> 本文件由 `dsh-wb-experts` 插件在启动时自动安装/更新（`metadata.managedBy`）。
> 手工改动会在插件升级时被覆盖；要长期自定义，请去掉 `metadata` 里的 `managedBy`。

## 什么时候用

- 任务明显落在某个专业领域（A股/基金分析、合同与法务、招聘与绩效、安全审计、渗透测试、
  小红书/抖音/视频号运营、Unity/Unreal 开发、生物信息、留学与高考规划…），
  而你不确定该请哪位专家
- 用户说「找个专家」「用 XX 专家」「你帮我选」「自动选一个」时
- 你已经知道要做什么，但希望由专家的人设与标准流程来接管这一步时

## 三步走

### 1. 搜

```powershell
node "__CLI__" find "<关键词>"
```

命中项会打印 `dsh_name`、中文名、职业定位、子技能数、分类、类型（agent/team）。

**关键词支持多词 OR 匹配，用空格分隔** —— 这一点很重要：

```powershell
node "__CLI__" find "渗透 安全 pentest"
node "__CLI__" find "小红书 种草 xiaohongshu"
node "__CLI__" find "合同 法务 contract"
```

库里存的是专家的**自称**（「安全工程师」），而你想的是**任务词**（「渗透测试」），
单词搜会漏。**一次给 2-4 个同义词/近义词/英文词**，命中率高得多。
搜索语料是每位专家 `SKILL.md` 的**整份全文**（不是只有 description），所以正文里的
自述也能命中。

搜不到就换词再试，或先看全量：

```powershell
node "__CLI__" list
```

也可以直接读索引（要精确筛选时更快）：

```
<dsh home>/wb-experts/_index.json
```

字段：`dsh_name` / `zh` / `en` / `profession` / `category`（如 `08-FinanceInvestment`）/
`category_zh`（如 金融投资）/ `expertType`（agent / team）/ `subskills`。
`node "__CLI__" path` 会打印当前解析出的 dsh home 与库路径。

### 2. 上岗（建链接，热加载，**不需要重启 dsh**）

```powershell
node "__CLI__" use <name>
```

幂等，重复 `use` 不会出错。**下一个模型步骤**它就出现在会话的 skill 目录里。

### 3. 加载

用 `skill` 工具加载 `<name>` —— 之后该专家的人设与工作流就在这一步生效。

用完可以摘掉（不摘会一直占上下文）：

```powershell
node "__CLI__" off <name>
```

`node "__CLI__" on` 列出当前上岗的。

## 库的构成

15 个分类，数量随版本变化；用 `node "__CLI__" list` 看当前实际规模。

`expertType=team` 的是**团队型**（带 `subskills`，会调度多个子技能），
适合端到端的大任务；`agent` 的是单点专家，适合明确的一步。

## 注意

- **别一次挂太多**：每位上岗的专家都进会话 skill 目录、占 token。按需挂、用完摘。
- 想看某位专家的正文到底怎么写流程，用 `node "__CLI__" show <name>` 或直接读
  `<dsh home>/wb-experts/<name>/SKILL.md`。
- 上岗目录里还混着用户自己的 skill 和本插件建的链接；`off` 只删本库建的链接，
  不会动用户自己的 skill。
- 体检：`node "__CLI__" doctor`（库/索引/搜索索引/扫描根是否齐备）。
