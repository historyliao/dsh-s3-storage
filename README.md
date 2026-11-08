# dsh-s3-storage

DeepSeek Harness 的 S3 会话持久化后端：把 `ctx.sessionPersistence` 落到 S3 兼容对象存储，换机后可从桶里 `resume` 会话日志。

当前实现范围（P0）：

- 会话日志本体 + `SessionHeader`（含 `cwd`、`isSeeded`、`inheritedEventCount`）
- 不可变 JSONL 分片 + 条件写 manifest 作为唯一提交点
- 跨进程写租约（`If-None-Match` / `If-Match`，60s TTL，心跳续约）
- `create` / `open` / `stat` / `list` / `flush` 与 `SessionHandle` 全部契约

不包含（后续阶段）：附件字节、spill、workspace 注册表、会话格式迁移（只读写当前 `SESSION_FORMAT_VERSION`）。

## 对象布局

```text
{prefix}sessions/{sessionId}/
├── manifest.json              # 唯一提交点；ETag 是下一次条件写的 If-Match
├── fragments/00000000-<sha>.jsonl   # 不可变事件分片，一行一个 SessionEvent
└── lease.json                 # 写租约，TTL 60s
```

`manifest.json` 记录 header、`inheritedEventCount`、`revision` 和已提交分片列表（含每条分片的 SHA-256 与字节数）。崩溃只会留下未被 manifest 引用的孤儿分片，不会产生半提交日志。

## 配置

```yaml
- id: session-persistence-s3
  name: dsh-s3-storage
  config:
    bucket: dsh-sessions
    prefix: prod/            # 可选；非空时自动补尾部 /
    region: us-east-1        # S3 兼容存储可填任意值，但必须与 endpoint 匹配
    endpoint: http://127.0.0.1:9000   # MinIO/R2；AWS S3 省略
    forcePathStyle: true     # 设置 endpoint 时默认 true
    accessKeyId: minio
    secretAccessKey: minio123
    sessionToken: ...        # 可选，临时凭据
```

未提供 `accessKeyId`/`secretAccessKey` 时使用 AWS 默认凭据链（环境变量、profile、实例角色）；`sessionToken` 必须与两者一起提供。省略 `region` 时：设置 `endpoint` 的兼容存储默认 `us-east-1`，AWS S3 交由 SDK 从环境/profile 解析。`bucket` 必须非空且已存在（本后端不会建桶）。

## 启用

S3 后端要**替换**默认的 JSONL 后端，二选一挂载。在 profile 的 `cordis.patch.yml`（通常是 `$DSH_HOME/profiles/<name>/cordis.patch.yml`）里：

```yaml
- id: session-persistence-jsonl
  disabled: true

- insert:
    - id: session-persistence-s3
      name: dsh-s3-storage
      config:
        bucket: dsh-sessions
        endpoint: http://127.0.0.1:9000
        forcePathStyle: true
        accessKeyId: minio
        secretAccessKey: minio123
```

安装包：

```sh
pnpm install
pnpm run build
pnpm pack
dsh plugin --profile web add /absolute/path/to/dsh-s3-storage/dsh-s3-storage-0.1.0.tgz
```

已存在的本地 `$DSH_HOME/sessions` 不会自动迁移；切换后旧会话在 S3 后端不可见。

隔离 profile 的完整配置、验证与回滚步骤见 [docs/isolated-profile.md](docs/isolated-profile.md)。

## 语义与限制

- **条件写是硬要求**：端点必须支持 `PutObject` 的 `If-Match` / `If-None-Match`（AWS S3、MinIO、R2 均支持）。不支持时第一次写入会明确报错。
- **延迟物化**：`create` 只在进程内登记会话；第一次 `flush`（或带事件的 `close`）才写 manifest。从未 append 就 `close` 的会话不会在桶里留下任何对象，id 可以立即复用。
- **单写者**：同一 session 的写句柄由对象租约互斥；进程崩溃后最多 60 秒租约过期，期间其他机器打开写句柄会得到 `SessionAlreadyOwnedError`。
- **同实例 freshness**：同一 backend 实例内，读句柄与写句柄共享状态，`append` resolve 后读句柄就能看到；跨进程要等 `flush` 提交 manifest。
- **append 不等于落盘**：`append` 只进入内存；`flush` 才写分片并提交 manifest。调用方必须等待 `session/flush`（agent loop 每轮会等）。
- **请求超时**：每个 S3 请求有 30 秒上限，避免端点无响应时卡死 turn。
- **格式版本**：只接受当前 `SESSION_FORMAT_VERSION`；不做历史格式迁移，遇到更高版本会拒绝解读而不是误读。
- **`list` 容错**：单个损坏/版本不支持的会话会被跳过并记录警告，不会让整个会话列表失败；`stat`/`open` 仍会明确报错。
- **桶权限**：需要 `s3:GetObject`、`s3:PutObject`、`s3:ListBucket`（限定前缀）。

### 已知限制

- **manifest 随 flush 次数增长**：每个轮次一个分片，manifest 会线性增大且每次提交全量重写。尚无分片合并（compaction），超长会话需要注意。
- **`list` 是 N+1**：先列前缀，再逐个读取 manifest；会话很多时较慢。
- **租约依赖本地时钟**：多机时钟偏差过大时可能提前接管；manifest 的条件写会阻止日志被覆盖，但会留下孤儿分片。
- **附件仍在本机**：图片/文件字节不在 S3，换机后可能缺失。
- **只支持当前格式**：无历史格式迁移。
