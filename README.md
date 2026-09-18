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
- 検査記録一覧の列別ソート・複数選択絞り込み
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

## Gemini仕切書読込み

Gemini APIキーはGitHub Pagesの変数へ登録せず、Supabase Edge FunctionのSecret `GEMINI_API_KEY` として登録します。必要に応じて `GEMINI_MODEL` と `GEMINI_FALLBACK_MODEL` を設定できます。未設定時は低遅延の `gemini-3.1-flash-lite` を最小思考量で使用し、一時的な混雑が発生した場合は低思考量の `gemini-3.7-flash` へ直ちに切り替えます。

```powershell
npx supabase login
npx supabase link --project-ref gkazhcddknmgzglcdwtk
npx supabase secrets set GEMINI_API_KEY=取得したAPIキー
npx supabase functions deploy analyze-purchase-statement --no-verify-jwt
npx supabase functions deploy purchase-statement-image --no-verify-jwt
```

`--no-verify-jwt` で公開された関数内でも、米穀出荷管理の業務ログイン情報を確認し、管理者または作業者だけが画像解析を実行できます。画像は最大辺1,800pxのJPEGへ端末内で縮小してGeminiへ送信し、登録時にSupabaseの非公開Storageへ保存して仕切書IDと紐付けます。保存画像はログインと権限を確認して発行する10分間の署名付きURLで表示します。

業務管理メニューからは `?app=statements` を付けて専用画面を開きます。専用画面は「仕切書読込」「仕切書一覧」「マスタ」のみを表示し、通常の米穀出荷管理画面とはナビゲーションと保存先を分離します。既存の `?view=statement-reader` も互換URLとして同じ専用画面を開きます。

仕切書は `supabase/migrations/202609180002_purchase_statement_documents.sql` で作成する専用テーブルへ保存します。共通項目は日付、仕切書№、担当者、仕入元、支払方法、消費税区分、税率、消費税額、税込合計金額、登録番号です。支払方法は空欄・現金・振込から選択し、画像取込では左下の「（現金払い・振込払い）」で手書きの丸に囲まれた方を読み取ります。消費税区分は明細表右上の「金額（税抜・税込）」にある丸印を読み取り、税抜なら外税、税込なら内税として保存します。判定時は仕切書全体に加え、税区分、支払方法、明細表をそれぞれ拡大した補助画像を使用し、品名はアプリ専用マスタの候補とも照合します。明細には産年、品名、荷姿、数量、単位、単価、金額を保存します。数量と単位はタイトル行「数量」の真下の列だけから読み取り、品名欄の荷姿表記に含まれる数量は使用しません。「免税」の行は、インボイス登録番号のない仕入元に対する金額として独立した明細に保持し、金額を必ずマイナス値で保存します。数量が記載されていない場合は空欄のまま保存できます。手入力時の税込合計金額は、外税なら明細金額と消費税額を加算し、内税なら税込明細金額だけを合計します。画像取込で税区分に基づく計算と合わない場合は赤太字で警告します。撮影読取りと手入力は同じ確認画面を使用し、読取結果は登録前に修正できます。仕切書一覧の編集画面は画面内でスクロールできるモーダルとして表示します。担当者は画像の「担当者」と「様」の間を読み取り、複数行に分かれた明細は、続きの行の数量・単価・金額がすべて空欄の場合だけ一つへまとめます。産年を省略した明細には、その仕切書で直前に明記された産年だけを引き継ぎ、先頭から不明な場合は警告を表示して手入力を求めます。

既存の在庫取込に保存されていた仕切書は `202609180004_migrate_legacy_purchase_statement.sql` で専用テーブルへ複製します。旧在庫データは削除せず、同じ仕切書№の複数行を1仕切書の複数明細として移行します。
