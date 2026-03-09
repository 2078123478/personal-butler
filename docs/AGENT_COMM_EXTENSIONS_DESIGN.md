# Agent-Comm 扩展项设计

状态：Draft  
日期：2026-03-08

## 1. 文档目标

基于当前仓库已有的 Agent-Comm v2 实现与前序分析，定义 4 个扩展方向的最小可用实现方案：

1. 打通执行控制面：`probe_onchainos`、`request_mode_change`
2. 补齐 `RevocationNotice` 端到端流程
3. 增加 x402 密码学验证
4. 接入 OnchainOS 协议层：`relay`、`AA/paymaster`

本文档只定义实现边界、文件范围、验证方式与依赖顺序，不修改代码。

## 2. 现状快照

当前代码库已经具备以下基础，但仍未闭环：

- `src/skills/alphaos/runtime/agent-comm/types.ts` 已定义 `probe_onchainos`、`request_mode_change`
- `src/skills/alphaos/runtime/agent-comm/task-router.ts` 仍把这两个命令标为 `reserved for future version`
- `src/skills/alphaos/runtime/agent-comm/artifact-contracts.ts` 已冻结 `RevocationNotice` 的 EIP-712 typed data
- `src/skills/alphaos/runtime/agent-comm/x402-adapter.ts` 目前只做结构校验，不做签名真实性校验
- `src/skills/alphaos/runtime/onchainos-client.ts` 已有 `private-relay` / `private-rpc` 提交通道，但 Agent-Comm `tx-sender.ts` 仍只走直接 RPC 发交易
- `src/skills/alphaos/runtime/network-profile.ts` 明确标记 `relayOverride=true`，但 `paymasterImplemented=false`、`aaImplemented=false`

这意味着当前最适合的策略不是重做协议，而是把已有半成品补成最小闭环。

## 3. 设计原则

### 3.1 KISS

- Phase 1 只做可评审、可测试、可演示的闭环
- 优先复用现有 `OnchainOsClient`、`AlphaEngine`、artifact store、contact/trust 模型
- 不为了未来一次性引入大抽象层

### 3.2 Phase 1 非目标

- 不重设计 Agent-Comm envelope
- 不新增 websocket、receipt bus、异步任务系统
- 不把 `relay` / `AA` / `paymaster` 包装成默认路径
- 不在 Phase 1 做完整的 x402 结算、清结算、invoice 系统
- 不在 Phase 1 做 `RevocationNotice` 的自动 gossip / 全网传播

## 4. 分期总览

| 扩展项 | Phase 1（优先做） | Phase 2（可延后） |
|---|---|---|
| 执行控制面 | 打通接收端执行闭环与最小发送入口 | 增加执行回执、统一 generic send surface |
| RevocationNotice | 完成签发、导入、状态应用闭环 | 自动分发、附件传播、联系人级封装 |
| x402 验证 | 完成加密 proof 携带与签名真实性校验 | 结算对账、invoice 绑定、多资产扩展 |
| OnchainOS 协议层 | 先接 `relay` 薄适配 | `AA/paymaster`、sponsored/userOp 路径 |

建议交付顺序：

1. 执行控制面 Phase 1
2. `RevocationNotice` Phase 1 与 x402 Phase 1，可并行
3. 协议层 Phase 1：`relay`
4. 协议层 Phase 2：`AA/paymaster`

## 5. 依赖顺序

### 5.1 强依赖

- `AA/paymaster` 依赖 `relay/direct` 统一提交抽象先落地
- 执行控制面若要支持 `request_mode_change`，运行时必须把 `engine` 注入 Agent-Comm router

### 5.2 弱依赖

- `RevocationNotice` 与 x402 可以独立开发
- `relay` 接入与 `probe_onchainos` 命令本身没有强依赖，但为了减少变量，建议先打通命令路由，再替换底层发送通道

## 6. 扩展项一：执行控制面

### 6.1 目标

让 Agent-Comm 能真正执行以下命令，而不是只完成收发：

- `probe_onchainos` -> 复用 `OnchainOsClient.probeConnection()`
- `request_mode_change` -> 复用 `AlphaEngine.requestMode()`

Phase 1 的目标是“接收端收到可信业务命令后能执行并落本地状态”，不是“发起方实时拿到执行结果”。

### 6.2 阶段划分

#### Phase 1

- router 真正路由 `probe_onchainos` 与 `request_mode_change`
- runtime 注入 `engine`
- CLI / API 增加最小发送入口
- 继续沿用当前 trusted sender gating，不新增复杂授权系统

#### Phase 2

- 新增执行结果回执消息或异步 receipt
- 统一 `agent-comm:send <command>` 与 `/api/v1/agent-comm/send/command`
- 视需要补 capability 硬校验

### 6.3 改动范围

- `src/skills/alphaos/runtime/agent-comm/task-router.ts`
- `src/skills/alphaos/runtime/agent-comm/runtime.ts`
- `src/skills/alphaos/runtime/agent-comm/entrypoints.ts`
- `src/skills/alphaos/api/server.ts`
- `src/index.ts`
- `tests/agent-comm-task-router.test.ts`
- `tests/agent-comm-runtime.test.ts`
- `tests/agent-comm-send-api.test.ts`

### 6.4 实现要点

- 在 `TaskRouterOptions` 中新增最小 `engine` 依赖，只暴露 `requestMode(mode)` 所需接口
- `probe_onchainos` 直接映射到：
  - `pair`
  - `chainIndex`
  - `notionalUsd`
- `request_mode_change` 直接映射到：
  - `requestedMode`
  - `reason`
- `routeCommand()` 返回值继续复用现有 `RouteResult`
- `runtime.ts` 在执行成功时仍只把本地消息标记为 `executed`；失败则标记 `rejected`
- Phase 1 不引入新的回执消息类型，不恢复旧 `agent_message_receipts`
- 发送面建议新增两个专用 surface：
  - CLI：`agent-comm:send probe_onchainos ...`
  - CLI：`agent-comm:send request_mode_change ...`
  - API：`POST /api/v1/agent-comm/send/probe-onchainos`
  - API：`POST /api/v1/agent-comm/send/request-mode-change`
- 默认 capability 模板仍保持现状，不把这两个命令加入默认 trusted 能力集

### 6.5 验证方式

- 单元测试：
  - `probe_onchainos` 成功返回 probe 结果
  - `request_mode_change` 成功/失败分别映射到 `RouteResult`
- runtime 测试：
  - 收到可信 inbound 命令后，分别调用 `onchain.probeConnection()` 与 `engine.requestMode()`
  - 成功写入 `executed`，失败写入 `rejected`
- API/CLI 测试：
  - 新 send route 参数解析正确
  - 未授权或参数错误时返回正确错误码

## 7. 扩展项二：RevocationNotice 端到端

### 7.1 目标

把已经冻结的 `RevocationNotice` typed-data 合约补成真实流程：

1. 本地签发 notice
2. 导出 / 导入 notice
3. 应用撤销状态到 artifact / endpoint / contact
4. 让后续收件路径真正尊重撤销状态

Phase 1 的“端到端”定义为：本地签发 + 手动导入 + 状态生效，不要求自动广播。

### 7.2 阶段划分

#### Phase 1

- 增加 `RevocationNotice` 的 sign / verify / persist
- 提供 CLI / API 的签发与导入入口
- 导入后立即更新 `agent_artifact_status`
- 关联更新 contact / endpoint 状态

#### Phase 2

- 把 `RevocationNotice` 作为 Agent-Comm v2 附件或独立 artifact 消息传播
- 提供联系人级封装，例如 `contact revoke`
- 支持 supersede / rotate 之后的自动 notice fanout

### 7.3 改动范围

- `src/skills/alphaos/runtime/agent-comm/artifact-workflow.ts`
- `src/skills/alphaos/runtime/agent-comm/signed-artifact-store.ts`
- `src/skills/alphaos/runtime/agent-comm/entrypoints.ts`
- `src/skills/alphaos/runtime/agent-comm/inbox-processor.ts`
- `src/skills/alphaos/runtime/state-store.ts`
- `src/skills/alphaos/runtime/agent-comm/contact-surfaces.ts`
- `src/skills/alphaos/api/server.ts`
- `src/index.ts`
- `tests/agent-comm-artifact-workflow.test.ts`
- `tests/agent-comm-entrypoints.test.ts`
- `tests/agent-comm-send-api.test.ts`
- `tests/agent-comm-inbox-processor.test.ts`
- `tests/state-store.test.ts`

### 7.4 实现要点

- 在 `artifact-workflow.ts` 中增加：
  - `signRevocationNoticeArtifact`
  - `verifyRevocationNoticeArtifact`
  - `parseSignedRevocationNoticeArtifact`
- 在 `signed-artifact-store.ts` 中增加 `persistSignedRevocationNoticeArtifact`
- 入口建议最小化为 artifact 级而不是 contact 级：
  - CLI：`agent-comm:artifact:revoke <artifactDigest> --artifact-type ...`
  - CLI：`agent-comm:artifact:import-revocation <file>`
  - API：`POST /api/v1/agent-comm/artifacts/revoke`
  - API：`POST /api/v1/agent-comm/artifacts/revocations/import`
- Phase 1 只支持 JSON 文件 / JSON body 导入，不做 share-url / QR
- 导入 notice 后做三层状态应用：
  - `agent_signed_artifacts` 里保存 notice 本身
  - `agent_artifact_status` 把目标 artifact 标记为 `revoked`
  - 关联 contact / endpoint 跟随更新
- `TransportBinding` 被撤销时：
  - 相关 endpoint 标记为 `revoked`
  - 若该联系人无其他 active endpoint，则联系人标记为 `revoked`
- `ContactCard` 被撤销时：
  - 目标 identity 对应联系人标记为 `revoked`
  - 若后续有 replacement digest，可在 Phase 2 做更细的 supersede 逻辑
- 为了让 ContactCard 撤销可定位，Phase 1 建议把当前 `contactCardDigest` 写入 contact `metadata`
- `inbox-processor.ts` 在校验 `senderCardDigest` 时，需要补查 `agent_artifact_status`
  - 若卡片 digest 已被撤销，直接拒绝

### 7.5 验证方式

- artifact workflow 测试：
  - valid notice 签名通过
  - digest / domain mismatch / bad signature 正确报错
- store / entrypoint 测试：
  - 导入后 notice 自身被持久化
  - 目标 artifact status 被标记为 `revoked`
  - endpoint / contact 状态正确更新
- inbox 测试：
  - 被撤销 binding 的消息继续被拒绝
  - 被撤销 card digest 的消息被拒绝

## 8. 扩展项三：x402 密码学验证

### 8.1 目标

把当前“只要带 payment 字段就可进入 `paid_pending`”的弱语义，升级为“proof 真实性可验证”的最小闭环。

Phase 1 只做 proof 密码学校验，不做完整结算、对账与支付网络抽象。

### 8.2 阶段划分

#### Phase 1

- x402 proof 进入 v2 加密 body，而不是回到外层明文
- 收件侧对 proof 做签名真实性校验
- `observe` / `enforce` 模式真正生效

#### Phase 2

- invoice / order 绑定
- 链上结算确认与异步对账
- 多资产 / 多网络 / 更复杂 rail 支持

### 8.3 改动范围

- `src/skills/alphaos/runtime/agent-comm/types.ts`
- `src/skills/alphaos/runtime/agent-comm/x402-adapter.ts`
- `src/skills/alphaos/runtime/agent-comm/inbox-processor.ts`
- `src/skills/alphaos/runtime/config.ts`
- `tests/agent-comm.test.ts`
- `tests/agent-comm-inbox-processor.test.ts`

### 8.4 实现要点

- 保持 `docs/AGENT_COMM_PROTOCOL_V2_DRAFT.md` 的原则：
  - payment / proof 默认进入 v2 加密 body
  - 不把 x402 proof 回退到 v1 outer envelope 作为主路径
- Phase 1 建议把 `encryptedEnvelopeV2PaymentSchema` 扩成：
  - `asset`
  - `amount`
  - `proof?: X402Proof`
  - `metadata?: {...}`
- `x402-adapter.ts` 改为真正的 verifier，而不是结构校验器
- 最小验证语义：
  - `scheme === "x402"`
  - `payer`、`asset`、`amount`、`nonce`、`signature` 必填
  - `expiresAt` 未过期
  - 用稳定序列化后的消息体恢复签名者，并要求与 `payer` 一致
  - 若 `payee` 存在，要求与本地接收地址或本地 identity 对应
- 模式语义建议收敛为：
  - `disabled`：保持现状，不做强校验
  - `observe`：校验失败也不执行业务，但允许记录为 `paid_pending`，同时写明失败原因
  - `enforce`：proof 缺失或校验失败则直接拒绝，不进入 `paid_pending`
- Phase 1 不恢复独立 `x402_receipts` 表，不做单独 receipt 流
- 验证结果先通过 message status / error 暴露即可

### 8.5 验证方式

- 单元测试：
  - 有效 proof 通过
  - 签名错误、过期、payee mismatch、字段缺失均失败
- inbox 测试：
  - `observe` 下无效 proof -> `paid_pending` + 错误原因
  - `enforce` 下无效 proof -> `rejected`
  - `enforce` 下有效 proof -> `paid_pending`
- codec 测试：
  - v2 payment proof 编解码往返正确

## 9. 扩展项四：接入 OnchainOS 协议层

### 9.1 目标

让 Agent-Comm 的发送链路不只依赖“本地钱包 + 公共 RPC”，而是逐步接入 OnchainOS 协议层能力。

本项必须拆成两段：

- Phase 1：`relay` 薄适配
- Phase 2：`AA/paymaster`

### 9.2 阶段划分

#### Phase 1

- 为 Agent-Comm 引入统一提交抽象
- 在不改 envelope 的前提下，把 `relay` 作为可选提交通道
- 默认仍是 direct RPC

#### Phase 2

- 增加 `AA/paymaster` 路径
- 支持 sponsored / userOp / paymaster policy
- 补齐异步提交状态查询

### 9.3 改动范围

- `src/skills/alphaos/runtime/agent-comm/tx-sender.ts`
- `src/skills/alphaos/runtime/agent-comm/entrypoints.ts`
- `src/skills/alphaos/runtime/onchainos-client.ts`
- `src/skills/alphaos/runtime/config.ts`
- `src/skills/alphaos/runtime/network-profile.ts`
- `src/skills/alphaos/runtime/network-profile-probe.ts`
- `src/skills/alphaos/types.ts`
- `src/skills/alphaos/skill.ts`
- `src/skills/alphaos/api/server.ts`
- `src/index.ts`
- `tests/agent-comm-tx-sender.test.ts`
- `tests/onchain-client.test.ts`
- `tests/agent-comm-send-api.test.ts`
- `tests/network-profile.test.ts`

### 9.4 实现要点

#### Phase 1：relay

- 在 `tx-sender.ts` 内抽出提交策略，而不是把 `relay` 逻辑散落到 entrypoint
- 建议引入最小提交模式：
  - `direct`
  - `relay`
- `direct` 保持现状：
  - 本地钱包签名
  - 通过 RPC 直接发交易
- `relay` 最小方案：
  - 本地完成签名
  - 通过 `OnchainOsClient` 新增的 `broadcastSignedTransaction()` 或等价接口，把 raw signed tx 交给 relay / private submit 通道
- 不修改 Agent-Comm message schema
- send result 继续以 `txHash` 为主，不引入新的任务状态机
- status / diagnostics 中补充：
  - 当前 submit mode
  - 最近 submit channel

#### Phase 2：AA/paymaster

- 在 relay 提交抽象之上新增 `aa` 或 `sponsored` 提交模式
- `OnchainOsClient` 新增 userOp / sponsored submit 能力
- `SendResult` 可能需要扩展为：
  - `submissionId`
  - `userOpHash`
  - `txHash?`
- `network-profile` 中把 `aaImplemented`、`paymasterImplemented` 从 `false` 转为真实实现态
- Phase 2 仍然不应把 AA/paymaster 设成默认路径

### 9.5 验证方式

- tx-sender 测试：
  - `direct` 与 `relay` 分支都能持久化 outbound 状态
  - relay 不可用时回退或报错符合设计
- onchain client 测试：
  - raw tx relay submit 成功
  - last submit channel 正确更新
- API / status 测试：
  - status 能看见 submit mode / channel
- network profile 测试：
  - Phase 1 仅标记 relay 可用
  - `aaImplemented` / `paymasterImplemented` 仍保持 false，直到 Phase 2 真正落地

## 10. 推荐落地顺序

### Step 1

先做扩展项一 Phase 1。原因：

- 改动面最集中
- 现有对象已存在，只差 router/runtime 接线
- 最容易形成可演示闭环

### Step 2

并行做扩展项二与扩展项三的 Phase 1。原因：

- 二者都属于“把已有协议壳补成安全闭环”
- 与发送底层改造耦合较低

### Step 3

最后做扩展项四：

- 先 `relay`
- 后 `AA/paymaster`

这样可以避免同时动“控制面、信任面、发送面”三条主链路，降低回归风险。

## 11. 最终建议

如果本轮只做 Phase 1，建议交付范围收敛为：

1. 打通 `probe_onchainos` / `request_mode_change`
2. 完成 `RevocationNotice` 的签发-导入-生效闭环
3. 完成 x402 proof 加密携带与签名真实性校验
4. 仅为协议层增加 `relay` 薄适配，不进入 `AA/paymaster`

这是当前仓库里最符合 KISS、最容易评审、同时又能明显提升 Agent-Comm 完整度的一组增量。
