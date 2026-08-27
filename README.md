# フレコントレース

玄米フレコンの6桁ロット番号をスマートフォンで連続読取し、納品先ごとに一括出荷登録するPWAです。

## 主な機能

- Supabaseメール認証
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

その後、AuthenticationのEmail providerが有効であることを確認します。確認メールを省略する試験運用では、Authentication設定のConfirm emailを無効にできます。

## ビルド

```bash
npm run build
```

生成された `dist` をCloudflare Pagesへ公開します。Git連携時の設定は次のとおりです。

```text
Build command: npm run build
Build output directory: dist
```

Cloudflare Pagesの環境変数にも次を登録します。

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
```
