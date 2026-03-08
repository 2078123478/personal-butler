# Agent-Comm 最小复用说明

> Status: legacy/manual compatibility reference. The default v2 operator flow now lives in `docs/AGENT_COMM_V2_OPERATIONS.md`.

这套最小入口只做 4 件事：

1. 初始化通信钱包
2. 查看本机 identity
3. 注册 trusted peer
4. 直接发送 `ping` / `start_discovery`

默认约定：

- 使用 `COMM_WALLET_ALIAS` 作为本地通信钱包别名
- `agent-comm:send` 默认把 `COMM_WALLET_ALIAS` 当作 `senderPeerId`
- 如果你想自定义发送方 `peerId`，发送时用 `--sender-peer-id <peerId>`，对端注册你时也要用同一个值

## 前置环境

### 方式一：X Layer 推荐路径（最快）

```bash
export NETWORK_PROFILE_ID=xlayer-recommended
export VAULT_MASTER_PASSWORD=pass123
# 其他配置（COMM_CHAIN_ID=196, COMM_RPC_URL, COMM_LISTENER_MODE=poll）会自动使用默认值
export COMM_WALLET_ALIAS=agent-comm
```

### 方式二：自定义 EVM 链

```bash
export NETWORK_PROFILE_ID=evm-custom
export VAULT_MASTER_PASSWORD=pass123
export COMM_CHAIN_ID=196
export COMM_RPC_URL=https://your-rpc
export COMM_LISTENER_MODE=poll
export COMM_WALLET_ALIAS=agent-comm
```

**推荐**：新手或快速演示直接用 `xlayer-recommended`，只需设置 `NETWORK_PROFILE_ID` 和 `VAULT_MASTER_PASSWORD` 即可。

## 1. 初始化 comm wallet

生成一个新的通信钱包并写入 vault：

```bash
npm run dev -- agent-comm:wallet:init
```

用已有私钥恢复并写入 vault：

```bash
npm run dev -- agent-comm:wallet:init --private-key 0x<private_key>
```

返回结果会直接给出：

- `address`
- `pubkey`
- `chainId`
- `walletAlias`
- `defaultSenderPeerId`

## 2. 查看 identity

```bash
npm run dev -- agent-comm:identity
```

如果你准备发送时用自定义 `senderPeerId`，可以先按同样值查看：

```bash
npm run dev -- agent-comm:identity --sender-peer-id agent-a
```

## 3. 注册 trusted peer

```bash
npm run dev -- agent-comm:peer:trust peer-b 0x<peer_wallet_address> 0x<peer_pubkey>
```

可选参数：

```bash
--name "Peer B"
--capabilities ping,start_discovery
--metadata '{"team":"demo"}'
```

不传 `--capabilities` 时，默认注册为：

```json
["ping", "start_discovery"]
```

## 4. 发送 ping

```bash
npm run dev -- agent-comm:send ping peer-b --echo hello --note smoke
```

如果要显式指定本次发送使用的本地 `senderPeerId`：

```bash
npm run dev -- agent-comm:send ping peer-b --sender-peer-id agent-a --echo hello
```

## 5. 发送 start_discovery

最小命令：

```bash
npm run dev -- agent-comm:send start_discovery peer-b --strategy-id spread-threshold
```

带可选 discovery 参数：

```bash
npm run dev -- agent-comm:send start_discovery peer-b \
  --strategy-id spread-threshold \
  --pairs ETH/USDC,BTC/USDC \
  --duration-minutes 30 \
  --sample-interval-sec 5 \
  --top-n 10
```

## 双实例最短联调路径

假设有 A / B 两个实例：

1. A 执行 `agent-comm:wallet:init`，B 也执行一次
2. A 执行 `agent-comm:identity`，B 也执行一次
3. A 拿到 B 的 `defaultSenderPeerId/address/pubkey` 后执行 `agent-comm:peer:trust`
4. B 拿到 A 的 `defaultSenderPeerId/address/pubkey` 后执行 `agent-comm:peer:trust`
5. B 启动服务并开启 agent-comm runtime：

```bash
COMM_ENABLED=true COMM_LISTENER_MODE=poll npm run dev
```

6. A 直接发送：

```bash
npm run dev -- agent-comm:send ping <B的peerId>
```

或：

```bash
npm run dev -- agent-comm:send start_discovery <B的peerId> --strategy-id spread-threshold
```

这样就不需要手动操作 vault、peer-registry、tx-sender 等底层模块了。

## HTTP 发送 API

服务端启动后，也可以直接走现有 HTTP API；鉴权方式和其他 `/api/v1/*` 路由一致，仍然是 Bearer token。

发送 `ping`：

```bash
curl -X POST http://127.0.0.1:3000/api/v1/agent-comm/send/ping \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"peerId":"peer-b","echo":"hello","note":"smoke"}'
```

发送 `start_discovery`：

```bash
curl -X POST http://127.0.0.1:3000/api/v1/agent-comm/send/start-discovery \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"peerId":"peer-b","strategyId":"spread-threshold","pairs":["ETH/USDC"],"durationMinutes":30,"sampleIntervalSec":5,"topN":10}'
```
