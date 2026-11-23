# Wallnut

**简体中文** · [繁體中文](#繁體中文) · [English](#english) · [日本語](#日本語) · [한국어](#한국어)

![version](https://img.shields.io/badge/version-0.4.8-0A84FF) ![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-34C759) ![core](https://img.shields.io/badge/core-mihomo-5E5CE6)

---

## 简体中文

**Wallnut** 是一个面向 Windows 的桌面代理客户端：Electron 外壳 + 内置 [mihomo](https://github.com/MetaCubeX/mihomo) 内核，便携运行、无需安装。

**名字由来**：Wallnut 读作「wall-nut」，谐音 **wall-not**；同时也是对《植物大战僵尸》里**坚果墙**的致敬——站在最前面挨打，默默把后面的一切挡住。中文名就叫「坚果墙」。

### 功能

- **订阅管理**：添加、编辑（名称 / 地址 / 更新间隔）、更新、删除订阅；支持 Clash/mihomo YAML、Surge conf、分享链接、base64 与粘贴导入
- **节点与地区**：按国家自动聚合地区组，跨订阅一起测速找最快节点，支持单独测速与按延迟排序
- **策略组**：地区组 + 自定义组，select / url-test / fallback 三种策略，可在卡片上直接切换
- **分流规则**：本地规则排序与校验、远程规则集（按间隔自动更新）、规则优化排序
- **重写**：本地重写规则、线上重写规则集、302 跳转、请求/响应头、响应体替换，以及白名单 MITM 解密
- **内核托管**：单实例托管、健康检查、崩溃自动重启、配置校验、日志环形缓冲
- **网络接管**：系统代理、TUN 模式、DNS 设置与 fake-ip、清空 DNS 缓存
- **实时面板**：流量曲线、活跃连接、规则命中、内核内存与版本
- **桌面体验**：托盘菜单、开机自启、浅色/深色/跟随系统、关闭到托盘
- **多语言**：简体中文、繁體中文、日本語、한국어、English、Français、Español

### 下载（普通用户）

到仓库的 **Releases** 页面下载最新便携包：

1. 下载 `Wallnut-v0.4.8-portable-win-x64.zip`
2. 解压到任意目录（不需要安装）
3. 运行 `Wallnut.exe`
4. 在界面里添加自己的订阅

首次启动会在程序同级创建 `data/` 与 `temp/`，配置、状态、日志与证书都保存在本机。

### 从源码运行（开发者）

环境要求：Windows 10/11、Node.js 18+。

```bash
git clone https://github.com/dkleo11/Wallnut.git
cd Wallnut
npm install
npm install --no-save electron
```

仓库**不包含**二进制依赖，运行前请自备以下文件（放在 `resources/` 下）：

| 路径 | 说明 | 来源 |
| --- | --- | --- |
| `resources/core/mihomo.exe` | mihomo 内核 | [MetaCubeX/mihomo Releases](https://github.com/MetaCubeX/mihomo/releases) `windows-amd64` |
| `resources/geo/geoip.metadb`、`geosite.dat`、`country.mmdb` | 分流数据 | [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) |

可用环境变量覆盖路径：

| 变量 | 作用 |
| --- | --- |
| `WALLNUT_CORE` | 指定 mihomo 可执行文件路径 |
| `WALLNUT_DATA` | 指定数据目录 |
| `WALLNUT_PORTABLE=1` | 强制便携模式 |

启动：

```bash
npx electron .
```

### 目录结构

```
electron/           主进程（main / ipc / store / tray / 自动启动）
  config/           生成 mihomo 配置
  core/             内核托管：进程管理、REST API、测速
  net/              系统代理
  rewrite/          重写与 MITM 证书
  subs/             订阅下载与解析
renderer/           渲染进程（原生 DOM + Preact/htm，无需构建步骤）
  pages/            各页面视图
  vendor/           预置前端依赖
resources/          图标资源（核心与 geo 数据不入库）
locales.json        界面文案（7 种语言）
package.json
```

### 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。当前版本 **0.4.8**。

### 说明

请遵守所在地区的法律法规，仅将本项目用于合法的网络访问用途。

---

## 繁體中文

**Wallnut** 是給 Windows 的桌面代理客戶端：Electron 外殼 + 內建 [mihomo](https://github.com/MetaCubeX/mihomo) 核心，可攜執行、免安裝。

**名稱由來**：Wallnut 讀作「wall-nut」，諧音 **wall-not**；同時致敬《植物大戰殭屍》裡的**堅果牆**——站在最前面擋住攻擊，讓後面的一切安然無恙。中文名就叫「堅果牆」。

### 功能

- **訂閱管理**：新增、編輯（名稱 / 位址 / 更新間隔）、更新、刪除訂閱；支援 Clash/mihomo YAML、Surge conf、分享連結、base64 與貼上匯入
- **節點與地區**：依國家自動彙整地區組，跨訂閱一起測速找最快節點，可單獨測速與依延遲排序
- **策略組**：地區組 + 自訂組，select / url-test / fallback，可直接在卡片切換
- **分流規則**：本機規則排序與驗證、遠端規則集（依間隔自動更新）
- **重寫**：本機重寫規則、線上重寫規則集、302、請求/回應標頭、回應內容替換、白名單 MITM
- **核心代管**：單一實例、健康檢查、崩潰自動重啟、設定驗證、日誌環形緩衝
- **網路接管**：系統代理、TUN、DNS 與 fake-ip、清除 DNS 快取
- **即時面板**：流量曲線、活躍連線、規則命中、核心記憶體與版本
- **桌面體驗**：系統匣、開機自動啟動、淺色/深色/跟隨系統
- **多語言**：繁體中文、简体中文、日本語、한국어、English、Français、Español

### 下載

到 **Releases** 下載 `Wallnut-v0.4.8-portable-win-x64.zip`，解壓後執行 `Wallnut.exe`，加入自己的訂閱即可。

### 從原始碼執行

```bash
git clone https://github.com/dkleo11/Wallnut.git
cd Wallnut && npm install && npm install --no-save electron
```

自備 `resources/core/mihomo.exe` 與 `resources/geo/*`（來源同上表），然後 `npx electron .`。

### 更新日誌

見 [CHANGELOG.md](CHANGELOG.md)。目前版本 **0.4.8**。

---

## English

**Wallnut** is a desktop proxy client for Windows: an Electron shell with a bundled [mihomo](https://github.com/MetaCubeX/mihomo) core. Portable, no installation required.

**Name**: "Wallnut" reads as *wall-nut*, a pun on **wall-not** — and a nod to the **wall-nut** in *Plants vs. Zombies*: the one that stands in front and takes the hits so everything behind it stays safe.

### Features

- **Subscriptions**: add, edit (name / URL / refresh interval), refresh and remove; Clash/mihomo YAML, Surge conf, share links, base64 and paste import
- **Nodes & regions**: nodes grouped by country, cross-subscription speed tests to find the fastest one, per-node tests and latency sorting
- **Policy groups**: region groups plus custom groups with select / url-test / fallback, switchable straight from the card
- **Routing**: local rule list with ordering and validation, remote rule sets with automatic updates
- **Rewrite**: local rewrite rules, remote rewrite rule sets, 302 redirects, request/response headers, response body replacement, whitelist-based MITM
- **Core supervision**: single-instance management, health checks, crash restart, config validation, ring-buffered logs
- **Network takeover**: system proxy, TUN mode, DNS and fake-ip, DNS cache flush
- **Live dashboards**: traffic charts, active connections, rule hits, core memory and version
- **Desktop**: tray menu, launch at login, light / dark / system theme, close-to-tray
- **Languages**: English, 简体中文, 繁體中文, 日本語, 한국어, Français, Español

### Download

Grab `Wallnut-v0.4.8-portable-win-x64.zip` from **Releases**, unzip anywhere, run `Wallnut.exe`, then add your own subscription.

### Run from source

```bash
git clone https://github.com/dkleo11/Wallnut.git
cd Wallnut && npm install && npm install --no-save electron
```

Supply `resources/core/mihomo.exe` and `resources/geo/*` (see the table above), then `npx electron .`.

### Changelog

See [CHANGELOG.md](CHANGELOG.md). Current version **0.4.8**.

---

## 日本語

**Wallnut** は Windows 向けのデスクトッププロキシクライアントです。Electron のシェルに [mihomo](https://github.com/MetaCubeX/mihomo) コアを内蔵し、インストール不要のポータブル構成で動作します。

**名前の由来**：Wallnut は「wall-nut（ウォールナット）」と読み、**wall-not** に通じます。同時に『Plants vs. Zombies』の**ウォールナット**（クルミの壁）へのオマージュでもあります。前線で攻撃を受け止める、あの壁です。

### 機能

- **サブスクリプション**：追加・編集（名前 / URL / 更新間隔）・更新・削除。Clash/mihomo YAML、Surge conf、共有リンク、base64、貼り付けインポートに対応
- **ノードと地域**：国ごとに自動グルーピング、サブスクリプションをまたいだ速度テストで最速ノードを選択
- **ポリシーグループ**：地域グループ + カスタムグループ、select / url-test / fallback
- **ルーティング**：ローカルルールの並べ替えと検証、リモートルールセットの自動更新
- **リライト**：ローカル/リモートのリライトルール、302、リクエスト・レスポンスヘッダー、レスポンスボディ置換、ホワイトリスト方式の MITM
- **コア管理**：単一インスタンス、ヘルスチェック、クラッシュ時の自動再起動、設定検証、リングバッファログ
- **ネットワーク**：システムプロキシ、TUN モード、DNS と fake-ip、DNS キャッシュ削除
- **ライブ表示**：トラフィックグラフ、アクティブ接続、ルールヒット、メモリとバージョン
- **デスクトップ**：トレイ、ログイン時起動、ライト/ダーク/システムテーマ
- **言語**：日本語、简体中文、繁體中文、한국어、English、Français、Español

### ダウンロード

**Releases** から `Wallnut-v0.4.8-portable-win-x64.zip` を取得し、任意のフォルダに展開して `Wallnut.exe` を実行してください。

### ソースから実行

```bash
git clone https://github.com/dkleo11/Wallnut.git
cd Wallnut && npm install && npm install --no-save electron
```

`resources/core/mihomo.exe` と `resources/geo/*` を用意したうえで `npx electron .` を実行します。

### 変更履歴

[CHANGELOG.md](CHANGELOG.md) を参照。現在のバージョンは **0.4.8** です。

---

## 한국어

**Wallnut**은 Windows용 데스크톱 프록시 클라이언트입니다. Electron 셸에 [mihomo](https://github.com/MetaCubeX/mihomo) 코어를 내장했고, 설치 없이 포터블로 실행됩니다.

**이름의 유래**：Wallnut은 'wall-nut'으로 읽으며 **wall-not**과 발음이 통합니다. 동시에 *Plants vs. Zombies*의 **월넛**(호두 벽)에 대한 오마주입니다. 앞에서 공격을 막아 주는 그 벽입니다.

### 주요 기능

- **구독 관리**：추가, 편집(이름 / 주소 / 갱신 주기), 갱신, 삭제. Clash/mihomo YAML, Surge conf, 공유 링크, base64, 붙여넣기 가져오기 지원
- **노드와 지역**：국가별 자동 그룹화, 구독을 넘나드는 속도 측정으로 가장 빠른 노드 선택
- **정책 그룹**：지역 그룹 + 사용자 그룹, select / url-test / fallback
- **라우팅**：로컬 규칙 정렬·검증, 원격 규칙 세트 자동 갱신
- **리라이트**：로컬/원격 리라이트 규칙, 302, 요청·응답 헤더, 응답 본문 치환, 화이트리스트 MITM
- **코어 관리**：단일 인스턴스, 상태 점검, 비정상 종료 시 자동 재시작, 설정 검증, 링 버퍼 로그
- **네트워크**：시스템 프록시, TUN 모드, DNS와 fake-ip, DNS 캐시 비우기
- **실시간 패널**：트래픽 그래프, 활성 연결, 규칙 적중, 메모리와 버전
- **데스크톱**：트레이, 로그인 시 자동 실행, 라이트/다크/시스템 테마
- **언어**：한국어, 简体中文, 繁體中文, 日本語, English, Français, Español

### 다운로드

**Releases**에서 `Wallnut-v0.4.8-portable-win-x64.zip`을 받아 아무 폴더에 압축을 풀고 `Wallnut.exe`를 실행한 뒤 구독을 추가하세요.

### 소스에서 실행

```bash
git clone https://github.com/dkleo11/Wallnut.git
cd Wallnut && npm install && npm install --no-save electron
```

`resources/core/mihomo.exe`와 `resources/geo/*`를 준비한 다음 `npx electron .`을 실행합니다.

### 변경 내역

[CHANGELOG.md](CHANGELOG.md) 참고. 현재 버전은 **0.4.8**입니다.
