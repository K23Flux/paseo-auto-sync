# paseo-auto-sync

[English](README.md)

基于 [hsiangron/paseo-auto-sync](https://github.com/hsiangron/paseo-auto-sync) 的安全导入分支：按项目白名单将本机 Pi（可选 Codex）会话登记到 Paseo，链接原始 JSONL，不复制会话文件。

## 本分支的行为

- **仅导入，不自动删除既有 agent，也不因源文件缺失而归档工作区。**
- **项目白名单默认为空，未配置时不导入任何会话。** 按规范化后的 cwd 精确匹配，不自动包含子目录、同名前缀目录或 worktree。
- 默认只导入 Pi；可显式启用 Codex。
- 插件启动、客户端加载时同步，默认每 **30 秒**检查新会话。白名单配置每次同步重新读取。
- 去重包含已归档 agent。不会自动重新创建已归档的会话。
- 每个新会话创建一个可见工作区；导入失败时仅归档本次新建的空工作区。
- 跳过 Pi 内部 forks/run 会话、Codex exec/subagent、工作目录不存在的会话；Codex active writer 会延后重试。
- 每次最多导入 50 个会话，按修改时间倒序；不会自动发送提示词。
- Command Center 中的 **Sync local Codex and Pi sessions** 可手动触发。

自动导入是会话登记，不保证本地 Pi 继续写入后 Paseo 页面实时刷新。避免在本地 Pi 与 Paseo 同时操作同一个原生会话。导入可能启动 provider 运行时，因此首次批量导入会增加资源占用。

## 安装

需要 Paseo **0.13.2 或更新版本**；更新 Paseo 后应重新验证兼容性，因为工作区导入使用了 CLI 内部接口。

```bash
git clone https://github.com/K23Flux/paseo-auto-sync.git ~/.paseo/plugins/paseo-auto-sync
cd ~/.paseo/plugins/paseo-auto-sync
npm ci --ignore-scripts
npm test
npm run typecheck
paseo plugin install ~/.paseo/plugins/paseo-auto-sync
```

依赖仅用于开发与测试；插件运行时使用 Paseo 提供的模块。本地改动后：

```bash
paseo plugin reload paseo-auto-sync
paseo plugin logs paseo-auto-sync
```

## 项目白名单

创建本机私有文件 `~/.paseo/plugin-data/paseo-auto-sync/config.json`（自定义 `PASEO_HOME` 时相对于该目录）。不要将包含私人项目路径的本机配置提交到仓库。

```json
{
  "projects": ["~/Projects/my-project"],
  "providers": ["pi"]
}
```

`projects` 必须是绝对路径或 `~/` 路径数组；`providers` 可包含 `pi`、`codex`，省略时默认为 `pi`。空数组不导入任何项目/提供商。损坏或非法配置会终止本轮同步，不会扩大扫描范围。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex 主目录 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi agent 目录 |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | Pi 会话根目录 |
| `PASEO_HOME` | `~/.paseo` | Paseo 数据目录与本机白名单根目录 |
| `PASEO_CLI` | PATH 与常见安装路径 | 导入使用的 Paseo CLI |
| `PASEO_AUTO_SYNC_BATCH_SIZE` | `50` | 每轮最多新导入数量，1–50 |
| `PASEO_AUTO_SYNC_INTERVAL_SECONDS` | `30` | 后台检查间隔，30–86400 秒 |

此分支不再使用上游的 `PASEO_AUTO_SYNC_INTERVAL_HOURS`，也不执行悬空会话清理。停止同步可在 Paseo 禁用插件，不会删除已导入的会话或原始 JSONL。
