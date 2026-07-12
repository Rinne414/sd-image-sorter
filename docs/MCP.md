# AI 助手接口 (MCP) / AI Assistant Interface (MCP)

让 AI 助手（Claude Desktop / Claude Code 等支持 MCP 的客户端）直接操作 SD 图片管理器：搜图、看资料、帮图打标、导出训练集——你用一句话下指令，AI 自己完成整条流程。

Lets MCP-capable AI assistants (Claude Desktop / Claude Code, …) drive SD Image Sorter directly: search the library, read metadata, edit tags, and export training datasets from one natural-language instruction.

**安全边界 / Safety boundary**: 接口只开放 查询 + 导出 + 打标。AI **不能移动、删除、打码任何文件** — 原图永远不会被碰。所有请求都走本机 REST API（含 localhost-only 校验），不对外网开放。
The surface is query + export + tagging ONLY — the assistant can never move, delete, or censor files. Everything routes through the local REST API (localhost-only middleware included); nothing is exposed to the network.

## 启用 / Setup

1. 应用必须在运行（`run.bat` / `run.sh`，默认端口 8487）。
2. 在应用的 venv 里安装 MCP SDK（一次性，约几 MB；官方稳定 1.x 线）：

   ```
   backend\venv\Scripts\python.exe -m pip install "mcp>=1.9,<2"
   ```

3. 在 AI 客户端里注册这个服务器。Claude Desktop（`claude_desktop_config.json`）/ Claude Code（`.mcp.json`）示例：

   ```json
   {
     "mcpServers": {
       "sd-image-sorter": {
         "command": "L:\\path\\to\\sd-image-sorter\\backend\\venv\\Scripts\\python.exe",
         "args": ["L:\\path\\to\\sd-image-sorter\\backend\\mcp_server.py"],
         "env": { "SD_IMAGE_SORTER_PORT": "8487" }
       }
     }
   }
   ```

   把路径换成你的安装目录；改过端口就同步改 `SD_IMAGE_SORTER_PORT`。

## 工具一览 / Tools

| Tool | 作用 / What it does |
|---|---|
| `search_images` | 按图库的完整筛选集搜图：文本、标签（含排除）、生成器、分级、模型/LoRA、美学分、我的星级、文件时间范围（`date_from`/`date_to`）、文件夹、排序、分页。返回精简行。 |
| `count_images` | 同样的筛选条件，只回数量。 |
| `get_image` | 单张图的完整资料（prompt、标签、caption、路径、元数据）。 |
| `semantic_search` | 语义找图（"a girl under cherry blossoms"）。需要先在「相似」页构建过一次向量；没构建时返回空结果而非报错。 |
| `list_library` | 图库里有什么：`facet` = `tags` / `checkpoints` / `loras` / `prompts`，可加子串过滤 `q`。 |
| `add_tags` / `remove_tags` | 批量加/删标签（按 `image_ids`；支持 `dry_run=true` 先预览影响面）。 |
| `export_dataset` | 导出训练集（复制到 `output_folder`，原图不动）：caption sidecar、触发词、命名模式、`trainer_config="kohya_toml"` 生成现成的 dataset_config.toml、`mask_export` 附带蒙版。 |
| `library_stats` | 图库总量、今日新增等汇总。 |

## 一个真实用法 / Example

> "把图库里 2026 年 1 月、美学 7 分以上、带 silver_hair 的图找出来，去掉 blurry 标签，然后导出到 L:\\train\\silver，触发词 mychar，顺便生成 kohya 配置。"

AI 会依次调用 `search_images`（date_from/date_to + min_aesthetic + tags）→ `remove_tags`（可先 dry_run）→ `export_dataset`（trigger + trainer_config）。

## 故障排查 / Troubleshooting

- **"not running / 应用没有在 ... 运行"** — 先启动应用（run.bat），或核对 `SD_IMAGE_SORTER_PORT` 与实际端口一致。
- **`mcp` 未安装** — 服务器启动时会给出双语安装提示；按上面第 2 步执行。
- 语义搜索返回空 — 到「相似」页先构建一次 CLIP 向量库。
