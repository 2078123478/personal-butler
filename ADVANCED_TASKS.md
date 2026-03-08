# ADVANCED_TASKS.md - Agent-Comm 进阶开发项

**创建时间**: 2026-03-08
**状态**: 待开发（可延后）

本文档记录 Agent-Comm v2 核心交付完成后的可选进阶功能。

---

## 1. Revocation Notice issuance/import

**Phase**: 1 Optional
**工作量**: 🟡 中等

### 场景
撤销某个联系人的信任后，发布 `RevocationNotice` artifact，通知对方和相关方。

### 用例
- 发现某联系人恶意行为，撤销信任并通知网络
- 密钥泄露后，发布撤销通知防止伪造消息

### 实现要点
- 新增 `RevocationNotice` artifact 类型
- 签名逻辑与 ContactCard/TransportBinding 一致
- 导入时验证签名和链上状态
- 撤销后更新联系人状态为 `revoked`

### 涉及文件
- `types.ts` — 新增 artifact 类型定义
- `artifact-workflow.ts` — 签名/验证逻辑
- `inbox-processor.ts` — 处理收到的 RevocationNotice
- `entrypoints.ts` — 发布撤销通知入口

---

## 2. Retention/pruning rules

**Phase**: 2 Optional
**工作量**: 🟡 中等

### 场景
长期运行后数据库积累大量过期 artifacts、历史消息、过期连接事件，需要自动清理。

### 用例
- 设置保留策略：消息保留 90 天
- 过期 artifact 自动删除
- 清理无用的连接事件记录

### 实现要点
- 配置项：`commMessageRetentionDays`、`commArtifactRetentionDays`
- 后台定时任务清理过期数据
- 保留必要的状态（如联系人信任关系）

### 涉及文件
- `config.ts` — 新增保留策略配置
- `state-store.ts` — 新增清理方法
- `runtime.ts` — 后台清理任务

---

## 3. Richer payment/x402 handling

**Phase**: 4 Optional
**工作量**: 🟡 中等

### 场景
扩展 x402 支付字段解析，支持更复杂的支付场景。

### 用例
- 在加密 body 中处理复杂支付证明
- 多资产支付（ETH、USDC、自定义 token）
- 支付验证和结算流程

### 实现要点
- 扩展 `encryptedEnvelopeV2PaymentSchema` 支持更多字段
- 验证支付证明的真实性（链上查询）
- 支持 `x402Mode: "enforce"` 时强制要求支付

### 涉及文件
- `types.ts` — 扩展 payment schema
- `x402-adapter.ts` — 支付验证逻辑
- `inbox-processor.ts` — 处理带支付的消息

---

## 4. Suite-upgrade scaffolding

**Phase**: 4 Optional
**工作量**: 🟢 小

### 场景
预留协议升级接口，支持未来新版本的 kex suite 或协议。

### 用例
- 升级到新的密钥交换算法
- 支持新版本的 envelope 格式
- 协议协商时广告支持的 suite 版本

### 实现要点
- `AGENT_COMM_KEX_SUITE_V3` 等新常量
- 协议协商逻辑支持多版本
- 向后兼容旧版本

### 涉及文件
- `types.ts` — 新 suite 常量和 schema
- `protocol-negotiation.ts` — 多版本协商
- `calldata-codec.ts` — envelope 编解码

---

## 优先级建议

| # | 项目 | 优先级 | 理由 |
|---|------|--------|------|
| 3 | Richer payment/x402 | 高 | 支付是核心价值流 |
| 1 | Revocation Notice | 中 | 安全性需要 |
| 2 | Retention rules | 低 | 长期运维优化 |
| 4 | Suite-upgrade | 低 | 面向未来 |

---

## 已完成的 Optional 项

| # | 项目 | 完成时间 |
|---|------|----------|
| Auto-accept policy toggle | 2026-03-08 | ✅ |
| Paid cold-inbound notification | 2026-03-08 | ✅ |
| Expiry warning surfaces | 2026-03-08 | ✅ |

---

_本文档应在每次完成一项后更新状态。_