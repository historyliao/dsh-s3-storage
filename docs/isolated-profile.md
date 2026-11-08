# 隔离 profile 配置与回滚

本文用于在**不影响当前正在运行的 dsh** 的前提下，验证 `dsh-s3-storage`。

核心结论：`dsh` 进程之间是独立的，但默认共用同一个 `$DSH_HOME`。要做真正隔离的测试，必须同时隔离 profile 和 `DSH_HOME`。

---

## 1. 准备构建产物

```sh
cd /data/lyy/opensource/dsh-s3-storage
pnpm install
pnpm run build
pnpm pack
```

得到：

```text
/data/lyy/opensource/dsh-s3-storage/dsh-s3-storage-0.1.0.tgz
```

注意：`dsh plugin add` 会把 tarball 的**绝对路径**写进 profile 的 `package.json`。安装后不要删除这个 `.tgz`，否则以后在该 profile 里执行 `pnpm install` 会解析失败。

---

## 2. 方式一：完全隔离（推荐）

使用独立的 `DSH_HOME`，profile、sessions、storages、attachments、credentials 全部与当前实例分离。

### 2.1 选定隔离路径

```sh
export DSH_HOME=/data/lyy/.dsh-s3test
```

后续所有命令都要保留这个环境变量；如果换终端，重新 export。

### 2.2 创建 profile

从 web 模板创建，名称用 `s3test`：

```sh
DSH_HOME=/data/lyy/.dsh-s3test \
  dsh --profile s3test --from-default-profile web --dump-config
```

这会创建：

```text
/data/lyy/.dsh-s3test/profiles/s3test/
├── package.json
├── pnpm-workspace.yaml
├── cordis.patch.yml
└── ...
```

`--from-default-profile web` 是**替换式**创建：同名 profile 已存在时会被模板覆盖。不要对正在使用的 `web` profile 执行。

### 2.3 安装插件

```sh
DSH_HOME=/data/lyy/.dsh-s3test \
  dsh plugin --profile s3test add \
  /data/lyy/opensource/dsh-s3-storage/dsh-s3-storage-0.1.0.tgz
```

看到下面这行是正常的，不代表失败：

```text
dsh: warning: dsh-s3-storage declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

它表示插件已装进 profile 的 `node_modules`，但不会自动启用；启用由下一步的 patch 完成。

### 2.4 写配置

编辑：

```text
/data/lyy/.dsh-s3test/profiles/s3test/cordis.patch.yml
```

新 profile 的初始内容是 `[]`，直接替换为：

```yaml
- id: session-persistence-jsonl
  disabled: true

- insert:
    - id: session-persistence-s3
      name: dsh-s3-storage
      config:
        bucket: dsh-sessions
        prefix: dsh/
        region: us-east-1
        endpoint: http://127.0.0.1:9000
        forcePathStyle: true
        accessKeyId: !!js process.env.S3_ACCESS_KEY_ID
        secretAccessKey: !!js process.env.S3_SECRET_ACCESS_KEY
```

要点：

- `bucket` 必填，**桶必须提前创建**，本后端不会自动建桶。
- 只允许一个 `sessionPersistence`，所以必须禁用 `session-persistence-jsonl`。
- AWS S3 省略 `endpoint` 和 `forcePathStyle`；R2 用 `region: auto` + R2 endpoint。
- 密钥可以用 `!!js process.env.*`，也可以直接写字符串；使用环境变量时，确保启动 dsh 的进程能看到这些变量（包括 `$DSH_HOME/.env`）。
- `prefix` 可省略；填了会存成 `<prefix>/sessions/<sessionId>/...`。

### 2.5 启动

```sh
DSH_HOME=/data/lyy/.dsh-s3test \
  dsh --profile s3test --no-open --port 3903
```

- `--no-open`：不要自动拉起浏览器。
- `--port 3903`：必须和当前 web 实例（例如 3080）不同，否则第二个进程会因端口占用启动失败。
- 终端会打印带 token 的 URL，用浏览器打开即可。

### 2.6 验证

1. 打开打印出的 URL，能进入 Web UI。
2. 新建一个会话并发送一条消息。
3. 检查桶里出现对象：

```sh
# MinIO mc
mc ls myminio/dsh-sessions/dsh/sessions/

# 或 aws cli
aws --endpoint-url http://127.0.0.1:9000 \
  s3 ls s3://dsh-sessions/dsh/sessions/
```

每个会话目录应包含：

```text
manifest.json
fragments/00000000-<sha>.jsonl
lease.json
```

4. 重启该隔离实例（Ctrl-C 后重新启动），确认能 `resume` 同一会话。
5. 用另一台机器或另一个隔离 `DSH_HOME` 打开同一个桶，确认历史可读。

---

## 3. 方式二：共用 home 的临时 profile（不推荐）

只隔离 profile、不隔离 `DSH_HOME`：

```sh
dsh --profile s3test --from-default-profile web --dump-config
dsh plugin --profile s3test add /data/lyy/opensource/dsh-s3-storage/dsh-s3-storage-0.1.0.tgz
# 编辑 ~/.dsh/profiles/s3test/cordis.patch.yml
dsh --profile s3test --no-open --port 3903
```

这种情况下两个进程共享：

- `$DSH_HOME/sessions`、`storages`、`attachments`、`spill`
- `.env`、`.credentials.yaml`
- home 级 `cordis.patch.yml`（对所有 profile 生效）

其中 `storages` 里的 `workspace` 域是整文件重写，两个实例同时写可能互相覆盖（last-write-wins）。只是临时验证、不改 workspace 时通常没问题；要稳妥请用方式一。

---

## 4. 回滚

### 4.1 回滚隔离 profile

如果整个隔离 home 只是测试用，最干净：

```sh
# 1. 先停止隔离实例（Ctrl-C 或 kill 对应进程）
# 2. 确认路径后删除整个隔离 home
realpath /data/lyy/.dsh-s3test
rm -rf /data/lyy/.dsh-s3test
```

如果想保留隔离 home，只恢复持久化后端：

```sh
# 1. 编辑 cordis.patch.yml：
#    删除 session-persistence-s3 的 insert 块
#    删除 session-persistence-jsonl 的 disabled: true
# 2. 再卸载包（顺序不能反：patch 仍引用缺失包会报错）
DSH_HOME=/data/lyy/.dsh-s3test dsh plugin --profile s3test remove dsh-s3-storage
# 3. 重启
DSH_HOME=/data/lyy/.dsh-s3test dsh --profile s3test --no-open --port 3903
```

### 4.2 回滚正式 web profile

在正式切换前先备份：

```sh
cp /data/lyy/.dsh/profiles/web/cordis.patch.yml \
   /data/lyy/.dsh/profiles/web/cordis.patch.yml.bak
```

回滚步骤：

```sh
# 1. 停止 dsh web 进程
# 2. 编辑 /data/lyy/.dsh/profiles/web/cordis.patch.yml：
#    a. 删除 session-persistence-s3 的 insert 块
#    b. 删除 session-persistence-jsonl 的 disabled: true
# 3. 确认组合
dsh --profile web --dump-config | grep -A8 session-persistence
# 4. patch 不再引用插件后，再卸载
dsh plugin --profile web remove dsh-s3-storage
# 5. 重新启动
dsh web
```

或直接恢复备份：

```sh
cp /data/lyy/.dsh/profiles/web/cordis.patch.yml.bak \
   /data/lyy/.dsh/profiles/web/cordis.patch.yml
dsh plugin --profile web remove dsh-s3-storage
dsh web
```

### 4.3 启动失败时的急救

**YAML 写坏**（缩进、冒号、列表层级）会让 profile 启动直接失败，这是最常见的自伤方式：

```sh
# 查看错误
dsh --profile web --dump-config
# 手工修复，或恢复备份
cp /data/lyy/.dsh/profiles/web/cordis.patch.yml.bak \
   /data/lyy/.dsh/profiles/web/cordis.patch.yml
```

**插件缺失/加载失败**时，dsh 通常仍能启动，但 `sessionPersistence` 缺失会让 `session-controller`、`workspace`、`schedule` 等停在 pending，表现为"页面能开、会话不可用"。处理方式同上：先修 patch，再卸载包，重启。

**最后手段**（会清空该 profile 的自定义 patch，务必先备份）：

```sh
dsh --profile web --from-default-profile web
```

---

## 5. 注意事项

- **端口**：每个 web 实例必须有独立端口；`--port 0` 由系统分配。
- **tarball 路径**：profile 的 `package.json` 记录的是 `file:/绝对路径/xxx.tgz`，删除 tarball 会导致后续 `pnpm install` 失败。长期使用建议发布到 registry，或改用 git/`link:` 并保留源码目录。
- **旧本地会话不迁移**：切到 S3 后，`$DSH_HOME/sessions` 里的历史不会出现在新后端；本地文件不会被删除。
- **附件仍在本机**：当前版本只做会话日志 + header，图片/文件字节仍在 `$DSH_HOME/attachments`，换机后可能缺失。
- **条件写要求**：存储端点必须支持 `PutObject` 的 `If-Match` / `If-None-Match`；不支持时会明确报错。
- **插件操作日志**：安装/卸载的 pnpm 输出在 `<profile>/.plugin-manager/logs/operation-*/pnpm.log`。
