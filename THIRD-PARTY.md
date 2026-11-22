# 第三方组件与数据来源

本项目在运行期依赖或再分发以下第三方作品,各自的许可与来源如下。Wallnut 本身以 GPL-3.0 发布。

| 组件 | 用途 | 许可 | 来源 |
| --- | --- | --- | --- |
| mihomo | 代理内核(以独立可执行文件形式随发布包分发,源码中不含) | GPL-3.0 | https://github.com/MetaCubeX/mihomo |
| Electron / Chromium | 桌面运行时(发布包内) | MIT / BSD-3-Clause 及 Chromium 第三方许可 | https://github.com/electron/electron |
| Node.js | 运行时 | MIT | https://nodejs.org |
| Preact (`renderer/vendor/preact.mjs`) | 渲染层 UI | MIT | https://github.com/preactjs/preact |
| htm (`renderer/vendor/htm.mjs`) | JSX 替代模板 | Apache-2.0 | https://github.com/developit/htm |
| yaml (`npm` 依赖) | 配置序列化 | ISC | https://github.com/eemeli/yaml |
| geoip.metadb / geosite.dat | 分流数据(发布包内) | 见上游说明 | https://github.com/MetaCubeX/meta-rules-dat |
| country.mmdb (GeoIP2) | IP 归属地数据(发布包内) | CC BY-SA 4.0 / MaxMind 数据库许可 | https://www.maxmind.com |

## 说明

- 压缩在 `Wallnut.exe` 内的 Electron/Chromium 组件遵循其原始许可,相关许可文本随 Electron 分发。
- `mihomo` 为 GPL-3.0 程序,以独立进程方式调用,其完整源码请见上游仓库。
- 图标与界面素材由本项目作者提供,随本项目许可发布。
