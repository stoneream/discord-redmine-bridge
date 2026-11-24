# Discord Redmine Bridge

Discord から Redmine のチケットを作成できる Bot です。

## セットアップ

### Discord アプリケーションの作成

Discord Developer Portal でアプリを作成し、Bot トークンを取得します。  
Installation の Guild Install で `bot` と `applications.commands` を選び、Bot を対象のサーバーにインストールします。  
インタラクションは Gateway で受け取るため、Interactions Endpoint URL は空欄にしてください。  

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Building your first Discord Bot - Documentation - Discord](https://docs.discord.com/developers/quick-start/getting-started)

インストールURL例 : `https://discord.com/oauth2/authorize?client_id=0123456789&scope=bot+applications.commands&permissions=0&integration_type=0`

### Redmine の設定

Redmine の管理画面で REST API を有効にします。  
対象プロジェクトでチケットの追加権限を持つ連携用アカウントを用意し、アカウントの API キーを取得します。  
作成者は Redmine 上で連携用アカウントになります。  

- [Rest api - Redmine](https://www.redmine.org/projects/redmine/wiki/Rest_api)

### 環境変数

| 環境変数 | 値 |
| --- | --- |
| `DISCORD_TOKEN` | Discord Bot のトークン |
| `DISCORD_GUILD_ID` | Bot をインストールした Discord サーバーの ID |
| `REDMINE_URL` | Redmine の URL） |
| `REDMINE_API_KEY` | Redmine の連携用アカウントの API キー |

### 使い方

`/ticket` コマンドから、プロジェクトの選択・チケット名を入力することでチケットを作成することができます。

## 開発

### Required

- [mise](https://mise.jdx.dev)

### セットアップおよびコマンド

```sh
# setup
mise trust
mise install
cp mise.dev.local.sample.toml mise.dev.local.toml

# commands
mise run dev
mise run format
mise run lint
mise run test
```
