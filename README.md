# dsh-provider-toggle

给 DSH「设置 → 模型」的每一行加一个**一键开关**（就在「编辑」左边）：
关掉哪个提供商，它就从主界面「选择模型」栏里消失；再打开就回来。

```
设置 → 模型
┌──────────────────────────────────────────────┐
│ opencode-go                       ●   ( ) 编辑 删除 │  ← 开关在「编辑」左边
│                                           ↑          │
└──────────────────────────────────────────────┘
```

## 装 / 卸

```bash
node F:/DSH/plugins/dsh-provider-toggle/install.mjs          # 安装或修复
node F:/DSH/plugins/dsh-provider-toggle/install.mjs --dry     # 只看会改什么
node F:/DSH/plugins/dsh-provider-toggle/install.mjs --uninstall
```

`install.mjs` 只做三件事（不跑 pnpm，不会重建 node_modules、不会打断会话）：
建目录联接、往 profile 的 `package.json` 里加 `link:` 依赖、把包名追加到
`dsh.profile.bundles` 末尾。**装完必须完全退出 DSH（含托盘）再启动** —— bundle
清单和浏览器模块表都是启动期读的，HMR 不会热加载新包。

## 怎么实现的

只有一个关键点：**DSH 的模型选择器只显示"模型数 > 0"的提供商分组**。

`@deepseek-ai/dsh-api-session-controller` 的 `buildModelCatalog()` 里有一句

```js
groups.filter(group => group.models.length > 0)
```

所以本插件用最轻的方式接上去 —— 包一层 `ctx.llm.listModels()`：

| 半端 | 文件 | 做什么 |
|---|---|---|
| host | `index.js` | 被关掉的 provider route，`listModels()` 返回 `[]` → 该分组被丢弃 → 选择器里消失 |
| client | `client.js` | 在 `settings.models.provider-card`（keyed slot）里渲染 `@deepseek-ai/dsh-client-ui-primitives` 的 `<Switch>`，读写走现成的 `ctx.remote.settings` |

**只影响目录/选择器，不影响路由。** `dsh-llm` 源码写得很清楚：
*"Core routing accepts unlisted model ids; catalog-driven entry points such as the GUI may require membership."*
也就是说，已经选着这个模型的旧会话不会被弄坏，只是选择器里不再提供它。

### 状态存在哪

存在插件自己的 settings 命名空间里（`Config.disabled`，`.volatile()`）：

- 走 DSH 原生 settings 服务 → 持久化进 **profile 的 `cordis.patch.yml`**
  （`id: dsh-provider-toggle` 那条）；
- 浏览器半端直接用 `ctx.remote.settings.describe() / mutate()`，不需要自造远程接口；
- 在设置界面改任何 provider 时，DSH 会整份重写 `cordis.patch.yml` —— 但那是按
  内存状态重写的，我们的值本来就在内存里，所以**不会被冲掉**；
- `.volatile()` 让改动**热生效**：写入后 loader 发 `loader/volatile-update`，
  本插件随即广播 `llm/adapters-updated`，浏览器当场重载模型目录。**开关不需要重启 DSH。**

### 为什么所有 provider 只注册了一条

`settings.models.provider-card` 是 **keyed** slot，渲染时用
`renderSlot(name, props, { entryKey: row.entry.settingsNs })` 匹配注册项的 `key`。
而 pi-ai 的所有路由（DeepSeek / openai / opencode-go / 自定义中转…）**共用同一个
settingsNs**（逐 provider 的区别在 `settingsPath: ["providers", <route>]`）。
所以**一条 key 的注册会在每一行各渲染一次**，props 里带着当行的 `provider`。
`deepseek-account` 之类的独立命名空间会另注册一条。

### 位置是怎么定的

slot 的内容默认渲染在 rowHead **下面**（同一张卡片里）。为了放到「编辑」左边，
组件挂载后测量 `li` / `[class*="rowHead"]` / `[class*="rowActions"]` 的
`getBoundingClientRect()`，把自己绝对定位过去（类名是 CSS Module 哈希，
所以用 `[class*=...]` 子串选择器）。**量不到就退回行内布局，功能不受影响。**

## 验证

不启动 DSH 的三个离线验证台（都各自独立实现一遍口径，再逐项比对）：

```bash
node F:/DSH/plugins/dsh-provider-toggle/test-filter.mjs            # host 逻辑：16 项
node F:/DSH/plugins/dsh-provider-toggle/test-client.mjs            # client 逻辑：13 项
node F:/DSH/plugins/dsh-provider-toggle/preview/placement-check.mjs  # 版式几何 + 截图
```

- `test-filter.mjs` 复刻了 `buildModelCatalog()` 的分组过滤，验证「关掉 → 消失 /
  打开 → 回来 / 卸载 → 还原 / 重复 apply 不叠加 / config 不是 ref 时的兜底路径」。
- `test-client.mjs` 用最小化的假 React 验证插槽注册形状、`Switch` 状态与 `mutate` 入参。
- `preview/placement-check.mjs` 会从**真实 DSH 安装**里抽出设置页 CSS 与主界面开关 CSS，
  再抽出 client.js 里**真的 `placeSwitch()`**，搭一份 DOM 复刻，用本机 Edge + CDP
  量几何并截图（产物 `preview/placement.html` / `placement.png` / `placement-zoom.png`）。
  判据：开关右边缘距「编辑」6~11px、垂直中心差 <3px、不越出卡片、不与按钮组重叠。

装好之后还可以用 DSH 自己的插件体检跑一遍导入冒烟：

```bash
python C:/Users/Quan/.dsh/dsh-plugin-check.py
```

## 已知边界

- **不给 `deepseek-account`（DeepSeek 账号）开关**。`@deepseek-ai/dsh-client-ui-settings-models`
  在装行列表时会查一次 `remote.session.modelCatalog()`，并且有一句
  `rows.filter(row => row.entry.provider !== "deepseek-account" || row.accountAvailable === true)`
  —— 也就是说这个 provider 一旦被从模型目录摘掉，**它自己那一行也会消失**，
  界面里就再没有把它开回来的入口了（只能手改 profile 的 `cordis.patch.yml`）。
- **别关掉你正在用的默认模型所在的那个 provider**：模型选择器里它会变成"不可用"，
  请求本身还是通的，但你会先切到别的模型去。改错的救法：设置 → 模型 → 打开开关，
  或编辑 profile 的 `cordis.patch.yml` 把 `id: dsh-provider-toggle` 那条
  `config.disabled` 清空。
- 这个开关只改"选择器里出现什么"，不改任何 provider 的配置、密钥和模型目录 ——
  所以它和「编辑 / 删除」是完全正交的两件事，随时可逆。
- 位置靠测量，所以 DSH 哪天把设置页的行结构改掉（类名里的 `rowHead` / `rowActions`
  没了），开关会退回"行内显示"——功能照常，只是位置不再是「编辑」左边。
- 第三方客户端（如市场里的独立面板）如果自己拉一份模型目录，不受本插件影响。
