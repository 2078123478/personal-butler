# AlphaOS 审计报告（严格资金安全视角）

审计范围：
- `src/skills/alphaos/plugins/dex-arbitrage.ts`
- `src/skills/alphaos/plugins/smart-money-mirror.ts`
- `src/skills/alphaos/engine/alpha-engine.ts`
- `src/skills/alphaos/runtime/{simulator.ts,risk-engine.ts,onchainos-client.ts,state-store.ts,vault.ts,config.ts}`
- `src/skills/alphaos/api/server.ts`

结论摘要（先给结论）：
- `dex-arbitrage`：**纯演示**（不是可实盘套利实现）
- `smart-money-mirror`：**纯演示**（收益模型为合成，不是市场可验证 alpha）
- AlphaOS 当前整体：**纯演示，不应接入真实资金**

---

## 1) 算法盈利能力分析

### 1.1 核心问题与证据

1. 🔴 Critical - 执行路径并未实现“两腿套利”，只做了单腿 swap  
证据：`onchainos-client.ts:347-412` 只执行 `quote -> swap -> simulate -> broadcast -> history` 的一次交易；未看到“买入 DEX + 卖出 DEX”两腿对冲执行。  
影响：策略名为 DEX arbitrage，但执行本质是单边方向性交易，无法锁定价差收益。

2. 🔴 Critical - 盈利估算存在硬编码正向偏置（+45bps）  
证据：`onchainos-client.ts:648-655` 中 `targetPrice = impliedPrice * bpsToMultiplier(45)`，并据此计算 `grossUsd`。  
影响：收益估算被人为抬高，回测/监控可显示“盈利”，但不代表真实成交收益。

3. 🟠 High - `smart-money-mirror` 使用合成价格，不来自真实盘口  
证据：`smart-money-mirror.ts:44-47`，`buyPrice=1`、`sellPrice=1+edge`，`edge` 来自 `confidence/size` 启发式函数（`estimateEdgeBps`）。  
影响：收益来自模型假设，不是市场可实现的可验证价差。

4. 🟠 High - 滑点、手续费、gas 模型过于静态，难以覆盖真实执行损耗  
证据：`simulator.ts:13-21` 全局常量滑点/费率/gas；未建模深度冲击、路由变化、拥堵波动、重试成本。  
影响：净边际（net edge）容易被高估，真实市场转负收益概率高。

5. 🟡 Medium - 报价价格换算未处理 token decimals，价格绝对值可能失真  
证据：`onchainos-client.ts:323-327` 直接 `fromTokenAmount / toTokenAmount`。  
影响：价格尺度可能偏离真实 USD 价格；虽相对边际仍可计算，但风控阈值与策略解释性受损。

6. 🟠 High - 计划中的 `buyDex/sellDex` 在实盘执行阶段基本未生效  
证据：`onchainos-client.ts:361-375` 执行时未使用 `plan.buyDex/plan.sellDex` 指定双边路径。  
影响：策略发现的机会与实际执行路径不一致，盈利假设断裂。

### 1.2 真实市场条件下收益评估

- 当前实现对以下关键假设依赖过强，且多数不成立：
  - 价格源可瞬时成交（未建模延迟/MEV/链上竞争）
  - 流动性足够深（未使用深度曲线和冲击函数）
  - 成本稳定（gas/滑点/手续费常量化）
  - 机会可从发现无摩擦地映射到执行（执行路径与发现路径不一致）

- 在真实市场中，上述偏差会系统性侵蚀毛利，预计策略从“纸面正收益”转为“随机或负收益”。

### 1.3 明确结论

- `dex-arbitrage`：**纯演示**
- `smart-money-mirror`：**纯演示**
- 整体：**纯演示（非可直接盈利实盘系统）**

---

## 2) Bug 分析（逻辑/边界/竞态/状态）

1. 🔴 Critical - 交易与日 PnL 更新非原子，存在一致性风险  
证据：`state-store.ts:448-498` 先插入 `trades`，再查询/写入 `pnl_daily`，未放进事务。  
影响：进程崩溃或并发实例下可能出现“有交易无 PnL”或累计错账。

2. 🟠 High - Whale 信号消费非原子，且先标记 consumed 再执行交易  
证据：`smart-money-mirror.ts:68` 在 scan 阶段即 `consumed`；`state-store.ts:810-827` 无锁获取与更新。  
影响：崩溃会丢信号；多实例可重复消费或状态竞争。

3. 🟠 High - live/paper 资金与仓位未真实演进，风险控制使用静态余额  
证据：`alpha-engine.ts:272`, `411-413` 使用配置中的固定 `liveBalanceUsd/paperStartingBalanceUsd`。  
影响：头寸规模与止损阈值不随真实 PnL 变化，风控失真。

4. 🟠 High - `LIVE_ENABLED=true` 时默认 `desiredMode=live`，可能被自动晋升  
证据：`alpha-engine.ts:120`；配合 `AUTO_PROMOTE_TO_LIVE`（`config.ts:136` 默认 true）。  
影响：部署者若忽略配置，系统可在门控满足后自动切 live，存在误开仓风险。

5. 🟡 Medium - 权限类 live 失败降级为 paper，但不计入失败序列  
证据：`alpha-engine.ts:347-378` 权限失败走 degrade 分支后直接 return；`consecutiveFailures` 未增加。  
影响：风险引擎无法感知持续 live 权限失败，系统可能反复尝试 live 请求。

6. 🟡 Medium - 执行成功即标记 confirmed，缺少严格链上最终性确认  
证据：`onchainos-client.ts:398-411`。  
影响：广播成功但链上失败/回滚/长延迟时，状态与真实资产状态可能不一致。

7. 🟢 Low - 无请求超时控制，外部 API 卡死可拖住 tick  
证据：`onchainos-client.ts:820-824` fetch 未设置 timeout/abort。  
影响：极端网络情况下节拍执行退化。

### paper→live 切换安全性结论

- 当前切换门控存在，但依赖“模拟结果”而非真实成交质量（`alpha-engine.ts:427-435`, `state-store.ts:720-743`），且默认配置可自动晋升。  
- 结论：**不满足真实资金级别的切换安全要求**。

### 数据库原子性/一致性结论

- 大量写操作是单语句安全，但关键资金账务链路（trade + pnl）不是事务化。  
- 结论：**一致性不足，需要事务化改造**。

---

## 3) 安全性分析（重点）

1. 🔴 Critical - API 缺少认证/授权，敏感操作完全暴露  
证据：`api/server.ts` 全部路由未做 auth middleware，含：
- `/api/v1/engine/mode`（`384-392`）
- `/api/v1/strategies/profile`（`406-423`）
- `/api/v1/signals/whale`（`478-512`）
- 多个状态/交易数据接口  
影响：任意访问者可切模式、改策略参数、注入信号、读取运行数据。真实资金场景不可接受。

2. 🟠 High - 前端 demo 存在 XSS 面风险（未转义字符串写入 innerHTML）  
证据：`api/server.ts:275-279`。`strategyId` 可由接口写入数据库。  
影响：若运营端打开 `/demo`，可被注入脚本窃取会话/操控页面。

3. 🟠 High - 重放风险：关键控制接口无签名、无 nonce、无时效校验  
证据：控制类 POST 接口仅 JSON 参数校验，无防重放机制。  
影响：攻击者可复用旧请求反复切换模式、重复注入信号。

4. 🟡 Medium - `vault.ts` 加密实现总体正确，但密钥管理仍不足“实盘级”  
证据：`vault.ts:15-47` 使用 AES-256-GCM + 随机 nonce/salt + PBKDF2。  
优点：算法/模式选择正确，含认证标签。  
不足：
- 无 HSM/KMS/密钥分层，主密码完全由环境和运维流程保护
- 无口令强度策略、无解密速率限制
- `vault:get` 明文输出到 stdout（`index.ts:28-39`）  
结论：**密码学实现合格，但系统级密钥管理不达资金级标准**。

5. 🟡 Medium - 诊断错误信息可能泄露上游返回细节  
证据：`onchainos-client.ts:836-838`, `870-873` 记录错误文本片段。  
影响：若上游错误体包含敏感上下文，可能被运维面或 API 暴露链路间接泄漏。

6. 🟡 Medium - `.env` 敏感配置处理有基础隔离，但默认值偏激进  
证据：`.gitignore` 忽略 `.env`；但 `.env.example` 默认 `LIVE_ENABLED=true`、`AUTO_PROMOTE_TO_LIVE=true`（`11-12`）。  
影响：新环境若照抄默认，实盘误触发风险上升。

### 注入攻击检查结论

- SQL 注入：主要 SQL 路径使用 parameterized statement，风险较低。  
- XSS：存在（见上）。  
- 命令注入：未发现明显命令拼接执行点。  
- 重放：存在（见上）。

### 风控熔断 `risk-engine.ts` 可靠性

- 逻辑存在但偏简化（`risk-engine.ts:23-31`），且输入依赖模拟统计与静态余额。  
- 对“权限受限持续失败”等关键异常覆盖不足（见 Bug #5）。  
- 结论：**可作为演示级保护，不足以作为实盘主防线**。

---

## 总体评估

**总体评级：高风险（不建议接入真实资金）**

主要原因：
- 收益模型与真实执行不一致（策略可行性根基不足）
- 交易账务链路缺乏原子一致性
- 控制面 API 无认证授权（直接资金安全红线）
- 风控门控与熔断依赖简化指标，易误判

---

## 改进建议优先级（按落地顺序）

1. P0（立即）  
- 为全部控制/管理/交易相关 API 增加认证授权（至少 mTLS 或签名 token + RBAC）  
- 默认关闭 live：`LIVE_ENABLED=false`、`AUTO_PROMOTE_TO_LIVE=false`  
- 下线或内网隔离 `/demo` 与所有管理接口

2. P0（资金一致性）  
- 将 `insertTrade + pnl_daily` 改为单事务  
- 为 whale 信号消费引入原子“claim”机制（`pending -> processing -> consumed/ignored`）

3. P1（策略可交易性）  
- 重构 arbitrage 为真实双腿执行（含路径锁定、原子/近原子保障）  
- 移除硬编码 +45bps 收益偏置；收益必须来自成交回执  
- 在执行阶段严格使用 `buyDex/sellDex` 与路由约束

4. P1（风险控制）  
- 以真实账户权益/可用保证金更新 `balance`  
- 熔断输入加入权限失败、拒单率、延迟、滑点偏离  
- live gate 基于真实成交统计，不仅是 simulation

5. P2（密钥与运维）  
- 接入 KMS/HSM 或至少 envelope encryption  
- 限制 `vault:get` 使用场景与审计日志，避免明文输出扩散  
- 错误日志脱敏（上游 error body 白名单提取）

