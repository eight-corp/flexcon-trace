# フレコントレース

玄米フレコンの6桁ロット番号をスマートフォンで連続読取し、納品先ごとに一括出荷登録するPWAです。

## 主な機能

- 管理者が事前登録したユーザーだけのSupabaseメール認証
- 納品先の登録・使用停止
- 背面カメラによるQR連続読取
- 目標12本のカウンターと重複防止
- 読取途中データの端末保存
- 1本から24本までの一括出荷登録
- 出荷済みロットの再登録防止
- 出荷履歴の検索とCSV出力

## ローカル起動

```bash
npm install
copy .env.example .env.local
npm run dev
```

`.env.local` にSupabaseのProject URLとPublishable keyを設定します。Secret keyやService role keyはフロントエンドに置かないでください。

## Supabase設定

Supabase DashboardのSQL Editorで、次のファイルを開いて全内容を実行します。

```text
supabase/migrations/202608270001_initial_schema.sql
```

その後、Supabase DashboardのAuthentication設定で `Allow new users to sign up` を無効にします。利用者は `Authentication` > `Users` > `Add user` から管理者が作成し、メール確認済みの状態と初期パスワードを設定します。アプリには一般向けのアカウント作成機能を置きません。

## ビルド

```bash
npm run build
```

## GitHub Pagesへの公開

GitHubリポジトリの `Settings` > `Secrets and variables` > `Actions` > `Variables` に、次の2項目を登録します。

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
```

次に `Settings` > `Pages` の `Source` で `GitHub Actions` を選択します。`main` ブランチへpushすると、ワークフローがビルドして次のURLへ公開します。

```text
https://eight-corp.github.io/flexcon-trace/
```

カメラ利用にはHTTPSが必要ですが、GitHub Pagesの公開URLはHTTPSに対応しています。
