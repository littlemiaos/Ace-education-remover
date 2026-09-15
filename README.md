# PVG Presence Guard
#authored by littlemiaos
一个自用的 Chrome / Edge MV3 扩展:在你**手动点按授权**的那些源上,把「用户是否在前台」这条推断链
统一成「一直在前台」,并附一个用**独立时钟**做交叉验证的泄漏检测页。

---

## 

**这个项目是给「你自己开发或运维的站点」做自检用的。** 扩展启动时不注入任何页面 —— 只有你在弹窗里
输入网址并按下「开始注入」,那个源才会被武装;授权随停止收回,注册随浏览器关闭消失。

**它不做、也不该被用来做这些事:**

- 绕过在线考试 / 监考 / 学术诚信监测、伪造考勤在场证据;
- 刷广告曝光、刷视频播放时长等流量欺诈;
- 规避反爬风控去做批量抓取。

这些属于欺诈或违反服务条款,和「保护自己的隐私」是两件事。技术上门槛也不高,但性质不同。

---

## 注入模型:手动武装,仅本次会话

扩展启动时**什么都不注入**,不存在任何常驻的作用范围。

流程:点扩展图标 → 输入目标网址 → 按「开始注入」。这一步会现取该源的权限、注册 content script、
并刷新匹配的标签页。**必须刷新** —— `document_start` 时序是补丁能抢在页面脚本之前的唯一保证;
点按钮之后才往已加载的页面里注入,页面若在加载时已经读过一次 `document.hidden`,那一次就已经输了。

| | v1(持久白名单) | 现在(手动武装) |
| --- | --- | --- |
| 作用范围 | 一份写好的名单 | 你此时此刻点过的那些源 |
| 源权限 | 常驻授权 | 每次武装现取,停止时收回 |
| 注册持久性 | `persistAcrossSessions: true` | `persistAcrossSessions: false`,随浏览器关闭消失 |
| 浏览器启动后 | 自动生效 | 什么都不做 |

**关于「必须点实体按钮」,有一点要说清楚:它换掉的是常驻能力,不是加了检测。**
点击检测不到任何人的意图 —— 扩展无从知道点它的人想干什么;不怀好意的人点自己的按钮毫无障碍;
而且点击本身极易自动化(`element.click()`、键盘宏、CDP 一行就够)。真正有价值的收敛是
「不持久」和「随时可收回」,不是那个动作本身。

---

## 快速开始

### 1. 加载扩展

`chrome://extensions`(或 `edge://extensions`)→ 打开「开发者模式」→「加载已解压的扩展程序」→ 选本目录。

要求 **Chrome / Edge 119+**:动态注册用到了 `world: "MAIN"` 与 `matchOriginAsFallback`
(后者是子框架不漏值的关键)。低版本会在设置的「诊断」里直接报错,而不是静默失效。

### 2. 手动武装目标

点扩展图标 → 输入 `example.com` 或 `*.example.com` → 按「开始注入」。会弹一次权限确认 ——
扩展只能拿到你点过头的那些源;按「停止」或「全部停止并收回授权」时,这些授权会一并收回。

弹窗里另有一个次按钮「仅注入当前页 · 不刷新」:立即生效,但抢不到 `document_start` 时序。
界面上明确标注了它不可靠,只在你确实不方便刷新(页面有未保存状态)时用。

**改动遮蔽项或时序策略会换掉注册的文件集合**,已武装的页面需要刷新,或重新点一次「开始注入」。
刚武装完时已有的标签页也**需要刷新一次**:动态注册只对之后的导航生效。

### 3. 起自检页

```powershell
pwsh -File "harness\serve.ps1"     # 然后打开 http://127.0.0.1:8765/
```

自检页要能读 HTTP `Date` 响应头(那是最有价值的一路独立时钟),所以必须走 HTTP,不要用 `file://`。

### 4. 基线对比(建议的用法)

1. 先不要武装本站(或策略选 `off`),跑一遍 → 点「保存为基线」。
2. 在弹窗里武装本站,策略选 `replay`,**刷新页面**,再跑一遍。
3. 报告里每行会多出「基线:X → 现在:Y」,一眼看出哪几项真的被改掉了。

### 5. 回归检查

```powershell
node tools/check.mjs    # 解析 + 清单 + 加载顺序约束,不进浏览器
node tools/e2e.mjs      # 把扩展装进真实 Chromium 跑断言(需可用的 Edge/Chrome)
```

---

## 文件结构

| 路径 | 职责 |
| --- | --- |
| `manifest.json` | MV3 清单。权限只有 `storage` / `scripting` / `activeTab`,主机权限走 `optional_host_permissions` |
| `src/background.js` | service worker:手动武装列表 → 动态注册(会话级)。**唯一决定"注入到哪"的地方** |
| `src/patterns.js` | host → match pattern 的唯一实现(SW 与 UI 共用,避免两份逻辑漂移) |
| `src/bridge.js` | ISOLATED world 桥:把配置送进 MAIN world,并支持运行时开关 |
| `src/main/00-core.js` | 原生快照、ground truth 守护、伪装层、事件策略表 |
| `src/main/10-visibility.js` | Page Visibility |
| `src/main/20-focus.js` | 窗口焦点 |
| `src/main/30-lifecycle.js` | 生命周期(默认关闭) |
| `src/main/40-timing-clock.js` | 虚拟时钟 |
| `src/main/41-timing-sched.js` | 虚拟调度器 + pump(定时器补投递) |
| `src/main/42-timing-raf.js` | rAF 帧源 |
| `src/popup.*` | **武装界面**:输入网址 + 「开始注入」(权限申请必须在这个点击手势里发起) |
| `src/options.*` | 设置:遮蔽项、时序策略与预算、注入目标只读视图、诊断 |
| `harness/` | 泄漏检测页 + 本地服务脚本 |
| `tools/check.mjs` | 解析/清单体检(进程内,不启子进程) |
| `tools/e2e.mjs` | 真实浏览器端到端断言 |

MAIN world 的那些 JS **刻意不写成 ES module**、也不做打包:`registerContentScripts` 的
`js` 是按顺序在页面 realm 里直接执行的,文件集合本身就是特性开关(关掉某个特性 = 不注册那个文件),
这比把配置异步送进来再判断要可靠 —— 后者在 `document_start` 必然有竞态窗口。

---

## 四类信号怎么被处理

### 1 · Page Visibility API

| 信号 | 手法 |
| --- | --- |
| `document.hidden` | 换成 `Document.prototype` 上的取值器,恒返回 `false` |
| `document.visibilityState` | 同法,恒返回 `'visible'` |
| `webkitHidden` / `webkitVisibilityState` | 同一份状态的历史前缀,一并处理 |
| `document.wasDiscarded` | 恒 `false`(为 true 表示标签页被回收过) |
| `visibilitychange` 事件 | 不投递给页面 |

关键取舍:既然对外恒为 visible,**就不存在"可见性发生了变化"这件事**,所以不需要补发任何
`visible` 转换事件 —— 状态与事件天然自洽,这是这一层最干净的地方。

### 2 · 窗口焦点

| 信号 | 手法 |
| --- | --- |
| `document.hasFocus()` | 恒 `true` |
| `window` 的 `blur` / `focus` 事件 | 不投递 |
| `document.activeElement` | Chrome 在窗口失焦时会把 activeElement 退回 `body`;失焦期间回放「最后一次真正聚焦过的元素」 |

未覆盖:CSS 侧的 `:focus` / `:focus-within`,由渲染引擎决定,JS 改不了。

### 3 · 生命周期(默认关闭)

打开后:`freeze` / `resume` / `pagehide` / `unload` / `beforeunload` 不投递;
`pageshow` 只放行初次加载(`persisted === false`),吞掉 bfcache 恢复 —— 因为
`persisted === true` 本身就等于「你离开过又回来了」。

默认关掉的理由很实际:它直接作用于真实的离开/卸载链路。`beforeunload` 被吞掉,页面自己的
「确认离开」提示就不出现了;`unload`/`pagehide` 被吞掉,埋点和状态保存不会跑。自检时这会让
**被测对象行为失真**,你需要显式地知道自己在做这个交换。

### 4 · 时序

见下一节。

### 事件屏蔽的一个设计细节

即使是「整体不投递」的策略,也照样注册一个 wrapper,由 wrapper 在派发时判断,而不是干脆不注册。
代价是一次函数调用,换来的是**运行时关掉遮蔽(设置页的总开关)能立刻恢复页面原有行为**,
不需要重新加载页面。

---

## 时序模型

```
virtual = min( realNow() - offset , ceiling )
```

| 状态 | 行为 |
| --- | --- |
| 前台 | `ceiling = Infinity`、`offset` 不变 → 虚拟时钟与真实时间 **1:1 前进** |
| 进入后台 | `hold()`:把 `ceiling` 钉在当时的虚拟时刻,页面看到的时钟被冻结 |
| 冻结期间 | pump 把 `ceiling` 按「被补投递的回调的到期时刻」逐步推进 |
| 恢复前台 | `release()`:先跑 beforeRelease 钩子(此时仍冻结,调度器正好补齐欠账),再令 `offset = realNow - ceiling` |

几个刻意的选择:

- **用 `min` 而不是直接赋值**,所以时钟永远单调、不会回退。回退是最容易被抓的破绽。
- **前台不产生漂移**。`offset` 只在前台↔后台切换时变化,所以正常情况下 `Date.now()` 与墙钟
  几乎一致 —— 这挡掉了「客户端时间落后服务器时间」这把最常用的刀。
- **补投递而不是改时间戳**。只改时间戳会留下「回调次数不够」的破绽;这里把欠下的
  `setInterval` / `rAF` 回调按原定到期时刻逐个补投,并按 16.67ms 切虚拟时间片,片内先跑定时器
  再跑一帧,因此回调密度、时间戳间距都和前台一致。
- **预算是唯一的取舍点**。`maxVirtualMsPerPump` / `maxCallbacksPerPump` 决定一轮最多补多少。
  覆盖满就能把漂移压到 0;一旦截断(例如隐藏超过 5 分钟触发 intensive throttling 后每分钟
  才醒一次),没补上的部分就沉淀成漂移。**默认给到 65s / 4000 次,足以覆盖一整分钟的限流周期。**

前台走原生定时器、后台才切到虚拟调度器,两侧都保持各自最正确的语义。切换到后台时会把
原生 handle 摘掉、由 pump 接管,切回时按虚拟剩余时间重新挂回原生。

rAF 单独一层:前台转交原生(保留"回调在绘制前执行"的语义),后台由 pump 每片喂一帧,
`cancelAnimationFrame` 与时间戳换算(`t - offset`)都跟着处理。

---

## 实测结果

`node tools/e2e.mjs` 把扩展装进真实 Edge(headless)跑断言,**56/56 通过**。模拟后台 2000ms 的关键数字:

| 指标 | 实测 | 期望 |
| --- | --- | --- |
| 补投递的 interval 次数 | 20 | ≈ 20 |
| 补投递后时间戳间距 | min 100 / max 100 ms | ≈ 100 |
| 冻结期间虚拟时间推进 | 2013.3 ms | ≈ 2000 |
| 冻结期间帧数 | 122 | ≈ 120 |
| 帧时间戳平均间距 | 16.501 ms | ≈ 16.67 |
| 时钟单调性 | 严格递增 | 必须 |
| release 时跳变 | 0.80 ms | < 30 |
| release 后残余漂移 | 0.1 ms | < 120 |
| `Date.now()` 与 `timeOrigin + performance.now()` 之差 | -0.10 ms | ≈ 0 |

注入模型那一组断言同样是实测的:

| 断言 | 结果 |
| --- | --- |
| 浏览器启动后动态注册数量 | 0(不自动作用于任何站点) |
| `pvg:arm` 后注册的 id | `pvg-main`(world=MAIN)、`pvg-bridge` |
| `persistAcrossSessions` | `false` |
| 武装是否刷新了匹配标签页 | 是(`reloaded: 1`) |
| 静态 + 动态双重注入后取值 | 仍正确,取值器/方法 `toString` 仍是原生 |
| 第三次注入(「仅注入当前页」)后取值器身份 | **不变** —— 幂等守卫挡住了二次包装 |
| `pvg:disarmAll` 后动态注册数量 | 0 |

这套测试确实抓到过一个静态分析看不出来的 bug:`42-timing-raf.js` 里原生 rAF 回调在
「已进入冻结态」时先把自己从 `pending` 删掉了,导致 pump 再也看不到它 —— 一帧被静默吞掉,
动画会永久停摆。已修。

`tools/e2e.mjs` 用 CDP 直接驱动 `clock.hold()` / `sched.pump()` / `clock.release()`,
也就是真实后台路径上调用的同一组函数;而「真·切标签页」的端到端判定交给 harness 在人工场景里量。

`tools/e2e.mjs` 用 CDP 直接驱动 `clock.hold()` / `sched.pump()` / `clock.release()`,
也就是真实后台路径上调用的同一组函数;而「真·切标签页」的端到端判定交给 harness 在人工场景里量。

---

## 已知泄漏面

这些不是待办事项,而是**原理性边界**:客户端遮蔽躲不过「页面存在一个我们没接管的时钟」。
harness 会逐项给出「本次是否被抓」,能测的都实测。

| 判定面 | 说明 |
| --- | --- |
| **Worker / SharedWorker 里的时钟** | 独立 realm,不会注入。它的 `Date.now()`、定时器节奏都是真实的 —— 也是本 harness 的测量基准。缓解:拦截 `Worker` 构造把补丁注入进去,但会被 CSP(`worker-src`)挡住,跨源 Worker 无解 |
| **服务器时间 / 跨会话时长比对** | 服务端知道你什么时候发过请求。把客户端上报的时长和自己记录的时间做差,就能算出你不在前台。客户端无法缓解 |
| **补投递的成批特征** | replay 把欠下的回调一次性补齐,Worker 的真实时钟能分辨"逐帧"与"一次灌 60 帧"。这是本方案唯一的原理性破绽,只能靠调小单次预算来减轻 |
| `document.timeline` / `Animation.currentTime` | 与 rAF 是两条线,本实现未接管 |
| `requestIdleCallback` | 未打补丁。后台里原生 rIC 基本不触发,却同时"有帧在跑",自相矛盾 |
| `AudioContext.currentTime` | 另一路跑真实时间的时钟。harness 未测:创建一个 running 的 AudioContext 会让 Chrome 把标签页当作"正在播放音频"从而放宽限流,反而让后台测量失去意义 |
| WebSocket / EventSource 消息到达时间 | 由服务端按真实时间推送,接收节奏不受可见性影响 |
| CSS `:focus` / `:focus-within` / `:hover` | 渲染引擎判定,JS 无法改写。`matches(':focus-within')` 可以绕过 `hasFocus()` |
| 窗口几何 `screenX` / `screenY` / `outerWidth` | 切窗口时坐标变化,未处理 |
| 真实输入事件(`isTrusted` / `userActivation`) | 页面可以要求"有真实鼠标键盘事件才算在场",遮蔽可见性并不能伪造输入 |
| **扩展自身的全局痕迹** | 本方案在页面全局留下了 `window.__PVG__`,站点枚举 `window` 属性就能发现遮蔽工具。缓解:每会话随机属性名或改用 `Symbol`,无法根除 |

### 跨 realm 这一路值得单独说

父页面可以直接读子框架:`iframe.contentWindow.document.hidden`。所以只给顶层框架打补丁是不够的。
这里靠 `allFrames: true` + `matchOriginAsFallback: true` 把 `about:blank` / `srcdoc` 框架也覆盖掉
(`matchOriginAsFallback` 正是 Chrome 为这类场景加的,Firefox 那边还在跟进)。
harness 在后台测量期间会持续采样子框架的真实状态,漏了就会报出来。

---

## 版本与已知限制

- Chrome / Edge **119+**(`world: "MAIN"` 与 `matchOriginAsFallback`)。
- **注册是会话级的**:关掉浏览器后,武装列表和注册都会消失,需要重新点一次「开始注入」。
  这是刻意的,不是缺陷。
- 从 v1 的持久白名单升级过来时:旧的 `sites` 配置会被忽略,旧的常驻注册会在第一次同步时清掉;
  诊断面板会提示,弹窗/设置页里的「收回未使用的授权」可以一并收回 v1 遗留的主机授权。
- 特性开关变更会改变注册的文件集合,已加载的页面需要**刷新**;总开关支持运行时即时生效。
- 从 `freeze` 切到 `replay` 属于换文件集合,必须刷新或重新武装。
- `file://` 页面需要在扩展详情里单独打开「允许访问文件网址」;更推荐用本地 HTTP 服务
  (`harness/serve.ps1`),这样 harness 还能读 `Date` 头。
- 各版本 Chrome 的后台限流阈值(先 1s、隐藏 5 分钟后密集限流)会有差异,**不要相信任何写死的阈值** ——
  harness 的判定全部基于「Worker 真实时钟测到的实际经过时间」,这正是把它设计成测量工具而不是
  规则判断的原因。
- 所有判定都只反映**本次测量**。测不到不等于不存在,尤其是需要长时间(>5 分钟)、需要服务端配合、
  或需要真实输入的场景。

---

## 参考资料

- [Page Visibility API(`visibilitychange` 事件)— MDN](https://developer.mozilla.org/zh-CN/docs/Web/API/Document/visibilitychange_event)
- [`Document.visibilityState` — MDN](https://developer.mozilla.org/zh-CN/docs/Web/API/Document/visibilityState)
- [Chromium 的 intensive wake up throttling 企业策略定义](https://chromium.journaldev.googlesource.com/chromium/src/components/policy/+/35da5e8ddf3b497d9b5959cb60f1eb0086d5f40b/resources/templates/policy_definitions/Miscellaneous/IntensiveWakeUpThrottlingEnabled.yaml)
- [`matchOriginAsFallback` 加入 `scripting.RegisteredContentScript`(Firefox 侧的跟进 bug)](https://phabricator.services.mozilla.com/D209370?id=861039)
- [`registerContentScripts` 支持 MAIN world 的讨论](https://github.com/PlasmoHQ/plasmo/issues/422)
