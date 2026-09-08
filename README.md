# (株)エイト 米穀出荷管理

玄米フレコンの11桁ロット番号（西暦4桁＋委任状№4桁＋フレコン№3桁）をスマートフォンで連続読取し、納品先ごとに一括出荷登録するPWAです。移行前に発行した6桁・7桁QRも読み取れます。

## 主な機能

- にんにく冷蔵庫管理と共通の作業者・PINログイン
- 納品先の登録・編集・使用停止
- 運送会社名の登録・編集・使用停止
- 背面カメラによるQR連続読取
- QR読取時の出荷済みロット確認
- スマートフォン対応の出荷予定本数直接入力・増減ボタンと重複防止
- 予定本数到達時に自動表示する出荷情報入力ポップアップ
- 読取途中データの端末保存
- 1本から24本までの一括出荷登録
- 出荷済みロットの再登録防止
- 出荷日時、ログイン担当者、運送情報を含む出荷履歴の検索とCSV出力
- 秒を省略した出荷日時表示と領域外クリックで閉じる一覧列絞り込み
- 納品先・品名別の出荷数量集計
- 管理者による出荷履歴の編集・削除
- 委任状情報の一覧・検索・追加・編集・削除
- `検査記録.xlsm` の「委任状一覧」シートから確認付き一括取込
- 検査記録上部で委任状一覧から生産者を絞り込むフレコン・紙袋・バラの追加登録
- 委任状一覧から開く生産者別フレコン・紙袋一覧の閲覧専用表示
- 検査記録の登録行ごとに対象を絞った検査結果入力
- 検査記録の一覧タブと検査数量の集計タブ
- 編集画面で推フレ・紙袋・バラを分けた一覧表示、推フレ・バラ別№、各検査結果の直接入力
- 紙袋行の銘柄、数量、等級、水分、理由の直接入力と2行分割
- 生産者ごとの検査数量集計
- 産年・産地・銘柄別の検査済み数量・未検査数量集計
- 検査済み・未検査詳細一覧から個別のフレコン・紙袋へ移動
- 推フレ・バラそれぞれで№範囲を指定したA5横の検査証明書PDF作成
- 銘柄米・飼料用玄米の検査証明書様式自動切替と11桁QR出力
- 検査証明書QR下部の管理用ロット情報表示
- 検査証明書の印刷回数・最終印刷日時の記録と印刷済み表示
- 検査完了行を対象とした格付結果通知票PDF作成
- Excelの様式第6号に合わせた検査請求者別検査台帳PDF作成
- 検査台帳数量の推フレ量目・バラ実重量・紙袋30kg換算

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

検査記録の旧形式から生産者・仕入日別の新形式へ切り替える場合は、既存の検査項目SQLを実行した後、次のファイルの全内容を実行します。このSQLは旧 `flexcon_inspection_records` の登録データを消去します。

```text
supabase/migrations/202609040003_producer_inspection_records.sql
supabase/migrations/202609040004_brand_group_inspection_entries.sql
supabase/migrations/202609040005_inline_inspection_fields.sql
supabase/migrations/202609040006_flat_producer_inspections.sql
supabase/migrations/202609040007_split_paper_bags.sql
supabase/migrations/202609050001_certificate_print_status.sql
supabase/migrations/202609050003_year_prefixed_lot_numbers.sql
supabase/migrations/202609050010_inspection_officers.sql
supabase/migrations/202609050011_origin_terminology.sql
supabase/migrations/202609050012_inspection_option_descriptions.sql
supabase/migrations/202609070001_paper_bag_shipment_products.sql
supabase/migrations/202609070002_mixed_flexcons.sql
supabase/migrations/202609070003_mixed_flexcon_source_records.sql
supabase/migrations/202609070004_mixed_flexcon_edit_delete_usage.sql
supabase/migrations/202609070005_mixed_dates_and_bulk_flexcon.sql
supabase/migrations/202609070006_mixed_flexcon_shipping.sql
supabase/migrations/202609070007_inspection_registration_summary.sql
supabase/migrations/202609080001_retire_mixed_source_restriction.sql
supabase/migrations/202609080002_separate_standard_bulk_numbers.sql
```

`202609050001_certificate_print_status.sql` まで実行済みの場合は、`202609050003_year_prefixed_lot_numbers.sql` 以降を順番に実行してください。委任状一覧からは従来どおり生産者詳細を開き、検査記録の一覧は生産者詳細で追加した単位を登録No.順に表示します。年度、仕入日、検査日、検査場所、銘柄、数量、水分、等級、理由は各行で直接編集できます。紙袋は合計袋数を変えずに2行へ分割できます。検査証明書はExcelを起動せず、ブラウザ内でA5横の複数ページPDFとして作成します。新しいQRは西暦4桁＋委任状№4桁＋フレコン№3桁の11桁です。

委任状一覧の `Excel取込` では `.xlsm` または `.xlsx` を選択します。シート名と見出しを検証してから、№が同じ行を更新し、新しい№を追加します。Excel側で空欄のフラグは、登録済みの値を変更しません。

利用者は、にんにく冷蔵庫管理の作業者マスタで管理します。使用する作業者を有効にし、備考欄へ `PIN:1234` の形式でPINを設定してください。(株)エイト 米穀出荷管理側で利用者を重複登録する必要はありません。

作業者名、権限、有効・無効、PINは両アプリで共通です。ログイン状態はブラウザとアプリごとに保存されるため、初回は(株)エイト 米穀出荷管理側でも同じ作業者とPINでログインします。

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
