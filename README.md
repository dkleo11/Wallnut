# Wallnut

Wallnut 是一个 Windows 桌面代理客户端,界面与交互参考 Quantumult X,底层由内置的 **mihomo** 内核驱动。

> A Windows desktop proxy client inspired by Quantumult X, built on Electron with a bundled mihomo core.

## 功能

- 订阅管理:添加 / 更新 / 删除订阅,自动解析节点与分组
- 节点与分组:节点列表、地区聚合、分组策略(select / url-test / fallback)
- 规则与改写:规则编辑与排序、QX 风格的重写 / 脚本、`geoip` / `geosite` 分流
- 内核托管:mihomo 单实例托管、健康检查、崩溃自动重启、日志环形缓冲
- 网络:系统代理开关、MITM 证书管理、节点测速
- 顶栏实时流量:直连 / 代理 / 拦截状态与速率指示
- 桌面体验:托盘菜单、开机自启、便携模式(数据全部落在程序同级 `data/` 目录)
- 其它:活动面板、实时日志、深色界面

## 下载(普通用户)

到仓库的 **Releases** 页面下载最新便携包:

1. 下载 `Wallnut-v0.4.0-portable-win-x64.zip`
2. 解压到任意目录(不需要安装)
3. 运行 `Wallnut.exe`
4. 在界面里添加自己的订阅

程序首次启动会在同级目录创建 `data/`(配置、状态、日志、证书)与 `temp/`,这些都是本机私有数据,不会随发布包分发。

## 从源码运行(开发者)

环境要求:Windows 10/11、Node.js 18+。

```bash
git clone https://github.com/dkleo11/Wallnut.git
cd Wallnut
npm install
npm install --no-save electron
```

源码仓库**不包含**二进制依赖,运行前需自备以下文件(都放在 `resources/` 下):

| 路径 | 说明 | 来源 |
| --- | --- | --- |
| `resources/core/mihomo.exe` | mihomo 内核 | [MetaCubeX/mihomo Releases](https://github.com/MetaCubeX/mihomo/releases) `windows-amd64` 版本 |
| `resources/geo/geoip.metadb`、`geosite.dat`、`country.mmdb` | 分流数据 | [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) |

也可以用环境变量覆盖路径:

| 变量 | 作用 |
| --- | --- |
| `WALLNUT_CORE` | 指定 mihomo 可执行文件路径 |
| `WALLNUT_DATA` | 指定数据目录 |
| `WALLNUT_PORTABLE=1` | 强制便携模式 |

启动:

```bash
npx electron .
```

打包便携版时,把 `electron/`、`renderer/`、`resources/`(含核心与 geo 数据)、`package.json` 放进 `resources/app/`,在程序同级放一个 `portable.flag` 空文件,再用 Electron 的 `dist` 目录作为运行时外壳即可。

## 目录结构

```
electron/           主进程(main / ipc / store / tray / 自动启动)
  config/           生成 mihomo 配置
  core/             内核托管:进程管理、REST API、测速
  net/              系统代理
  rewrite/          重写与 MITM 证书
  subs/             订阅下载与解析
renderer/           渲染进程(原生 DOM + Preact/htm,无需构建步骤)
  pages/            各页面视图
  vendor/           预置前端依赖
resources/          图标资源(核心与 geo 数据不入库)
package.json
```

## 隐私

本仓库与发布包均**不包含**任何个人订阅地址、节点信息、控制器密钥、缓存、日志、证书或其它用户数据。所有运行时数据都在本机生成。

## 许可

本项目以 **GPL-3.0** 发布,详见 [LICENSE](LICENSE)。第三方组件与数据来源见 [THIRD-PARTY.md](THIRD-PARTY.md)。

> 请遵守所在地区的法律法规,并仅将本项目用于合法的网络访问用途。

## English

Wallnut is a Windows desktop proxy client inspired by Quantumult X, built with Electron and a bundled [mihomo](https://github.com/MetaCubeX/mihomo) core.

- **Users**: download the portable zip from [Releases](https://github.com/dkleo11/Wallnut/releases), unzip, run `Wallnut.exe`, add your own subscription.
- **Developers**: `git clone`, `npm install`, supply `resources/core/mihomo.exe` and `resources/geo/*` yourself (see table above), then `npx electron .`.

No personal subscription, node, secret, cache, log or certificate is included in this repository or in the release assets. Licensed under GPL-3.0.
