# Wallnut 0.6.0 优化修改清单

副本：`D:\桌面\Wallnut-0.6.0`（原件 `D:\桌面\Wallnut-0.5.1` 未改动）
验证：`node --check` 全部通过；三轮离屏冒烟（`WALLNUT_SMOKE=1`）10 页 `errs:[]` 全空；CDP 实测 200 次 tick → 1 次重渲染。

## 渲染进程

| # | 文件 | 位置 | 修改 | 理由 |
|---|------|------|------|------|
| 1 | renderer/app.js | ~:100 | 日志 WS 消息入 200ms 缓冲（`uiLogBuf`/`scheduleUiLogFlush`），合并后一次更新 `S.uiLogs`；`closeStreams()` 清理 | 原来每行日志立即重渲染整棵树，繁忙时每秒上百次 |
| 2 | renderer/app.js | ~:371 | `window.__wallnutTick` 节流 100ms（10fps），pending 合并；卸载时清理 timer | 原来每条事件一次全树渲染；实测 200 次 tick → 1 次 |
| 3 | renderer/app.js | ~:397 | 连接轮询 200ms → 1000ms（5s 全量保留） | 5 次/秒的 /connections 全量传输+解析+全局 emit |
| 4 | renderer/store.js | ~:190 | `log` 事件缓冲 200ms（满 400 条立即刷）合并成一次 `set`；条目分配 `_k` | 每条内核日志一次全局 set → 所有组件重渲染 |
| 5 | renderer/store.js | `delayMap()` | 按 `S.test`/`S.runtime.proxies` 引用缓存结果 | 每次调用全量遍历全部节点+历史 |
| 6 | renderer/ui.js | :6-13 | zh-CN 下 `html` 跳过 `localizeVNode` 全树克隆 | 中文是源语言，tr() 原样返回，克隆纯浪费；切语言仍走翻译 |
| 7 | renderer/pages/logs.js | :25-43 | `parseLine` 结果缓存到条目 `_p`；key 由 `t+'-'+i` 改 `c/a+_k` | 不再每次渲染重跑正则；新日志插入不再整列表重挂载 |
| 8 | renderer/pages/activity.js | :18-45 | `rateOf()` 按数据引用缓存（`conns === _lastConns` 直接返回） | 原在渲染期改模块级状态：非数据重渲染会把速率清 0、下次差值放大成尖峰 |
| 9 | renderer/pages/home.js | useClock | 三个 rAF 时钟（约 90 setState/秒）合并为一个 10fps 共享时钟 | 每图表独立 30fps 循环纯属浪费 |
| 10 | renderer/pages/home.js | ~:200 | Spark 数据先过滤最近 60s | 采样改 1s 后 300 条=5 分钟，旧点全被 clamp 到左端堆积 |

## 主进程

| # | 文件 | 位置 | 修改 | 理由 |
|---|------|------|------|------|
| 11 | electron/core/manager.js | pushLog ~:74 | 每行 `appendFileSync` → 内存缓冲，64KB/250ms 合并一次异步 `appendFile`；新增 `flushLogFile()` | 每行一次同步 open+write+close 阻塞主进程事件循环 |
| 12 | electron/core/manager.js | exit/stop | 内核退出与 stop() 时同步刷写缓冲 | 退出原因行必须落盘 |
| 13 | electron/config/generate.js | buildConfig | 新增 `ports` 覆盖参数（mixed-port / external-controller） | 见 #14 |
| 14 | electron/core/manager.js | start() | `buildConfig(state, this.currentPorts)` | **实测到的 bug**：端口顺延只写 currentPorts，配置仍写原端口 → mihomo 绑定失败（日志：改用 7891 但仍绑 7890），系统代理却指向新端口 |
| 15 | electron/main.js | ~:260 | bounds 写盘：500ms 防抖 + `fs.promises` 异步；close 时同步兜底 | resize/move 每帧触发，原来每帧同步写盘卡主进程（拖动掉帧） |
| 16 | electron/main.js | ~:432 | `nodeList(state)` 只计算一次 | 原来同一次广播算两遍（遍历全部节点+地区识别） |
| 17 | electron/core/speedtest.js | run() | `try/finally` 复位 `running`；`onProgress` 包 try/catch | 进度回调抛错会让测速永久锁死「已有任务进行中」 |
| 18 | electron/store.js | emit() | 静默 `catch(_){}` → `console.error` 带栈 | 广播异常被吞后界面停更且无线索 |
| 19 | electron/tray.js | currentProxy | 先 `GET /proxies/{主策略组}`，失败才回退全量 | 4s 轮询没必要拉全部节点+测速历史 |
| 20 | electron/tray.js | build() | 菜单签名比对（running/now/mode/自启动/状态），未变不重建；init() 重置签名 | 每 4s 无条件重建，Windows 上会收起正在展开的菜单 |
| 21 | electron/tray.js | toggleAutostart | `if (r.ok)` 才写 settings，失败 notify | 注册表失败仍标记已开启 → 界面与实际状态打架 |

## 已核实、建议后续处理（未改）

- `rewrite/engine.js:397`：response-body 用 `gunzipSync/brotliDecompressSync`（最多 8MB），应改流式/异步或挪 worker——改动面大，需单独验证 MITM 场景。
- `store.js:171`：每次 update 对整棵 state 做 JSON 深拷贝（数千节点），应分片克隆。
- `ipc.js` 38 处 `broadcastState()` 与 `main.js:432` onChange 双重广播同一份全量 state，应统一为一处。
- `regions.js:95`：detectRegion 每节点×地区重编译正则，应预编译缓存。
- `ipc.js:561`：region:save 缺形状校验，坏 keywords 会污染持久化状态。
- `autostart.js:71`：`execFileSync` 拉 reg.exe，应改 async。
- `rewrite/ca.js:35`：hostCache/hostPromises 无上限增长，应加 LRU/finally 删除。
- `ipc.js:1009`：ctl:rest 只白名单路径不校验 method，可加 method+路径白名单（加固项）。

---

## 第三轮：切换节点不断流

断流根因：切换节点本应是热操作（`PUT /proxies/{group}`，mihomo 不会断开已有连接），但两处代码在切换链路上触发了 `core.apply()` → `PUT /configs?force=true` 全量重载配置，**所有现存连接被清零**（正在下载/视频/SSH 立刻断）；groups 页在 auto 分支里还连续重载了两次。

| # | 文件 | 位置 | 修改 | 理由 |
|---|------|------|------|------|
| 22 | electron/core/manager.js | 新增 `select()` | 热切换专用方法：只 `PUT /proxies/{group}`，**永不重载配置**；连点按 latest-wins 排队；超时 8s + 重试 1 次 | 用户连点多个节点时请求会乱序，最终停在中间某次；批量测速时控制器偶发超时会误报失败 |
| 23 | electron/core/api.js | `select()` | 支持 timeout 参数（默认 6000，切换时用 8000） | 高并发下 6s 容易超时 |
| 24 | electron/ipc.js | 新增 `proxy:select` | 统一热切换入口：校验运行状态与参数、串行化切换、同步 `region.selected` 元数据（否则下次 apply 会跳回旧节点） | 原来没有单一入口，各页面各写一套，行为不一致 |
| 25 | electron/ipc.js | `region:save` | **只在组结构变化时 apply**（mode/name/enabled/nodes/keywords 变了才重载；仅 selected/best/order 变化不重载），并校验参数 | 原来任何一次保存都全量重载 → 断流 |
| 26 | electron/ipc.js | `region:applyFastest` | 改走 `core.select()`（带重试/串行），不再直接 `api.select` | 与统一入口行为一致 |
| 27 | electron/preload.js | CHANNELS | 新增 `proxy:select` | 通道白名单放行 |
| 28 | renderer/store.js | 新增 `switchNode()` | 热切换 + 成功后就地更新 `now` 并立即重绘 + toast | 原来要等 1 秒轮询，点了像没反应；失败信息也被静默 |
| 29 | renderer/pages/groups.js | 成员点击 | auto 分支改调 `region:applyFastest`（只重载一次），删掉多余的 `core:apply`；手动组走 `switchNode` 热切换 | 原来 auto 分支连续重载两遍，双重断流 |
| 30 | renderer/pages/nodes.js | 节点行 | **新增点击节点直接切换**到主策略（热切换，不断流），行内视觉区分当前节点 | 原来节点页只能测速，不能切节点 |

### 实测证据（CDP 驱动真实内核）

- `core:start` → 成功（端口占用自动顺延已修复，实际绑定可用端口）
- 连续切换 `主策略: 香港 → 台湾`：两次均 `ok`，最终 `now = 台湾`
- **`core.log` 中「配置已热加载」次数 0 → 0**，即切换全程未重载配置 → 已有连接不受影响
- `region:save` 只改 `selected` → 返回 `applied: false`，重载次数不变
- 冒烟测试 nodes/groups/home/logs/activity 五页 `errs: []`

### 还剩一处无法避免的重载

地区组从「自动（url-test）」改成「手动（select）」时，组类型本身变了，mihomo 没有运行时改组类型的 API，必须重建配置——这一次重载会断流。优化后只重载**一次**（原来两次），且只在这个模式下发生；在手动组内换节点、在节点页点节点、切主策略，全部为零重载。

---

## 第四轮：节点过慢自动切换（应用层巡检）

先说清原有机制的问题：应用层**没有任何**自动切换代码（`grep -rn "watchdog|autoSwitch|failover|switchTo"` 零命中），全靠 mihomo 自带的 `url-test` 组。而 `config/generate.js` 给这些组设的是 `interval: 300`、`tolerance: 50`、`lazy: true`：

- 节点变慢后，最多要等 **5 分钟**才会被换掉；
- `lazy: true` 意味着组没被使用时**根本不测速**，坏节点可能长时间不被发现；
- `tolerance: 50` 还要求新节点至少快 50ms 才会替换；
- 最关键的：主策略组是 `select`，它**不参与**任何自动选择。

所以要满足「节点过慢就换一个」，必须在应用层主动巡检。

| # | 文件 | 位置 | 修改 | 理由 |
|---|------|------|------|------|
| 31 | electron/core/auto-switch.js | **新增文件** | 巡检器 `AutoSwitcher`：每 `intervalSec` 秒沿「主策略 → 地区组 → 节点」链解析出**当前真正生效的节点**并测一次延迟；连续 2 次超阈值或不通才动手（过滤抖动）；切换走 `manager.select()` 热切换，**永不重载配置** | 这是「过慢即换」的核心；两次采样才决策，避免一次网络抖动就换节点 |
| 32 | electron/core/auto-switch.js | `pickBest()` | 候选从**最贴近节点的那一层**往上找：先在同一地区组内换节点（用户留在原地区），组内没有明显更快的才退到主策略换地区；要求候选「绝对够快」且「比当前快 25% 以上」 | 只看绝对延迟会在两条慢线之间来回跳；先组内后跨地区符合用户直觉 |
| 33 | electron/core/auto-switch.js | `retestGroup()` | 对自动模式组（url-test/fallback/load-balance）先让内核自己重测一遍（`GET /group/{name}/delay`），若内核自愈换好了就不动主策略 | 自动组不能手动指定节点；强行跨地区切换会违背用户选的地区，能让内核自愈就自愈 |
| 34 | electron/core/manager.js | require / 构造函数 | 引入巡检器；新增 `_userSelectAt`（用户最近一次手动切换的时间） | 巡检器需要与内核生命周期绑定，且要让位给用户操作 |
| 35 | electron/core/manager.js | `select()` | 新增 `auto` 参数：手动切换记录时间戳，自动切换不记录 | 用户手动切完 45 秒内巡检器不插手，避免「刚选好就被换走」 |
| 36 | electron/core/manager.js | `start()` / `exit` / `stop()` / `snapshot()` | 内核启动成功后启动巡检；退出/停止时停掉；`snapshot()` 附带 `autoSwitch` 状态（当前节点、延迟、连续失败数、上次切换时间） | 否则内核没跑时巡检会一直报错；界面也需要展示巡检结果 |
| 37 | electron/ipc.js | `send` 附近 | 转发 `autoswitch`（界面 toast）与 `autoswitch-state`（每轮采样同步到设置页「最近一次检查」） | 原来 `ipc.js` 完全没有 `core.on(...)` 监听，事件出不来 |
| 38 | electron/ipc.js | `app:settings:save` | 保存设置后调用 `autoSwitcher.reconfigure()` | 改开关/间隔/阈值要立即生效，不用重启 |
| 39 | electron/preload.js | `EVENTS` 白名单 | 新增 `auto:switch` | 事件白名单是独立于 CHANNELS 的另一张表，漏加会让渲染层报「未授权的事件」 |
| 40 | electron/store.js | `settings` 默认值 | 新增 `autoSwitch: { enabled: true, intervalSec: 30, slowMs: 1200, cooldownSec: 120, maxPer10Min: 6 }` | 新增设置项必须同时给默认值，`mergeDeep` 才能为老配置补全 |
| 41 | renderer/store.js | 事件订阅 | 订阅 `auto:switch` → toast「节点过慢，已自动切换：X（2000ms）→ Y（155ms）」 | 自动换了节点必须让用户知道，否则会以为网络自己好了 |
| 42 | renderer/pages/settings.js | 新增「节点自动切换」卡片 | 开关 + 检查间隔（10–600s）+ 慢节点阈值（200–20000ms）+ 切换冷却 + 「最近一次检查」实时显示 | 阈值因地区/宽带差异很大，必须可调 |

### 实测证据（真实内核 + 真实订阅）

**单元验证（假控制器，11 个场景全过）**

- 同组有更快的 → 留在原地区组内换节点（`日本→JP-3`）
- 同组都慢 → 退回主策略换地区（`主策略→台湾`）
- 当前节点不通（测速抛错）→ 触发切换
- 候选只快 20%（2000ms vs 1600ms）→ **不动**（不折腾）
- 当前节点正常 → 完全不动
- 功能关闭 → 不动
- 用户刚手动切换 5 秒前 → 巡检避让（0 次切换）
- 冷却期内 → 不重复切换
- 自动组（url-test）重测后内核自愈 → 不跨地区切换
- 自动组治不好 → 退回主策略换地区
- 手动组不触发重测请求

**真实内核端到端（CDP 驱动）**

- 组类型实测：`日本` / `新加坡` / `韩国 2` 是 `URLTest`，`主策略` / `香港` / `台湾` / `美国` 是 `Selector`（自动组自愈与手动组内换这两条路径在真实配置里都成立）
- 在「香港」组内**手动选中一个不通的节点**（该组 25 个节点，实测 14 个不通），主策略指向「香港」后，巡检在约 20 秒内输出：`自动切换：「香港原生IP-2|勿跑大流量」不通 →「Hongkong 8anytls| aws-hytron」（155ms），热切换未重载配置`
- 切换后：香港组当前节点为健康节点，**主策略仍是「香港」**（地区未变），`core.log` 中「配置已热加载」次数 **0 → 0**（零重载、零断流）
- 低阈值场景（slowMs=50）：巡检判定「当前节点 56ms 已过慢，但候选没有明显更快的」→ **正确地不动**
- 冒烟：settings / nodes / groups / home / logs 五页 `errs: []`；设置卡片 DOM 实测 3 个输入框右缘 1191–1196、卡片右缘 1228（无溢出）

### 默认行为与可调项

| 参数 | 默认 | 含义 |
|------|------|------|
| `enabled` | `true` | 总开关 |
| `intervalSec` | `30` | 每 30 秒检查一次当前节点 |
| `slowMs` | `1200` | 超过 1200ms 视为过慢（不通也算） |
| `cooldownSec` | `120` | 两次自动切换的最短间隔，防止来回跳 |
| `maxPer10Min` | `6` | 10 分钟内最多切 6 次，超了就停手并在日志提示（防止订阅整体劣化时无限切换） |

响应时间：最坏 `intervalSec × 2`（两次采样）≈ 60 秒发现并换掉一个坏/慢节点；用户手动切换后 45 秒内巡检不插手。

### 已知边界（有意为之）

- 只监控「主策略」这一条链（`settings.defaultTarget`）。某条策略单独指向别的组时不介入——范围可控，不动用户没在用的组。
- 自动模式组（url-test）**不能**手动指定组内节点，只能触发内核重测；若整组都慢，会退回主策略换地区（日志会写明原因）。
- 巡检测速本身每 30 秒走一次 `generate_204`（约 1KB 流量）；不需要时可关总开关。
- 阈值 1200ms 是通用值：移动网络/国际线路建议调到 2000–3000ms，否则会把「能用但不算快」的节点也换掉。
## 第五轮：节点剩余流量查询（2026-11-27）

> 协议事实：机场按**订阅**计量，不存在「节点级剩余流量」。界面上「节点剩余流量」= 该节点所属订阅的剩余额度；节点级额外信息只有「距下次重置天数 / 套餐到期」。机场还常把账户信息伪装成节点塞进订阅（伪节点），旧版把它们当真节点导入内核并参与测速。

| # | 文件 | 位置 | 修改 | 理由 |
|---|------|------|------|------|
| 43 | electron/subs/usage.js | :72-189 | 新增 `parseInfoNodes()`：按名称特征 + 回环地址识别「剩余流量 / 距离下次重置 / 套餐到期 / 永久网址 / 去官网更新软件」等信息节点，抽成 `remain/resetDays/expireAt/expireText/site` 并返回**剔除后**的可用节点 | 这些伪节点原来直接进 `config.proxies`，会出现在节点列表里、参与测速、甚至被选中；同时里面写着用户要看的剩余流量 |
| 44 | electron/subs/usage.js | :191-230,248 | 新增 `mergeUsage()`：响应头（按实际流量算）为主，信息节点只补周期信息；口径相差 >2% 时保留 `nodeRemain` 供核对；`describe()` 加「N 天后重置」 | 两种来源都可信但口径不同；全部以信息节点为准会把机场标称值和实际用量搞混 |
| 45 | electron/ipc.js | :300-333 | `applySub` 先 `parseInfoNodes`，只把真节点写入 `nodes/nodeCount`；`infoNodes` 记录被忽略的伪节点；`traffic = mergeUsage(响应头, 信息节点)` | 更新订阅时就完成分流与取数，无需额外请求，也不再让伪节点进内核 |
| 46 | electron/ipc.js | :408-430 | `sub:usage` 无 `subscription-userinfo` 头时，回退展示上次从信息节点读到的用量并注明来源；查询成功时用 `supplement` 保住 `resetDays/expireText`，不带数值避免口径打架 | 原来只要没响应头就报「无法查询」，把信息节点里明明有的数字浪费掉 |
| 47 | electron/ipc.js | :358-370 | 粘贴文本导入（`sub:importText`）同样剔除信息节点并存入 `traffic` | 与 URL 订阅行为保持一致 |
| 48 | electron/store.js | :9,133-141 | `migrate()` 加载时对历史 state 做一次清理：剔除伪节点、修正 `nodeCount`、把用量并入 `traffic`；幂等 | 已有用户的 state.json 里存着旧伪节点，不清一次重启后还会回来 |
| 49 | renderer/ui.js | :69-101 | `UsageBar` 支持 remain-only（无总额度不画进度条）、「N 天后重置」徽标、数据来源说明 | 信息节点只给剩余额度，没有 upload/download/total，原组件会画出 0% 的误导性进度条 |
| 50 | renderer/pages/nodes.js | :35-62,115-120,149,189 | 节点页按 `sourceId` 关联订阅：分组头显示「剩余 X GB · N 天后重置」、当前节点显示所属订阅剩余、工具栏新增「查询流量」按钮（批量 `sub:usage`） | 用户是在节点页挑节点，剩余额度应当就地可见、可手动刷新 |
| 51 | renderer/styles.css | :1336-1339,1351-1352 | 新增 `.usage-reset` / `.usage.remain-only` / `.gh-sub` / `.np-sub` 样式 | 配合新增的展示位，沿用既有配色变量 |

**验证**

- 单元：以 4 条真实订阅共 165 个节点名为输入，**31/31 通过**。剔除 12 个伪节点（地鼠 4、三毛 5、infini 3），`danke` 49 个节点一个未误删；真节点名含「勿跑大流量」「2倍率」「(IPv6)」的均保留；二次清理幂等。
- 解析结果：地鼠剩余 162.84 GB / 20 天后重置 / 2027-04-16；三毛 451.11 GB / 24 天 / 2027-11-20；infini 1721.57 GB / 长期有效。
- 真实启动冒烟：home / nodes / subs 三页 `errs:[]`；首页流量卡显示「剩余 162.76 GB / 200.00 GB · 套餐剩 141 天 · 20 天后重置」；节点页实测总节点数 **115**（伪节点已剔除，停用的三毛订阅不计入）。
- CDP DOM 探针：`.gh-sub` = `["剩余 162.76 GB · 20 天后重置", "剩余 1721.55 GB"]`；查询按钮 1 个；页面内伪节点关键词 **0 命中**；`errs:[]`。
- CDP 点击「查询流量」实测：地鼠/三毛/infini 剩余额度刷新成功且 `resetDays` 20/24 保留，`source=header+node`；`danke` 无数据。
- 收尾：`data/`、`temp/` 已用原件 `/MIR` 复原，`state.json` 与原件逐字节一致；0 个残留进程，无 `shot.png`。
- **danke 查不到流量属正常**：一次性订阅链接，不提供 `subscription-userinfo`，订阅正文里也没有信息节点；按用户确认不作为缺陷处理。

### 补修：涌浪进度条回归（用户反馈「上一版还有进度条，这版没了」）

| # | 文件 | 位置 | 修改 | 理由 |
|---|------|------|------|------|
| 52 | renderer/ui.js | :70-100 | `UsageBar` 在「只有剩余额度、没有总额度」时**不再隐藏进度条**：保留槽位并渲染 `.usage-bar.surge` | 第五轮加的 remain-only 分支把整条进度条 `display:none`，用户看不到进度条；信息节点其实已经有用量数据，应该可见 |
| 53 | renderer/styles.css | :1338-1342 | 涌浪扫光动画 `@keyframes usage-surge`（2.8s 循环），尊重 `prefers-reduced-motion`（减弱动画时改为半透明静态条） | 无总额度时无法给出真实百分比，用动效表示「已读到用量、等待响应头补齐额度」，而不是留一条空白槽 |
| 54 | electron/ipc.js | :444-448 | `refreshStaleUsage` 把「`traffic.total === 0` 且来源不是 header」也判为过期，启动 6 秒后自动补查响应头 | 让涌浪条在拿到 `total` 后自动变成真实百分比进度条，无需用户手动点「查询流量」 |

**验证（CDP 实测，端口 9233）**

- 真实状态首页：`.usage-bar` **3 条**、`display:block`、宽度 85px、`errs:[]`——进度条已恢复。
- 注：一次快照 `bars:0` 是应用自己把页面切到 `groups`，不是进度条消失；切回 `home` 后 3 条正常。
- 强制把地鼠 `traffic.total=0, source=node` 后：`.usage-bar.surge` = **1**、`animationName = usage-surge`、条宽 174px、`errs:[]`——涌浪分支生效且可见。
- 启动 6 秒自动补查后：地鼠/三毛/infini 的 `total` 分别为 214748364800 / 536870912000 / 2175400935424，`source = header+node`，进度条切回真实百分比。

### 版本升级（v0.6.0）

| # | 文件 | 位置 | 修改 | 理由 |
|---|------|------|------|------|
| 55 | resources/app/package.json | :4 | `version` 0.5.1 → 0.6.0 | 优化副本作为新版本交付 |
| 56 | resources/app/renderer/pages/settings.js | :299 | 设置页「关于」版本号 → 0.6.0 | 界面显示与包版本一致（离屏实测命中 0.6.0，errs 全空） |
| 57 | 文件夹名 | — | `D:\桌面\Wallnut-0.5.1-optimized` → `D:\桌面\Wallnut-0.6.0`；开始菜单快捷方式 `Wallnut.lnk` 的 TargetPath 同步改到新路径 | 版本与目录名对齐；不改快捷方式会指向已不存在的旧目录 |

原件 `D:\桌面\Wallnut-0.5.1` 未改动；本轮未对 `data/` 做任何覆盖或复原。

