# フレコントレース

玄米フレコンの6桁ロット番号をスマートフォンで連続読取し、納品先ごとに一括出荷登録するPWAです。

## 主な機能

- にんにく冷蔵庫管理と共通の作業者・PINログイン
- 納品先の登録・編集・使用停止
- 運送会社名の登録・編集・使用停止
- 背面カメラによるQR連続読取
- 予定本数のカウンターと重複防止
- 予定本数到達時の出荷情報入力ポップアップ
- 読取途中データの端末保存
- 1本から24本までの一括出荷登録
- 出荷済みロットの再登録防止
- 出荷日時、ログイン担当者、運送情報を含む出荷履歴の検索とCSV出力
- 管理者による出荷履歴の編集・削除
- 委任状情報の一覧・検索・追加・編集・削除
- `検査記録.xlsm` の「委任状一覧」シートから確認付き一括取込

## ローカル起動

```bash
npm install
copy .env.example .env.local
npm run dev
```

`.env.local` に、にんにく冷蔵庫管理で使用しているSupabaseのProject URLとPublishable keyを設定します。Secret keyやService role keyはフロントエンドに置かないでください。

## Supabase設定

にんにく冷蔵庫管理のSupabase Dashboardを開き、SQL Editorで次のファイルの全内容を実行します。

```text
supabase/migrations/202609010001_shared_garlic_supabase.sql
supabase/migrations/202609020001_shipping_details.sql
supabase/migrations/202609020002_transport_company_only.sql
supabase/migrations/202609020003_admin_shipment_history.sql
supabase/migrations/202609020004_authorizations.sql
supabase/migrations/202609020005_authorization_excel_import.sql
```

上記6ファイルを上から順に実行します。`202609020004_authorizations.sql` まで実行済みの場合は、`202609020005_authorization_excel_import.sql` の全内容だけを追加実行してください。

委任状一覧の `Excel取込` では `.xlsm` または `.xlsx` を選択します。シート名と見出しを検証してから、№が同じ行を更新し、新しい№を追加します。Excel側で空欄のフラグは、登録済みの値を変更しません。

利用者は、にんにく冷蔵庫管理の作業者マスタで管理します。使用する作業者を有効にし、備考欄へ `PIN:1234` の形式でPINを設定してください。フレコントレース側で利用者を重複登録する必要はありません。

作業者名、権限、有効・無効、PINは両アプリで共通です。ログイン状態はブラウザとアプリごとに保存されるため、初回はフレコントレース側でも同じ作業者とPINでログインします。

フレコン用のテーブルとRPCにはすべて `flexcon_` を付けています。にんにく冷蔵庫管理の既存テーブルは変更しません。旧フレコン専用Supabaseのデータも、このSQLでは削除されません。

## ビルド

```bash
npm run build
```

## GitHub Pagesへの公開

GitHubリポジトリの `Settings` > `Secrets and variables` > `Actions` > `Variables` に、にんにく冷蔵庫管理のSupabase情報として次の2項目を登録します。

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
```

次に `Settings` > `Pages` の `Source` で `GitHub Actions` を選択します。`main` ブランチへpushすると、ワークフローがビルドして次のURLへ公開します。

```text
https://eight-corp.github.io/flexcon-trace/
```

カメラ利用にはHTTPSが必要ですが、GitHub Pagesの公開URLはHTTPSに対応しています。
