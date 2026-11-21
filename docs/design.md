# Orca Pod 设计

> Status: 当前设计，与代码一致
> Scope: 2–10 台安装了 DSH 的机器（Windows/Linux），对等派发任务与结果回报

## 1. 定位

每台机器装一个 DSH 插件（npm 包 `dsh-plugin-orca-pod`），它在该机器上跑一个 **orca node**：对外是 A2A server + 控制面，对内驱动本机 DSH 执行任务。节点之间构成 full mesh，任务由 origin 派给 target，结果按 id 交回。

### 1.1 目标

1. 任一节点能向任一其他节点派任务，并取回状态与结论。
2. 对等：没有永久中心调度器；每个节点既是 server 也是 client。
3. 支持 2–10 台机器；full mesh 在这个规模可控。
4. 新节点用「任一已知节点的 host:port + workgroup 密码」加入，几个心跳周期内自动补全 mesh。
5. 任务异步：提交即返回 task id，进度与结论靠轮询。
6. 节点上下线可观测；掉线后不再向它派新任务。
7. 跨 workgroup 隔离。
8. 执行器是本机实现细节（默认 ACP；测试用脚本执行器），不改变集群协议。
9. 跨 Windows/Linux，不依赖某台机器的路径或 DSH profile。
10. 节点自述 OS/CPU/内存/Node 版本/可用模型与忙闲。
11. 同一 workgroup 的任务共享持久工作区，后续任务能接着现场的上下文干。

### 1.2 非目标

不做共享会话/上下文、exactly-once 与自动重发、跨 workgroup 联邦、ring/gossip/中心调度、epoch/incarnation/全局成员表、target 侧弹窗审批、共享文件系统（SMB/NFS/9p）、空密码、session token、把 ACP/MCP 或 DSH 内部 `/api` 当集群协议、CA/证书轮换/mTLS、发布式目录、多任务并发、持久审计、指标与 SSE。

### 1.3 术语

| 术语 | 含义 |
| --- | --- |
| **orca node** | mesh 里的一台机器（一个 `orca_node_id`；同一台机器的所有 DSH profile 共用）。不写裸的「节点」，避免与 Node.js 混淆。 |
| **workgroup_id** | 集群命名空间 + 凭证作用域，正则 `[a-z0-9][a-z0-9-]{1,31}`；改名 = 新建组。 |
| **orca_node_id** | 节点 Ed25519 公钥的 base58（32 字节，通常 43–44 字符）。即身份。 |
| **workspace** | 目标节点上按 workgroup 自动分配的持久执行目录；不是 DSH GUI 的「工作区」。 |
| **session** | ACP 会话，绑定 `(origin, context_id)`，存在 `<data_root>/state/<workgroup_id>/sessions.json`。 |
| **context_id** | A2A 逻辑会话 id，把多个 task 归到同一串工作里。 |
| **SelfRecord** | 节点对自己的描述（endpoints、runtime、忙闲、模型目录），只有本人能写。 |
| **members_digest** | 排序后的成员摘要，用于「我落后了没有」的比对，不表达在线。 |
| **candidate** | 从别人目录学到、尚未直接握手过的 `(id, endpoints)`，只是候选，不是在线声明。 |
| **tombstone** | 本地的「别再试它」标记，带过期时间，不传播。 |

## 2. 身份与组网

### 2.1 节点身份

- 首次启动时在 DSH 凭据库生成 Ed25519 密钥对，私钥 32 字节种子以 base58 存为 `credentialKey('orca-pod', 'node')` → `{ kind: 'grant', payload: { ed25519 } }`；写入在 `withFileLock` 下原子完成，两个进程同时首启也只会得到同一个身份。
- `orca_node_id` = 公钥的 base58（Bitcoin 字母表 `[1-9A-HJ-NP-Za-km-z]`，解码必须正好 32 字节）。base58 一一对应，同一把公钥只有一种写法。
- 记录存在但解析不出合法私钥时启动失败并点名，**不会**悄悄生成新身份。换身份 = 删记录并重启（面板的「完全重置」同时清密码与设置）。
- 显示：日志与缺省显示名用缩略 `前6…后4`，面板空间紧时 `前4…后4`，悬停看全称。`display_name` 只影响显示，`orca_node_id` 不可改。
- 节点只以插件形态运行；一台机器一个节点，端口就是锁——第二个 DSH 进程里的节点启动失败并报 `an orca node is already running on this machine, in another DSH process`。

### 2.2 workgroup 与密码

- 密码必填、不可为空（空密码等于没有准入控制），建议 ≥12 字符；面板向导强制填写。
- 密钥派生（只在内存里，每次启动付一次代价）：

```text
k = scrypt(password, salt = "orca-pod\0" + workgroup_id, N = 2^15, r = 8, p = 1, len = 32)
```

- 机密只在 DSH 凭据库：密码引用 `ORCA_POD_PASSWORD`（没有时回落启动环境变量与 `.env`）；节点私钥是上面的记录。`<data_root>`（`$DSH_HOME/orca-pod`）里没有机密，只有 `settings.json`、SQLite、工作区与 `state/`。面板永不返回密码。
- 换密码 = 重建组：改过的节点用新密码重启，旧成员在**下一个请求**的 workgroup 证明上被拒（`401 bad_proof`），双方互相丢弃；没有双密码过渡，也没有集中踢人。**密码就是成员资格**。

### 2.3 自述记录（SelfRecord）

`hello` 请求与答复里的 `self`，也是 `orca_pod` 的 `members` 与面板成员列表的内容：

```json
{
  "orca_node_id": "<base58 公钥>",
  "display_name": "书房台式机",
  "endpoints": ["https://192.168.1.11:11811", "https://desk.example.com"],
  "workgroup_id": "orca-dev",
  "runtime": {
    "os": { "family": "win32", "name": "Windows", "version": "10.0.26100" },
    "arch": "x64",
    "cpu": { "model": "AMD Ryzen 9 7950X 16-Core Processor", "logical_cores": 32 },
    "memory": { "total_bytes": 68719476736 },
    "node": { "version": "v26.13.0" },
    "captured_at": "2026-11-14T04:36:33Z"
  },
  "runtime_digest": "<sha256 hex>",
  "state": "online",
  "busy": null,
  "last_recv_at": "2026-11-14T04:36:33Z",
  "max_task_ttl_s": 3600,
  "models": [{ "provider": "deepseek", "id": "deepseek-flash", "name": "DeepSeek Flash" }],
  "default_model": { "provider": "deepseek", "model": "deepseek-flash" },
  "default_reasoning_effort": "max"
}
```

- `runtime` 只出现在签名接口里；`state`、`last_recv_at` 是接收方的本地观测，不是对方声明（自己记录里恒为 `online`）。
- `busy` 为 `null` 或 `{ task_id, origin_orca_node, since }`，本人写、随心跳刷新。
- `max_task_ttl_s` 是本机单任务硬预算（默认 3600s），origin 据此拆任务。
- `models` 是 `[{provider, id, name, description?}]`（去重、上限 128），`default_model` 是 DSH 的 `ModelSelection` 或 `null`，`default_reasoning_effort` 可为 `null`。目录与默认模型**不是设置**，而是 DSH Host 报告的：插件通过 `llm` 服务枚举模型、从 `agentDefaultModel.currentSelection()` 取默认；设置里只剩 `default_reasoning_effort`（优先于 Host 的 effort）。它们只对同组成员可见。
- `endpoints` 是 1–8 个 https URL 的有序列表（去重去尾斜杠），第一个是 primary；顺序即拨号优先级，成功的地址下一轮排最前。监听地址由 `bind_host` 决定；`endpoints` 为空时按监听地址推导（`0.0.0.0`/`::` 时枚举本机非 internal 地址，IPv4 在前，跳过 `fe80:`）。
- runtime 采集一次（`os`/`process`，无外部命令）；`runtime_digest` = sha256(os.family|os.name|os.version|arch|cpu.model|逻辑核数|memory.total|node.version)。
- 刷新：心跳就是 `hello`，带 `busy`、摘要与完整 `self`；`members_digest` = sha256(排序后的 `id|endpoints|runtime_digest` 行，含自己)。摘要不一致时对端回整张目录（仅作候选）。记录只有本人能写——**其他节点绝不改写某条记录，也不替它声明在线**。

### 2.4 接触（hello）

接触与保活是同一个请求，区别只是有没有可比对摘要、签名里有没有接收方 id：

```text
D（新）                                          A（已在 mesh）
  POST https://A:11811/cluster/hello
  Authorization: Pod id=D; wg=<workgroup>; ts; nonce; sig=<Ed25519>; proof=<HMAC>   （首次没有 target）
  { self: {...}, busy, digest }
                                            ├ 验两样证明、时间窗、nonce
                                            ├ 筛查 D 声明的端点
                                            └ 登记或刷新 D（在线）
  200 { self: A, members_digest, members: [A 已知的其他成员] | null }
  Pod-Reply: id=A; sig=<对 请求 nonce | status | body 的签名>
```

- **hello 即登记**：证明已说明发送者在组内，不需要先 join；被对方修剪了也没关系，下一个 `hello` 自己重新登记。
- 只有种子地址能碰陌生人：设置里的 `peers`、记住的 peers、`connect` 工具、面板。别人目录里的地址只能当候选，拨之前照旧筛查。
- 方向恒为单向出站；不广播、不 gossip：新节点自己去找目录里的每个人，这本身就传播了「我在」。
- 幂等；密码正确即接受，没有待批准状态。拒绝：`400 workgroup_mismatch`、`401 bad_proof`、`401 bad_signature`、`401 clock_skew`、`401 nonce_replay`。
- 答复必须由接收方签名并绑定请求 nonce，否则 `peer_error`。

### 2.5 心跳与看门狗

判定在线不是「我能不能连上它」，而是「我最近有没有收到它」。每个 peer 维护两条时间线：`last_recv_at`（收到 hello 或它的应答）与 `fails`（连续失败）。心跳就是对每个到期 peer 发一个 `hello`。

- 自适应节奏：`interval = N` 秒，`N` 是组成员数（含自己），夹在 2–10s，±10% 抖动。每节点每秒约 1 个请求，全集群 ≈ `N` req/s。
- 参数：`suspect_after = interval × 1.25`，`offline_after = interval × 3`，`recover_probe = 15s → 30s` 翻倍退避，`record_ttl = 7d`，`tombstone = 10min`。
- 超时用单调时钟；墙上时钟只用于显示与 `ts` 校验（±60s，超过以 `clock_skew` 拒绝）。
- 状态机：`unknown → online`（收到 hello 或对方应答）；`online → suspect(quiet)`（静默超过 suspect_after）或 `suspect(unreachable)`（发送连续失败但仍收到）；`suspect(quiet) → offline`（累计静默超过 offline_after）；`offline → online`（低频探测成功）；`offline → 修剪 + 墓碑`（record_ttl）。
- 只有 `online` 接受新任务（否则 `peer_not_online`）；`suspect`/`offline` 不派新任务，但不取消在跑的任务。面板把 suspect(unreachable) 标「网络受阻」，与「它挂了」是相反方向的故障。
- 「收到」分两种证据：对方主动发来的 hello 只刷新自述与 `last_recv_at`；只有对方**应答**了我方请求才清零失败计数并回到 online。否则 NAT 后的节点每拍主动来一次 hello 会被反复抹回 online。

### 2.6 候选端点、收敛与墓碑

- 目录里的条目只是候选：未知 id 进表为 `candidate`，拨号前先做地址筛查；对方收到我的 hello 就登记我，它的答复到达后在我这里转 online。连续 5 次拨不通就删记录并留墓碑——别人的记忆不是一直拨它的理由。
- 目录只转发**亲耳听到的**成员（本机与 online/suspect），候选与 offline 记录留在本机表里但不转发；死节点最多 `offline_after` 后不再被转发，「A、C 互相把 D 传来传去」的回声从源头断掉。
- 已知但 offline 不复活，只按 recover_probe 退避探测；修剪后本地留墓碑，墓碑只挡他人目录，不挡本人——复活后自己的 hello 会清除墓碑。
- 合并按 id 去重、只新增从未见过的节点，绝不修补已有记录；冲突以本人最近一次签名自述为准；删除只删本地，不通知别人。
- **踢人 = 换密码**：没有共识，没有可广播的移除操作。UI 必须写清「forget 不等于安全」。

### 2.7 故障、恢复、离开

- 网络抖动：suspect 可恢复；新任务暂停路由，在跑的任务继续。
- 单向不通：suspect(unreachable)，提示查防火墙/端口或改用 VPN；典型是 NAT 后的家宽节点与公网服务器。
- 机器休眠：单调时钟判定，唤醒后按正常看门狗恢复。脑裂不存在：没有主节点、没有多数派状态。
- 改 id：以新身份 hello，旧记录按看门狗变 offline，靠 record_ttl 消失。
- **没有「离开」请求**（D53）：持有 workgroup key 的节点怎么声明离开都会被下一次 hello 带回来。离开 = 改 workgroup 或密码（下一次证明被拒，当即删除并记墓碑），或面板重置。

## 3. 传输与接口

### 3.1 监听

- 只监听 **HTTPS（TLS 1.3 上的 HTTP/1.1）**，端口 `11811`（可配，避开 Windows Hyper-V/WSL 预留的 40000–41890 段），默认绑 `127.0.0.1`；要对外必须在面板显式选 LAN 地址或 `::`。
- 不开 HTTP/2、不开 UNIX socket；出站按节点复用 TLS 连接。
- 端口冲突就启动失败，不静默改端口。端口 `0` 由系统分配，但启动会拒绝 WHATWG fetch 的禁用端口（`6000`、`6665–6669` 等），否则对端 `fetch` 直接 `bad port`。
- TLS 内建：证书是节点用身份私钥现签的 X.509 v3（Ed25519，十年，不落盘），每次启动一张；拨号方按节点 id 钉扎。本机进程访问 `/local/*` 也走 HTTPS。`http://` 地址（旧设置）一律按 `https://` 读。

### 3.2 路由与准入

每条路由注册时声明 `config.access`，缺了启动失败；一个 `preValidation` 钩子统一验证两样证明并签名答复。

| access | 谁能调用 |
| --- | --- |
| `public` | 任何人 |
| `hello` | 两样证明都对；签名可不带接收方 id（首次接触） |
| `member` | 两样证明都对、且签名绑定的接收方是本节点；不查成员表 |
| `local` | 本机持有节点令牌的进程（执行器给任务会话的 `X-Orca-Local` 头），连接必须来自本机，否则 `403 not_local` |

| Method | Path | 用途 | access |
| --- | --- | --- | --- |
| GET | `/health` | `{status:"ok", orca_node_id}` | public |
| POST | `/a2a` | A2A：`message/send`、`tasks/get`、`tasks/cancel` | member |
| GET | `/blobs/{blob_id}` | 下载本节点发布的文件 | member |
| POST | `/local/blobs` | 登记本机文件（任务会话） | local |
| GET | `/local/blobs/{node}/{blob_id}` | 任务会话取本机节点登记的文件 | local |
| POST | `/cluster/hello` | 接触与心跳 | hello |

- `/orca-api`（面板）不是网关路由：它由 DSH web server 的同源桥承接，准入交给 `ctx.connection.admit`（Host/Origin + 浏览器会话 cookie），只放行 owner；另需 `X-Orca-Pod` 头（`403 cross_origin`），非 GET 且无 JSON `Content-Type` 为 `403 json_required`。
- 请求体上限全局 **1 MiB**（认证发生在 body 解析后、schema 校验前），没有路由放宽；文件只经 GET 流式下发。不提供 WebSocket/SSE。
- 公开面只有 `/health`；没有 Agent Card，也没有匿名目录。`display_name`、endpoints、runtime、忙闲、模型目录只在签名交换里。

### 3.3 请求签名与答复

```text
请求  Authorization: Pod id=<发起方>; wg=<workgroup_id>; target=<接收方|空>; ts=…; nonce=…;
                        sig=<Ed25519(输入)>; proof=<HMAC-SHA256(workgroup key, 输入)>
      输入 = "orca-pod/request" | 方法 | target | 路径+查询 | sha256(body) | ts | nonce | workgroup_id

答复  Pod-Reply: id=<应答方>; sig=<Ed25519("orca-pod/reply" | 请求 nonce | status | sha256(body))>
```

校验顺序：解析头（`missing_auth`/`malformed_auth`）→ `ts` 在 ±60s 内且不早于进程启动（`clock_skew`/`stale_request`）→ `target` 是本节点（hello 例外，`wrong_target`）→ `workgroup_mismatch` → 验 `sig`（`bad_signature`）→ 验 `proof`（`bad_proof`，在验签之后）→ nonce 5 分钟窗口内未出现过（进程内 LRU，容量 10k，`nonce_replay`）。没有「查成员表」这一步。

文件下载的答复是流，签名只覆盖 status 与 `blob_id`（`subject = blob:<blob_id>`），收完按内容 sha256 校验。

### 3.4 错误

统一 `{ "code", "message" }`，HTTP 状态来自 `src/core/errors.ts` 的 code→状态表：

| 状态 | 错误码 |
| --- | --- |
| 401 | `missing_auth`、`malformed_auth`、`clock_skew`、`nonce_replay`、`bad_signature`、`wrong_target`、`stale_request`、`bad_proof` |
| 403 | `not_task_origin`、`not_local`、`path_outside_workspace` |
| 400 | `bad_request`、`unsupported`、`workgroup_mismatch`、`endpoint_refused` |
| 404 | `task_not_found`、`blob_not_found`、`unknown_orca_node` |
| 409 | `permission_denied` |
| 410 | `blob_expired`、`blob_file_missing` |
| 413 | `body_too_large` |
| 429 | `orca_node_busy`（带 `retry_after_s: 30`、`holder` 与 `Retry-After`） |
| 500 | `internal` |
| 502 | `peer_error` |
| 507 | `quota_exceeded` |

`/a2a` 上同样的错误包成 JSON-RPC 错误（`code: -32000`）。出站调用本机抛出的 `unknown_peer`(404)、`peer_not_online`(503)、`peer_error`(502)、`peer_timeout`(504) 不在线上。

### 3.5 A2A 方法

- `message/send`：提交，返回 `Task`。`message.taskId` 为空时新建（`submitted → working`）；非空是恢复：任务必须在 `input-required`（否则 400），调用者必须是 origin（否则 403），恢复要重新拿执行槽（被占回 429，由上游决定何时重试）。
- `tasks/get`：按 id 取状态与结论；任何成员可读。
- `tasks/cancel`：只有 origin（或本机自己）能取消，否则 403；终态原样返回。

传输是同步 HTTP，任务语义异步：`message/send` 不挂到任务结束，完成靠轮询。`input-required` 是任务状态，不是推送；origin 停轮询后恢复，`tasks/get` 仍能拿到同一份 `permission_request`。

出站只有一个客户端（`src/mesh/peer-client.ts`）：负责签名、截止时间（默认 30s，可调 `request_timeout_ms`）与读取上限（4 MiB），不知道有哪些节点；对端地址由节点对象决定。按节点寻址，不做隐式接触：`peer` 是节点 id、唯一显示名或宣告过的 URL，统一走 `mesh.resolve`；陌生 URL 在本机抛 `unknown_peer`，请求不发出。只有 `sendTask` 新建 origin 派发日志。

### 3.6 任务状态机

```text
submitted ──► working ──► input-required ──► working
                 │
                 ├──► completed
                 ├──► failed
                 └──► canceled
```

- `input-required` 不占执行槽：挂起时槽位释放，恢复时重新竞争，不预留、不排队。
- 恢复 ACP 任务复用同一个 session（没有退出）。
- 任务只有一跳，所以没有调用链与回调祖先。
- 终态不可逆；重试 = 显式再派新 task。
- 每次变迁写 SQLite；进程重启时所有非终态 task 标 `failed(node_restart)`。

### 3.7 反向代理与公网

代理可选：节点自己就加密。挂在代理后面时，拨号方见到 CA 证书，按域名校验接受；上游是 HTTPS（自签，proxy 跳过校验），请求与答复的签名仍端到端有效。

- 不给 `/cluster/hello` 加缓存；代理保持 keep-alive 到上游。
- 不读 `X-Forwarded-*` 做鉴权或判断本机；带转发头的请求不算本机。
- 节点互通靠 `hello` 里自报的 `endpoints`，不靠来源 IP：反代部署必须把公网 URL 配进 endpoints。
- 公网暴露前确认：强密码；本机 `permission_mode` 上限；直接暴露时节点自己加密、挂代理时只绑 loopback；`/health` 不泄漏拓扑；限流/失败计数放代理层；接受「同组任一节点可凭密码派任务」。

## 4. 任务

### 4.1 元数据

`message/send` 的 `params.metadata.pod`：

```json
{
  "pod": {
    "permission_mode": "workspace-write",
    "model": { "provider": "deepseek", "model": "deepseek-flash", "reasoningEffort": "high" },
    "reasoning_effort": "high"
  }
}
```

- `task_id` 由 target 生成（ULID：48 位毫秒时间戳 + 80 位随机，26 字符，按时间排序，不可枚举）；origin 在派发日志记 `(peer, task_id)`。
- **origin 是请求的签名者**，不由元数据声明；`context_id` 缺省等于 task id。
- `permission_mode` 缺省 `read-only`，本机上限再取较窄（见 §6.4）；非法值 → 400。
- `model` / `reasoning_effort` 可选；选不到 → `failed(model_unavailable)`，不退回默认。
- `task_timeout_s`（默认 3600）是执行侧硬预算，origin 不能指定；`input-required` 期间暂停。
- 元数据是不可信输入：`TaskMetadataSchema` 解析，`pod` 块不合法直接 400，不建任务。

### 4.2 回报与唤醒

```text
origin: message/send → task_id，写派发日志，立即返回
origin: tracker 每 1s 拉一次 tasks/get
target: 推进状态，每步写 SQLite
origin: 终态 → 合并成一条 notice 交还发起会话 → 停止轮询
```

- **轮询归 Host，不归 agent**：agent 只看到薄工具 `orca_pod`（`send`/`status`/`cancel`/`members`/`connect`；任务进程里只有 `fetch`/`publish`）。**没有等待方法**，也没有 approve/deny 方法。
- tracker：固定 1s、自调度、不重叠；工作集是派发日志里未结束且记着节点的条目。瞬时失败（超时/网络/5xx/节点不在线）按 1s 起翻倍、上限 30s 重试；连续 5 次记 `failed`（`last_error`）并告知 agent「读不到，停止跟踪」。确定性失败（404、节点已不在表、401/403）第一次就记 failed。终态照常通知；`BLOCKED` 开头的 completed 标「completed with a blocker report」。
- **权限请求不产生聊天 notice**，也不唤醒 agent；tracker 留着等 UI 作答。
- 与会话无关（D45）：轮询只看派发日志，不看宿主开着哪些会话；交付 notice 时才按 `agent_id` 找会话，找不到就不通知（结果留在派发日志与面板）。
- notice 是 `source.kind = "orca-pod"` 的 user 角色消息：`[orca-pod] task <id> on <peer> is completed; …`，远端结论放在 `<untrusted-remote-result>` 块里并截断到 800 字符。

状态回到会话：

| 会话状态 | 手段 | 效果 |
| --- | --- | --- |
| 仍在 running | `agent.inject()`，清零唤醒计数 | 落 `agent/inbox/spliced`，等下一步读到，不打断本轮 |
| idle，连续唤醒 <3 | `agent.followup()`，计数 +1 | 开新一轮，不伪造 user 气泡 |
| idle，已连续 3 次 | `agent.inject()` | 留在 inbox，不再叫醒；用户说话后重置预算 |
| 随时 | `orca_pod` 的 `status` | 直接读目标侧状态，与会话历史无关 |

2s 窗口内的多个终态按会话合并成一条 notice、一次 followup。`followup()` 只对仍活着的 session 有效；会话日志仍是唯一事实源，`status` 随时可重放。

### 4.3 取消

`tasks/cancel` 必须传到执行器：ACP 发 `session/cancel`，2s 宽限后如果该 session 仍是连接上正在跑的那个，才关连接、终止子进程树（避免误杀复用了同一连接的下一个任务）。取消后任务置 `canceled`；挂着的权限请求作废。终态任务原样返回。

只有 task 的 origin（及本机自己）能取消，其他成员 `403 not_task_origin`——同组不等于能互杀任务。

### 4.4 任务存储

- 单机 SQLite：`<data_root>/tasks.db`，Node 内置 `node:sqlite`，WAL，`synchronous=NORMAL`，一个进程独占写，不做连接池/服务。
- 表：`tasks`、`dispatches` 同构 `(task_id TEXT PRIMARY KEY, payload TEXT, updated_at TEXT)`；`file_blobs` 为 `(blob_id TEXT PRIMARY KEY, path TEXT, size INTEGER, expires_at TEXT)`。任务表存 `TaskView`；`updated_at` 取 `status.timestamp`。
- 每次状态变迁写库；`tasks/get` 先查内存再回落 SQLite。进程启动时非终态 task 标 `failed(node_restart)`。备份 = 拷贝 db（WAL 先 checkpoint）；落盘失败只记 warning。
- 可见性：只有 task 的 origin（和运行它的本机）能读，**task_id 不再是同组通行证**（0.2.0 起，§6.5）；没有列表接口。origin 额外拥有恢复与取消权。同组仍是信任域，没有 per-task ACL。

### 4.5 文件通道（blob）

文件不走 JSON 内联、不在节点间推送：**节点只发布自己机器上的文件，谁需要谁拉**。文件不是任务的一部分（D46）：把名字写进任务文本或结论。

- 名字是 `<orca_node_id>/<sha256>`，不含地址。发布方把文件**复制**进 `<data_root>/blobs/<sha256>`（临时文件 + 边写边算哈希 + 改名），`file_blobs` 记映射；登记默认 7 天过期（`ttl_s=0` 永不过期）；同样的字节再登记沿用已有副本，过期时间取较晚。节点启动时清扫一次，之后每小时一次；过期 `410 blob_expired`，副本没了 `410 blob_file_missing`，没登记 `404 blob_not_found`。
- 获取：`mesh.get(发布方).fetchBlob(blob_id)`。发布方是自己就直接读盘；别人按拨号顺序逐个地址试，对方一旦作答（含 404）以它为准，全都连不上 → `503 peer_not_online`，不是成员 → `404 unknown_orca_node`。流式下载不受 4 MiB 响应上限约束；写 `.part` 边写边算 sha256，一致才改名，不一致删掉报错。
- `fetch` 的 `output` 必须在会话沙箱可写范围内；read-only 会话写不了任何地方，需要收文件的任务要以 `workspace-write` 派出。
- 登记只在本机发生：宿主工具在进程内直写；任务里的工具走 `local` 路由（令牌要对、连接必须来自本机，否则 `403 not_local`）。节点不接收别人的字节，没有上传路由。
- 读取要成员签名；没有可转交组外的无签名链接。不做 per-blob ACL，不可枚举，不做目录/rename/覆盖。

一次交接：origin `publish` → 把 `<origin>/<sha256>` 写进任务文本 → target 在任务里 `fetch` → target `publish` 产物、名字写进结论 → origin `fetch`。这要求 target 能连到 origin（全互联 mesh 满足）；取不到只是这次 fetch 失败，任务继续。

### 4.6 交接

协议里没有接续：没有 `continuation_of`、没有来源校验、没有接管状态机。交接 = 共享工作区里的现场 + 一个普通新任务。C 在 B 上发起新任务，agent 在 workgroup 根里看代码、diff、前面任务留下的东西，自己决定接着干什么。

协议只保证两件事：工作区跨任务/跨 session/跨重启持久；同一节点单槽串行，不会有两个任务同时写同一份工作区。旧 task 不可变，追溯靠时间戳与 task id。

## 5. 执行与工作区

### 5.1 LocalExecutor

```ts
interface LocalExecutor {
  run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, void>;
  close?(): Promise<void>;
}

type ExecutorEvent =
  | { type: "suspend"; tool: string; requested: { tool_call_id?: string; tool_kind?: string }; requestedMode: SandboxMode }
  | { type: "completed"; text: string }
  | { type: "failed"; text: string; reason?: string };

type ExecuteInput = {
  contextId: string;
  originOrcaNode: OrcaNodeId;
  prompt: string;                 // 可信前言在前，远端文本在最后的不可信块
  workspaceDir: string;           // workgroup 根，执行器 cwd
  podDir: string;                 // 网关状态目录，agent 不可见
  permissionMode: SandboxMode;    // 生效模式 = 较窄者
  permissionCeiling: SandboxMode | undefined; // 本机上限
  model: ModelSelection | undefined;
  reasoningEffort: ReasoningEffortId | undefined;
};
```

只有一个权限请求会挂起；不能继续就以 `completed` + `BLOCKED:` 结束。恢复消息让同一个生成器继续，而不是重新开始。`ScriptExecutor`（`test/support/script.ts`）只在测试里，按任务文本里的 `SCRIPT <json>` 行演练耗时/挂起/终态，不随包发布，协议里没有脚本字段。

### 5.2 ACP 执行器

```text
Pod gateway (local)
  → AcpExecutor
    → spawn dsh --profile acp（cwd = workgroup 根）
      → stdio JSON-RPC（换行分隔）
```

- 任务固定用 `acp` profile（D60）：只有它在 stdio 上讲 ACP；该 profile 也要装本插件，任务 agent 才有 `orca_pod` 的 `fetch`/`publish`。每台机器要在宿主 profile 与 `acp` profile 各装一次。
- 禁止：把 ACP 端口暴露给 peer；peer 直接发 ACP；把 ACP sessionId 当 A2A taskId；原样转发 thought。

映射：

| A2A | ACP | 说明 |
| --- | --- | --- |
| `(origin, context_id)` | session | 首次 `session/new`，之后复用；cwd = workgroup 根 |
| 一个 task | 一次 `session/prompt` | 同 session 一次只跑一个；节点单槽 |
| `session/update` | 累积结论 | 只取 `agent_message_chunk`，过滤 thought/tool_call/usage |
| prompt 返回 | 终态 | `refusal`/`max_tokens`/`max_turn_requests` → failed；`cancelled` → 中止；其余 → completed |
| `tasks/cancel` | `session/cancel` | 2s 宽限后仍在跑才关连接、杀进程树 |
| 网关重启 | `session/resume` | 子进程不认识就 `session/new`，cwd 不变 |
| `session/request_permission` | 按模式自动应答或挂起 | 见 §6.4，不弹本地窗 |

- 连接文件 `acp/connection.ts` 负责子进程与路由；`acp/session.ts` 管 `(origin, context)` 绑定；`acp/permissions.ts` 管应答；`acp/executor.ts` 串起来。
- 配置只有 `acp.command`（缺省 `dsh`）；启动参数固定 `--profile acp`，没有执行器种类选项，也没有额外参数或 MCP 透传。`session/new` 与 `session/resume` 的 `mcpServers` 恒为空数组。
- 执行器给子进程注入 `ORCA_POD_IN_TASK=1`（任务会话：插件不启动节点、不注册 skill）、`ORCA_POD_NODE_URL`、`ORCA_POD_NODE_ID`、`ORCA_POD_NODE_TOKEN`。

### 5.3 单槽与 TTL

- 一个节点同一时间只跑一个任务；`busy` 写进 self record 随心跳刷新，origin 的 UI 据此显示「B 正在跑 X」。
- 槽位被占时新的 `message/send` 直接 `429 orca_node_busy`（带 `retry_after_s: 30` 与 `holder`），不排队、服务端不自动重试；要不要重试、换节点还是回报用户，由调用方的模型决定。
- 忙时拒绝发生在建 task 之前（不产生 task）；检查顺序：槽位 → 工作区配额。
- `input-required` 的恢复也要重新拿槽；槽被占同样 429，任务仍停在 input-required，由 origin 决定何时重试。
- `task_timeout_s`（默认 3600）是本机硬上限：到点先置终态再 abort 执行器，`failed("task ttl exceeded", reason="timeout")`；`input-required` 期间暂停。
- 为什么单槽：两个 agent 同改一棵树的冲突是语义层的；「同一机器跑多件事」争的是同一台机器的 CPU、磁盘与 DSH 状态。

### 5.4 工作区与会话

```text
<data_root>/
  ├─ workgroups/<workgroup_id>/     ← agent 的 cwd；放什么由 agent 决定
  ├─ blobs/<sha256>                 ← 发布文件的副本
  └─ state/<workgroup_id>/          ← 网关状态，cwd 之外
        ├─ sessions.json            ← (origin, context) → ACP session
        └─ tasks/                   ← 预留目录（当前无使用方）
```

- 节点创建时建好，之后所有任务共用；跨任务、跨 session、跨重启持久，任务结束不删。
- cwd 就是 workgroup 根：agent 用相对路径读写，不需要知道 `<data_root>`。要不要记笔记、记在哪里，由 agent 自己决定。
- 持久是为了长程任务：今天改一个模块、明天接着改，必须还能看到昨天的改动与结论。
- 多 origin 共享同一份工作区，但串行；origin 不能指定目录、不能传路径。
- 会话绑定：`(origin_orca_node, context_id) → ACP session_id`，存在 `state/<workgroup_id>/sessions.json`，键 `acp|<origin>|<context>`；同一个 context 复用 session，不同 context 各新 session 但共用工作区。重启后先 `session/resume`，不认识就 `session/new`——会话可丢，工作区不丢。
- 网关状态在 cwd 之外，agent 删不到 session 绑定。节点不做路径规范化/越界检查/符号链接防护：文件访问范围由会话沙箱与权限模式决定，节点只负责不把路径放进协议。
- 任务书（`composePrompt`）：可信前言在前（task id、cwd 是共享 workgroup 根、任务只有一跳、要权限直接调工具、做不完 `BLOCKED:` 交回、文件怎么取/发），远端正文包进 `<untrusted-task-input>` 并放在最后，伪造的结束标签会被转义。

### 5.5 任务结果

| 层 | 走哪 | 说明 |
| --- | --- | --- |
| 结论文本 | `tasks/get` 的 `status.message`，内联 | 按 32 KiB（`RESULT_MAX_BYTES`）截断，末尾带 `…[summary truncated at N bytes]` |
| 交回的文件 | blob 通道 | agent `publish`，名字写进结论；origin 按需 `fetch` |
| 工作区状态 | 本机工作区 | 不离开目标机；要让 origin 知道进展，由 agent 写进结论摘要 |

没有任务 manifest：不自动收集变更文件、不生成 patch、不自动全量回传。结论文本是 agent 自己的话，origin 一律当不可信输入。`failed` 的 reason ∈ `timeout`、`node_restart`、`permission_denied`、`model_unavailable`、`executor_exited`、`executor_error` 及执行器自带原因；`canceled` 的 reason 是 `canceled`。

### 5.6 模型选择

- 线上形状就是 DSH 的 `ModelSelection`（`{provider, model, reasoningEffort?}`）与 `ReasoningEffortId`；目录条目取 `LlmModelInfo` 的必要字段。
- 节点自述带 `models`/`default_model`/`default_reasoning_effort`，只对同组成员可见；目录来自 Host 的 `llm` 服务与 `agentDefaultModel`，插件用 `ModelCatalogFeed` 装到节点上。
- 任务用 `metadata.pod.model` / `reasoning_effort` 选择；优先级：任务值 > 节点本地默认（Host 默认 + `default_reasoning_effort`）> ACP/provider 默认。
- ACP 侧在 `session/prompt` 之前用 `session/set_config_option` 设置：按 `category`（`model`、`thought_level`）从会话 `configOptions` 里找，模型取值为 `JSON.stringify([provider, model])`；失败 → `failed(model_unavailable)`，不偷偷用默认模型。
- 选择是提示、不是授权：目标仍按本机 `permission_mode`、审批与工作区规则执行。

### 5.7 配额

`max_workspace_bytes`（默认 5 GiB）是设置项。用量由后台异步遍历 workgroup 根得到：启动时、每个任务结束后、每次因超额拒绝后各量一次；第一次量完前不拒绝任务。超额时**新任务**被 `507 quota_exceeded` 拒绝（建 task 之前）；在跑的任务与挂起恢复不受影响。工作区不会被自动清理——没有 TTL、驱逐或 purge，超额后由人清理。

## 6. 安全

### 6.1 两样证明与签名

每个节点间请求同时带 Ed25519 签名（谁发的、内容有没有被改）与 workgroup HMAC（此刻是否在组内），输入相同（见 §3.3）。成员表不管准入。

- 无状态：没有 token、TTL、刷新。
- 密码泄露 = 可加入组（能发现成员、发任务），但不能伪造已有节点的请求（每个节点用自己的私钥）。
- 撤销：换密码重建组；旧节点签名仍有效但证明过不了，下一个请求被拒。
- 重放：60s 时间窗 + nonce 去重（5 分钟，LRU 10k）+ `stale_request`（重启前签发的请求不再接受）。
- 答复由应答方签名并绑定请求 nonce；代理改写 body/查询串会验签失败（这是特性）。

### 6.2 TLS

- 证书：`src/core/certificate.ts` 用身份私钥现签 X.509 v3（Ed25519，十年，不落盘）；TLS 1.3 监听。
- 拨号：`src/mesh/tls.ts` 的 `PeerTls` 基于 undici。已知节点证书公钥必须就是它的 id，否则断开；首次接触接受任意节点证书，记下公钥，再要求答复签名者与之一致（TOFU）。公共 CA 为主机名签发的证书同样接受（节点挂代理时，TLS 只到代理，请求/答复签名仍端到端）。
- BoringSSL 默认不在 TLS 签名算法里列 Ed25519，拨号方在 `sigalgs` 显式列出（其后是 ECDSA/RSA，让 CA 证书的代理照常可连）；服务端不用改。
- 不用 TLS 会话复用（恢复的会话不再出示证书，没法钉扎），连接本身照常 keep-alive。
- 本机也走 HTTPS：任务会话访问 `/local/*` 钉住 `ORCA_POD_NODE_ID`。
- 不做 mTLS：身份由每个请求的签名与 workgroup 证明给出，绑在请求上、过得了代理；mTLS 只认证连接。节点不读转发头。

### 6.3 不可信输入

- 任务 prompt、结论文本、`permission_request` 文本都是不可信输入；不拼 shell、不当 HTML、不自动执行。
- 目标侧：可信前言在前，远端正文放进 `<untrusted-task-input>` 并放在最后（伪造结束标签转义）。
- origin 侧：notice 只给状态/原因，远端结论放进 `<untrusted-remote-result>` 并截断到 800 字符，提示 agent 用 `status` 拉全文；权限请求不进对话，面板卡片只显示 `requested` 的 160 字符预览。
- 任务内容按 workgroup 隔离，不跨组复用 session 或工作区。

### 6.4 权限模式继承与审批

- 审批只发生在 origin；target 永不弹本地窗。
- target 的权限不高于发起它的会话：`orca_pod` 的 `send` 默认读当前会话的 sandbox 模式（`ctx.sandboxPolicy.resolve({session}).mode`）；工具参数只能比会话更窄，更宽直接报错；读不到按 `read-only`。
- 本机 `permission_mode` 是上限，生效模式 = 上限与继承值中较窄的；继承只能降，任务运行中可以经 origin 批准升级，但不超过本机上限。
- 模式阶梯用 DSH 的 `WIDER_MODES`（`read-only` → `workspace-write` → `danger-full-access`）；target 不把模式传给子进程，约束来自对 `session/request_permission` 的应答规则。

| 生效模式 | 请求 kind | 结论 |
| --- | --- | --- |
| `danger-full-access` | 任意 | 自动 allow |
| `workspace-write` | `read`/`search`/`think`/`edit`/`delete`/`move`/`execute` | 自动 allow（不校验路径） |
| `workspace-write` | 其它 | 请求升级到 `danger-full-access`，挂起等 origin |
| `read-only` | `read`/`search`/`think` | 自动 allow |
| `read-only` | `edit`/`delete`/`move`/`execute` | 请求升级到 `workspace-write` |
| `read-only` | 其它 | 请求升级到 `danger-full-access` |

目标档超过本机上限时自动 reject，不弹卡。自动应答选 `allow_once`/`reject_once`，没有就选第一个同类，都没有回 `cancelled`。

升级回路：执行器收到模式之外的请求 → 按 `WIDER_MODES` 找能放行的最窄档（超上限直接拒绝）→ runner 把 task 置 `input-required`、释放槽位、把结构化 `permission_request` 写进 `status.message`（data part）→ 连接结束，target 不拨 origin：

```json
{
  "request_id": "<uuid>", "task_id": "<target 上的 task>",
  "tool": "write_file", "requested": { "tool_call_id": "…", "tool_kind": "edit" },
  "requested_by": "<target 自己>", "current_mode": "workspace-write",
  "requested_mode": "danger-full-access"
}
```

origin 的 tracker 下一次轮询看到 `input-required`，留着等 UI 作答（**不产生聊天 notice、不唤醒 agent**），三个落点：当前会话聊天卡、后台会话弹窗、面板 Pending approvals。批准 = 同一 task 的后续 `message/send`，data part `{permission_granted: true, request_id}`；拒绝 = `{permission_denied: true, reason}`，任务 `failed(permission_denied)`。默认不超时；挂起期间 TTL 暂停。

target 校验顺序：任务存在且非终态（404/400）→ 调用者是 origin（403）→ 任务在 input-required（400）→ 槽位空闲（429）→ data part 是批准/拒绝（400）→ 批准的 `request_id` 等于挂起那次（400，任务继续等）。通过后批准 → 任务用 `requested_mode` 跑到结束（只对这个任务有效）；拒绝 → `failed(permission_denied)`。批准不可重放：第二次批准会发现任务已不是 input-required 或请求 id 对不上。没有单独的「已用批准」集合。

`orca_pod` 没有 approve/deny 方法，模型无法自批；批准按钮直接调 `OrcaNode.approve/deny`。任务的 agent 侧不做任何事：权限请求来自 ACP，执行器与 runner 负责挂起/恢复，批准后同一轮从卡住处继续。

### 6.5 授权矩阵

默认同组对等：任意成员可派任务、可读任务、可读已发布的 blob。`trust`（§6.8）按方向收紧之后，下表「同组」的前提是对方的 `inbound` 判定为 `allow`，且本节点的 `outbound` 判定也为 `allow`。

| 操作 | 谁能做 | 依据 |
| --- | --- | --- |
| 派任务 | 本节点 `trust.inbound` 允许的同组成员 | 两样证明 + 信任判定；除信任开关外没有角色 |
| 读任务 | 只有 task 的 origin（及本机） | `403 not_task_origin`（0.2.0 起；此前同组凭 id 可读） |
| 读 blob | 发布方 `trust.inbound` 允许的成员 | `403 peer_blocked` |
| 取消、恢复 | 只有 task 的 origin（及本机） | `403 not_task_origin` |
| 问候（hello） | `trust.inbound` 允许的成员 | `403 peer_blocked` |
| 拨号（任何出站调用） | 本节点 `trust.outbound` 允许的节点 | 本机即拒，`403 peer_not_permitted` |
| 面板 API | DSH web 的 owner 会话 | `connection.admit`，不验节点签名 |
| 权限上限 | 继承 origin 会话，本机上限再降 | §6.4 |
| 登记本机文件 | 只有本机（进程内或 local 路由） | 无成员路由 |

### 6.6 SSRF 防护

- 候选端点拨号前筛查；种子地址不筛查。
- 恒定拒绝：`0.0.0.0`/`::`、组播与保留段（≥224.0.0.0）、`169.254.0.0/16`（含元数据地址）、`fe80::/10`。
- 允许 RFC1918、`100.64/10`、`fd00::/8` 与公网地址；回环只在目录本身经回环到达时接受（同机多节点测试照常可用）。
- 主机名先解析、按所有结果判断，失败即拒；判定缓存 60s；被拒候选只 warning 一次，计一次拨号失败，连续 5 次删除。
- 入站 hello 与出站 probe 答复中自报的端点登记前同样筛查：恒定拒绝的剔除；回环只在请求经回环到达/发起时接受；一个都不剩 → `400 endpoint_refused`。
- 不跟随重定向（`redirect: "manual"`，3xx 按失败）。已知残余：校验与 fetch 各解析一次 DNS，rebinding 窗口仍在。

### 6.7 审计

不做持久审计落盘：任务记录、`dispatches`、DSH 会话记录已经能回答「谁在什么时候派了什么、结果如何」。排查靠现有记录；合规审计属于部署层外挂。

### 6.8 信任：把对等的网变成单向的调用关系（0.2.0）

`trust` 是节点设置，用来把「同组即对等」改成「我允许谁靠近我」。两个方向各自带一个默认值和按节点的覆盖：

```json
{
  "inbound": "allow",
  "outbound": "allow",
  "peers": { "<orca_node_id>": { "inbound": "deny", "outbound": "allow" } }
}
```

- `inbound`：别人调用本节点。判定为 `deny` 的对端，`/cluster/hello`、`/a2a`、`/blobs/{id}` 一律 `403 peer_blocked`。判定在两项证明之后、nonce 入账之前，所以被拒的对端学不到任何东西，也消耗不了 nonce 缓存。
- `outbound`：本节点调用别人。判定为 `deny` 的对端不会被拨号——心跳、任务、文件都不发；`sendTask`/`getTask`/`cancelTask`/`fetchBlob` 在第一条报文离开之前就以 `403 peer_not_permitted` 失败，目录里也不会把它当候选。
- 本节点自己永远双向 `allow`；没有角色、没有组，开关之外没有层级。
- 与其它节点设置一样，只在节点启动时读取：保存并重启后生效。

两种典型形态：

| 形态 | 控制端 | 受控端 | 效果 |
| --- | --- | --- | --- |
| 对等（默认） | 全 `allow` | 全 `allow` | 互相能派任务，0.1.x 的行为 |
| 单向借用 | 全 `allow` | `inbound` 只 allow 控制端、`outbound` 全 `deny` | 控制端能派任务、取结果；受控端不向控制端发起任何连接，也读不到控制端的任务与文件 |

单向形态下受控端有两道墙：任务会话本来就只被授予 `fetch`/`publish`（§5.6），没有 `send`；`outbound` 再把 `fetch` 通往控制端的那条路堵上。网络层由防火墙/组网 ACL 保证时，才是「连都连不上」。

它不是沙箱，也不替代沙箱：`trust` 是应用层的准入判定，管的是「谁可以让我的 agent 干活」和「我的 agent 可以去敲谁的门」，不是「任务能读写哪些文件」——后者仍由 §6.4 的权限模式与本机权限上限决定。

## 7. 可靠性

### 7.1 语义

- 不重发、不自动恢复、不 exactly-once：失败就是失败，重来由人或 agent 显式再派新 task。
- 失败立即、终止明确：target 重启 → `failed(node_restart)`；TTL 到点 → `failed(timeout)`。
- 状态诚实：宁可说失败/未知，不假装成功；没有「副作用未知」标记，`failed` 不表示目标侧没改过文件。
- 重复提交不去重：同一条 `message/send` 提交两次就是两个 task；调用方负责不重复。

### 7.2 失联

tracker 轮询失败 → 退避重试 → 连续 5 次记 failed 并告知 agent（见 §4.2）；404/节点不在表/401/403 第一次就记 failed。origin 记的 failed 是 origin 自己的结论（「这边读不到了」），target 可能还在跑；不补发 cancel，也不设 `node_unreachable`/`task_lost`。目标恢复后自己完成：不处理、不召回、没有 `late_result`；发布的文件按有效期可下载。

### 7.3 过载

- 节点单槽；忙时 429 + `Retry-After: 30`，不排队、不创建进程。
- 工作区超额：新任务 507。
- 出站有截止时间（默认 30s）与 4 MiB 响应上限。
- 心跳连续失败 → suspect/offline，不再派新任务；探测 15s→30s 退避，不会越连不上越猛试。
- 唤醒预算：后台通知连续叫醒同一会话最多 3 次，用户说话后重置。
- 没有总开关：想拒绝所有远程任务，停节点或把本机 `permission_mode` 设成 `read-only`。

数量级（10 节点）：空闲心跳约 10 req/s（每请求 <1 KB）；全部在跑最多 10 个 agent 进程；被打爆时每个 target 1 个任务、其余 429（<1 KB，不创建进程）。

### 7.4 可观测性

没有指标导出，也没有结构化日志。能观测的：target 侧 `tasks/get`（状态、reason、结论）、origin 侧 `dispatches`（面板「全部任务」）、`orca_pod` 的 members 与面板成员列表（状态、最后收到、busy、TTL、runtime、模型）、`/orca-api/state` 一次轮询拿到自己/成员/待审批/最近任务/工作区、节点通过 DSH logger 记的 warning。面板不显示工作区当前用量。

## 8. 未决与暂缓

**待讨论**

1. 密码分发：二维码、剪贴板、系统钥匙串/密码管理器，选哪个作为默认？当前带外手工传递。
2. 大文件传输：Range/断点续传要不要做、阈值多少。当前整体流式下载、失败重来，无大小上限。
3. 超过 10 个节点：UI 提示 O(n²) 心跳负荷，还是拒绝加入？当前不检查不提示（心跳自适应，总流量线性）。
4. 局域网自动发现（mDNS/UDP 广播）：当前不做，host+port 手动加入已够。
5. Windows 路径测试矩阵：8.3 短名、junction、`\\?\`、保留名、尾随点。当前无阻塞，节点不做路径规范化。
6. 自述记录变更的传播与 digest 范围：`members_digest` 只覆盖 `id|endpoints|runtime_digest`；忙闲随心跳、模型目录与默认模型随完整自述刷新。当前行为如上。
7. 跨节点追踪：没有 `trace_id`，排查要分别看 origin 的派发日志与 target 的任务记录。

**暂缓**

8. 指标：没有导出，也没有结构化日志。设想过 `pod_peer_state`、`pod_tasks_terminal_total{state,reason}`、`pod_auth_failures_total{reason}`、`pod_approvals_total`、`pod_blob_*`；若做，只读 `/metrics` 要求成员身份。
9. `message/stream`（SSE）、`tasks/resubscribe`、push notification：当前都没有，进度只能轮询；若做，tracker 升级成持有一条流，push 需要 webhook 鉴权、重试与 SSRF 防护。

## 9. 参考

- A2A Protocol：https://a2a-protocol.org/
- ACP：https://agentclientprotocol.com/
- DSH 文档：本地 `resources/app.asar` 内的 dsh 包与官方文档
- Caddy reverse_proxy：https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- nginx proxy：https://nginx.org/en/docs/http/ngx_http_proxy_module.html
- SQLite WAL：https://sqlite.org/wal.html
- scrypt（RFC 7914）：https://www.rfc-editor.org/rfc/rfc7914
- Ed25519（RFC 8032）：https://www.rfc-editor.org/rfc/rfc8032
