# Agent-Comm 隐私与建联便利性分析

这份文档只讨论两件事：

1. 当前设计里，哪些内容还暴露在链上，哪些字段还可以继续加密
2. 如何降低用户与用户之间建立 trusted peer 的门槛，让协议更容易传播和增长

目标不是追求“学术上最强匿名”，而是找到一条 **能落地、能推广、能逐步升级** 的路线。

---

## 一、当前设计已经做到了什么

当前 Agent-Comm 已经具备：

- 链上可达：通过 EVM calldata 发送消息
- 定向接收：链上 `to` + envelope `recipient`
- 内容加密：payload 通过 ECDH + AES-256-GCM 加密
- 身份校验：trusted peer 绑定 `peerId + walletAddress + pubkey`
- 本地执行：接收后进入 command router 执行

这说明它已经具备“可用的最小协议骨架”。

但如果往更广传播、更低摩擦建联、更强隐私去推，当前版本还存在明显短板。

---

## 二、当前暴露面：第三者能看到什么

### 1. 链上交易元数据
无法避免：

- `from`
- `to`
- `txHash`
- 区块时间
- gas 使用情况

这意味着旁观者天然可以建立通信图谱。

### 2. Envelope 明文字段
当前 envelope 里明文暴露了：

- `senderPeerId`
- `senderPubkey`
- `recipient`
- `nonce`
- `timestamp`
- `command.type`
- `schemaVersion`
- `x402`（如果带）

### 3. 由此推导出的信息
第三者可以分析：

- 谁和谁经常通信
- 某个地址是中心服务节点还是边缘客户端
- 在做 `ping` 还是 `start_discovery` 或 `request_mode_change`
- 通信高峰时段
- 业务节奏和行为模式

所以当前版本的隐私属性更准确地说是：

**保内容，不保元数据。**

---

## 三、哪些字段还能继续加密？

下面按“改造收益 / 实施复杂度”分层分析。

---

## 四、优先级 P1：建议尽快加密或弱化的字段

### P1-1. `command.type`
#### 现状
`command.type` 现在是明文。

这会暴露业务意图：
- 是在探测
- 是在启动 discovery
- 还是在请求切换 mode

#### 建议
把 `command.type` 从 envelope 明文移到 ciphertext 内部。

#### 影响
优点：
- 第三者无法直接知道消息类别
- 业务行为轮廓会明显更难分析

代价：
- 接收方必须先解密再决定如何路由
- 但这本来就是自然流程，工程代价不高

#### 建议结论
**应该做，优先级高。**

---

### P1-2. `senderPeerId`
#### 现状
`senderPeerId` 是明文，且往往带业务语义。

如果用户命名成：
- `alice-prod`
- `vip-client-zhangsan`
- `xiaoyin-main`

隐私泄露会非常直接。

#### 建议
有两种方案：

##### 方案 A：链上只放随机 peer handle
例如：
- `p_8f21c9`
- `peer_6b72f1`

真正的人类友好名字只保存在本地联系人簿里。

##### 方案 B：彻底移出明文 envelope
把 sender logical id 也放进 ciphertext，链上只保留：
- sender wallet address（来自 tx.from）
- sender pubkey（如果必须）

接收方本地再根据 `from + pubkey` 做映射。

#### 建议结论
短期先做 **方案 A**，长期可以升级到 **方案 B**。

---

### P1-3. `x402` 明文结构
#### 现状
如果以后真的把支付证明、报价、用量等塞进 `x402` 字段，而且还是明文，那会泄露交易关系和商业模型。

#### 建议
- 链上只留必要最小支付凭证引用
- 详细支付证明放到 ciphertext 或链下交换

#### 建议结论
**不要让 x402 承担“展示型业务字段”的职责。**

---

## 五、优先级 P2：可以优化，但要权衡复杂度

### P2-1. `recipient` 是否还需要重复明文写入 envelope
#### 现状
交易本身已经有 `to`，envelope 里又有 `recipient`。

这在安全上是双重校验，但也让解析者更容易做批量分析。

#### 选择
##### 保留
优点：
- 安全边界更清楚
- 避免 envelope 内容和 tx.to 不一致

##### 去掉
优点：
- 少暴露一份收件人字段

#### 建议结论
**短期保留。**
它带来的安全/调试收益大于这点额外暴露。

---

### P2-2. `timestamp`
#### 现状
链本身已有出块时间，envelope 里再放 timestamp 会增加时间侧信道。

#### 建议
- 如果只是用于本地排序和审计，链上可不放
- 或只放 coarse-grained time bucket

#### 建议结论
可优化，但不是第一优先级。

---

### P2-3. `senderPubkey`
#### 现状
它用于 ECDH 和身份校验。

#### 问题
公钥长期稳定，会帮助旁观者做跨消息聚类。

#### 建议
中期考虑引入：
- 会话级临时公钥（ephemeral pubkey）
- 静态身份签发临时会话密钥

这样可把“长期身份”和“单次通信密钥”拆开。

#### 建议结论
价值很高，但复杂度明显更高，适合第二阶段演进。

---

## 六、优先级 P3：更强隐私路线（适合后续版本）

### P3-1. 全部命令描述放进密文
链上 envelope 只保留：
- version
- recipient / routing 最小字段
- ciphertext
- proof / signature

这样第三者几乎只能看出“有一条加密消息”，看不出消息种类。

### P3-2. 引入 session 层
建立长期信任后，不再每条消息都暴露静态公钥组合，而是：
- 建立 session
- session 内滚动密钥
- 会话结束可旋转

这样元数据聚类难度会更高。

### P3-3. 通过中继 / mailbox 合约 / stealth address 减少关系暴露
这能进一步弱化固定 `from -> to` 图谱。

但代价是：
- 合约复杂
- 成本增加
- 用户理解成本变高

不适合作为第一阶段传播方案。

---

## 七、建联便利性为什么很关键

如果协议只追求“密码学上很优雅”，但建联流程很麻烦，就很难扩散。

传播爆发靠的不是“最强协议”，而是：

- 新用户能 3 分钟上手
- 不容易配错
- 一次建联后能长期复用
- 用户知道自己在和谁通信

所以“信任建立的便利性”对增长非常关键。

---

## 八、当前建联的痛点

现在的最小流程是：

1. 初始化钱包
2. 查看 identity
3. 手动交换 address + pubkey + peerId
4. 双方各自 `peer:trust`
5. 注意 senderPeerId 必须一致
6. 再启动 runtime 和发送消息

这套流程的问题是：

- 手动步骤多
- 人容易填错
- `peerId` 和 `senderPeerId` 不一致很容易踩坑
- 对普通用户来说太像“工程调试”，不像“添加联系人”

---

## 九、如何提升 trusted peer 建立的便利性

下面按落地优先级给建议。

---

## 十、优先级 T1：先把“加联系人”产品化

### T1-1. 生成一份标准 identity card
每个节点可以导出一张标准名片：

```json
{
  "version": 1,
  "displayName": "Xiaoyin",
  "peerId": "peer-a",
  "walletAddress": "0x...",
  "pubkey": "0x...",
  "capabilities": ["ping", "start_discovery"],
  "networkProfile": "xlayer-recommended",
  "signature": "..."
}
```

然后支持：
- 导出 JSON
- 导出二维码
- 导出短链接

这样“建联”就变成了“交换名片”。

#### 价值
- 直观
- 少输错
- 适合分享和传播

#### 建议结论
**应该优先做。**

---

### T1-2. 一键 trust import
支持：

```bash
agent-comm:peer:trust-import ./peer-card.json
```

或者：

```bash
agent-comm:peer:trust-import 'base64/https payload'
```

这样用户不需要手动复制：
- peerId
- address
- pubkey

#### 建议结论
**应该优先做。**

---

### T1-3. 显式区分两个概念
当前最容易混淆的是：

- 对端逻辑名 `peerId`
- 我发送时使用的 `senderPeerId`

建议产品化成：

- **我的公开身份 ID**
- **联系人 ID**

默认情况下发送总是使用“我的公开身份 ID”，不要再让用户轻易踩到 senderPeerId 不一致的坑。

#### 建议结论
**需要在 UX 层收口，而不是继续暴露底层概念。**

---

## 十一、优先级 T2：把建联从“手工录入”升级成“握手”

### T2-1. 邀请码 / 配对链接
可以支持：

- A 生成邀请
- B 导入邀请
- B 自动回发自己的 identity card
- A 一键确认 trust

流程类似：

1. A 分享邀请链接 / 二维码
2. B 扫码导入
3. A 确认联系人
4. 双方自动建立 trust

这会比“交换三元组再双边录入”顺滑很多。

---

### T2-2. 双向确认握手
现在只要本地 trust 对方就能接受消息。

更适合产品化的方式是：

- 单向：我加了你，但你未确认
- 双向：双方确认，进入 active trusted state

这样更像“联系人请求”，更符合普通用户心智。

---

### T2-3. QR 建联
对移动端尤其有用：

- 展示 identity card QR
- 扫码导入
- 自动校验签名
- 自动完成 trust import

这对传播非常有帮助，因为它极大降低“第一次加人”的门槛。

---

## 十二、优先级 T3：把长期身份和会话身份拆开

### T3-1. 长期 identity wallet
作为“我的账号”长期存在：
- 稳定地址
- 稳定身份名片
- 稳定联系人关系

### T3-2. 会话 / 子身份钱包
在某些场景可派生：
- 项目级身份
- 一次性会话身份
- 隐私增强身份

这样既能保留传播中的“稳定账号感”，又能给高级用户更多隐私选项。

---

## 十三、最适合传播的演进路线

如果目标是“更容易传播爆发”，我建议按这条顺序推进：

### 第一阶段：先把建联做顺
1. 长期身份钱包持久化
2. identity card 导出
3. trust-import
4. senderPeerId UX 收口
5. 安全版 demo / setup 脚本

### 第二阶段：减少明显元数据暴露
6. 把 `command.type` 挪入 ciphertext
7. peerId 去语义化 / 别名本地化
8. x402 只留最小公开字段

### 第三阶段：高级隐私能力
9. 临时公钥 / session key
10. 双向握手与会话层
11. stealth / mailbox / relay 方案评估

这条路线的好处是：

- 第一阶段马上提升可用性和传播性
- 第二阶段提升隐私但不大改架构
- 第三阶段再考虑更重的协议升级

---

## 十四、我的建议结论

### 结论 1：短期最该做的不是“最强加密”，而是“最稳的身份与建联体验”
因为传播首先死在“不会配、容易配错”。

### 结论 2：隐私上最先该收掉的是 `command.type` 明文
这是收益高、改造成本相对可控的一步。

### 结论 3：长期身份钱包必须从 demo 钱包里独立出来
否则所有增长都会被身份漂移和联系人失效抵消。

### 结论 4：identity card + 一键 trust import 会显著提高传播效率
它能把“工程配置”变成“交换联系人”。

---

## 十五、建议的下一批实施项

如果继续推进，我建议下一批任务是：

1. `AGENT_COMM_IDENTITY_CARD.md` —— 定义标准身份名片格式
2. `agent-comm:identity:export` —— 导出名片 JSON / 二维码载荷
3. `agent-comm:peer:trust-import` —— 一键导入联系人
4. v2 envelope 设计 —— 把 `command.type` 移入 ciphertext
5. 长期 identity wallet 规范 —— 区分 persistent identity 与 demo/session wallet

---

## 相关阅读

- `docs/AGENT_COMM_EXPLAINED.md`
- `docs/AGENT_COMM_MIN_REUSE.md`
- `README.md`
