# Agent-Comm v2 Implementation Summary

**完成时间**: 2026-03-08
**状态**: Core 全部完成 ✅

---

## 概览

Agent-Comm v2 是一次分层升级，在保留 v1 兼容性的基础上实现了：
- 身份工件（ContactCard、TransportBinding）签名验证
- 联系人优先的信任模型
- v2 信封格式 + 双栈运行时
- 完整的迁移路径

---

## Phase 0: Implementation Freeze ✅

| 任务 | 状态 |
|------|------|
| 确认 inbound invite 默认行为 | ✅ |
| 确认 coldInboundNotifyThreshold 规则 | ✅ |
| 冻结 EIP-712 定义 (ContactCard/TransportBinding/RevocationNotice) | ✅ |
| 定义 artifact digest 和指纹计算方式 | ✅ |
| 冻结 v2 envelope 字段契约 | ✅ |
| 冻结迁移规则（additive schema、v1 parser 保留） | ✅ |

---

## Phase 1: Identity Artifacts and Wallet Roles ✅

### Core

| 任务 | 状态 | 关键文件 |
|------|------|----------|
| LIW/ACW 身份模型分离 | ✅ | `local-identity.ts`, `types.ts` |
| 扩展 vault/runtime 初始化支持双钱包 | ✅ | `entrypoints.ts`, `shadow-wallet.ts` |
| 现有单钱包迁移桥接 | ✅ | `local-identity.ts` |
| EIP-712 sign/verify 工具 | ✅ | `artifact-contracts.ts` |
| artifact normalization helpers | ✅ | `artifact-workflow.ts` |
| ContactCard 导出服务 | ✅ | `entrypoints.ts` |
| ContactCard 导入验证（含失败原因） | ✅ | `artifact-workflow.ts` |

### Optional

| 任务 | 状态 | 说明 |
|------|------|------|
| RevocationNotice issuance/import | ❌ | 移至 ADVANCED_TASKS.md |
| Expiry warning surfaces | ✅ 已完成 | `contact-surfaces.ts`, `server.ts` |

---

## Phase 2: Persistence and Contact-Centric Data Model ✅

### Core

| 任务 | 状态 | 关键文件 |
|------|------|----------|
| 扩展 StateStore schema（additive v2 tables） | ✅ | `state-store.ts` |
| 本地身份表（LIW/ACW metadata） | ✅ | `state-store.ts` |
| 联系人表（contactId + identityWallet） | ✅ | `state-store.ts` |
| 签名工件表（artifact type/digest/signer/validity） | ✅ | `state-store.ts` |
| 传输端点表（active/historical receive endpoints） | ✅ | `state-store.ts` |
| 连接事件表（invite/accept/reject/confirm） | ✅ | `state-store.ts` |
| 撤销表 / artifact status 模型 | ✅ | `state-store.ts` |
| agent_messages 扩展 v2 字段 | ✅ | `state-store.ts` |
| 索引（identityWallet/receiveAddress/contactId/msgId/txHash） | ✅ | `state-store.ts` |
| 联系人查询 API（contactId/identityWallet/address/peerId） | ✅ | `state-store.ts` |
| agent_peers → v2 contact backfill | ✅ | `state-store.ts` |

### Optional

| 任务 | 状态 | 说明 |
|------|------|------|
| Retention/pruning rules | ❌ | 移至 ADVANCED_TASKS.md |

---

## Phase 3: Trust, Contacts, and Invite Control Plane ✅

### Core

| 任务 | 状态 | 关键文件 |
|------|------|----------|
| 扩展 command schemas（invite/accept/reject/confirm） | ✅ | `types.ts` |
| capability-profile 处理 | ✅ | `entrypoints.ts`, `types.ts` |
| 联系人状态机（imported/pending_*/trusted/blocked/revoked） | ✅ | `inbox-processor.ts` |
| inbound invite 处理规则 | ✅ | `inbox-processor.ts` |
| rate limiting + message-size guards | ✅ | `inbox-processor.ts` |
| trust outcomes 和 reject reasons 持久化 | ✅ | `inbox-processor.ts` |
| inline card attachment 支持 | ✅ | `inbox-processor.ts` |
| CLI commands（card:export/import, contacts:list, connect:*） | ✅ | `index.ts` |
| HTTP routes（/contacts, /cards, /invites, /connections/*） | ✅ | `server.ts` |
| status/list surfaces 显示 contact-first 状态 | ✅ | `server.ts`, `contact-surfaces.ts` |

### Optional

| 任务 | 状态 | 说明 |
|------|------|------|
| Auto-accept policy toggle | ✅ 已完成 | `config.ts`, `inbox-processor.ts` |
| Recommended capability templates | ✅ | `types.ts` |
| Share/import via QR/short link | ✅ | `entrypoints.ts` |
| Paid cold-inbound notification | ✅ 已完成 | `inbox-processor.ts`, `server.ts` |

---

## Phase 4: Envelope v2, Sender Continuity, and Dual-Stack Runtime ✅

### Core

| 任务 | 状态 | 关键文件 |
|------|------|----------|
| Envelope v2 schemas | ✅ | `types.ts` |
| 版本化编解码层（v1/v2 双栈） | ✅ | `calldata-codec.ts` |
| v2 outer envelope 字段（version/kex/ciphertext） | ✅ | `types.ts` |
| v2 encrypted body 字段（msgId/sender/command/payment/attachments） | ✅ | `types.ts` |
| v2 outbound send 逻辑 | ✅ | `entrypoints.ts`, `tx-sender.ts` |
| v2 inbound 处理（tx.to 验证、recipientKeyId 选择、解密、去重） | ✅ | `inbox-processor.ts` |
| v1 parser 和 nonce-based dedupe 保留 | ✅ | `calldata-codec.ts`, `inbox-processor.ts` |
| 版本协商（最高互版本、v1 fallback） | ✅ | `protocol-negotiation.ts` |
| v1/v2 messages 统一查询 surface | ✅ | `state-store.ts` |
| ACW rotation 时 old-key grace window | ✅ | `local-identity.ts`, `runtime.ts` |

### Optional

| 任务 | 状态 | 说明 |
|------|------|------|
| Richer payment/x402 handling | ❌ | 移至 ADVANCED_TASKS.md |
| Suite-upgrade scaffolding | ❌ | 移至 ADVANCED_TASKS.md |

---

## Phase 5: Backward Compatibility, Migration, and Default Surface Switch ✅

### Core

| 任务 | 状态 | 关键文件 |
|------|------|----------|
| 启动时 backfill（v1 peers → v2 contacts） | ✅ | `state-store.ts` |
| 保留单钱包为临时 LIW+ACW | ✅ | `local-identity.ts` |
| 新安装默认 LIW/ACW 分离 | ✅ | `entrypoints.ts` |
| 保持现有 surfaces 稳定（wallet:init, identity, send, status, messages） | ✅ | `index.ts`, `server.ts` |
| 响应 payload 兼容性（新字段不破坏旧调用） | ✅ | `server.ts` |
| legacy markers（v1-only contacts、fallback sends、manual peer:trust） | ✅ | `server.ts`, `contact-surfaces.ts` |
| wallet:rotate 命令和 API | ✅ | `entrypoints.ts`, `server.ts` |
| 文档默认改为 "add contact" | ✅ | `README.md` |

### Optional

| 任务 | 状态 | 说明 |
|------|------|------|
| Soft-deprecation warnings（v1-only peers） | ✅ | `server.ts` |
| Legacy-usage telemetry thresholds | ✅ | `server.ts` |

---

## Phase 6: Testing, Validation, Docs, and Examples ✅

### Core

| 任务 | 状态 | 关键文件 |
|------|------|----------|
| EIP-712 sign/verify 单元测试 | ✅ | `agent-comm-artifact-contracts.test.ts` |
| artifact digest/fingerprint 测试 | ✅ | `agent-comm-artifact-workflow.test.ts` |
| contact-card import validation 测试 | ✅ | `agent-comm-artifact-workflow.test.ts` |
| state-machine transitions 测试 | ✅ | `agent-comm-inbox-processor.test.ts` |
| version negotiation 测试 | ✅ | `agent-comm-protocol-negotiation.test.ts` |
| v2 codec encode/decode 测试 | ✅ | `agent-comm.test.ts` |
| v2 replay/dedupe 测试 | ✅ | `agent-comm-inbox-processor.test.ts` |
| store migration 测试（fresh/existing/repeated） | ✅ | `state-store.test.ts` |
| runtime 测试（invite accept、business reject、tx.from 验证、grace period、mixed v1/v2） | ✅ | `agent-comm-runtime.test.ts`, `agent-comm-smoke.test.ts` |
| API 测试（contact/card/connection routes + backward compat） | ✅ | `api.test.ts` |
| CLI/entrypoint 测试（card export/import、invite commands、wallet rotate） | ✅ | `agent-comm-entrypoints.test.ts`, `agent-comm-cli.test.ts` |
| E2E smoke tests（v2→v2, v2→v1, v1→v2） | ✅ | `agent-comm-smoke.test.ts` |
| demo scripts 更新 | ✅ | `scripts/` |
| operator/developer docs | ✅ | `docs/` |
| README.md 更新 | ✅ | `README.md` |

---

## 额外完成项（本次开发）

| 任务 | 说明 |
|------|------|
| Auto-accept policy toggle | `COMM_AUTO_ACCEPT_INVITES` 配置，启用时 invite 直接 trusted |
| Paid cold-inbound notification | 陌生人付费消息保存为 `paid_pending`，API 显示待处理数量 |
| Expiry warning surfaces | 检查本地 artifacts，7 天内过期返回警告 |
| Code-simplifier 优化 | 重构 inbox-processor、server 等文件，减少重复代码 |

---

## 测试覆盖

- **Test files**: 31
- **Tests**: 178+
- **覆盖路径**:
  - artifact sign/verify/import/export
  - contact state machine
  - v1/v2 dual-stack runtime
  - API routes
  - CLI commands
  - migration/backfill

---

## 待开发项

详见 `ADVANCED_TASKS.md`:
- Revocation Notice issuance/import
- Retention/pruning rules
- Richer payment/x402 handling
- Suite-upgrade scaffolding