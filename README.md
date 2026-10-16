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

## 検査記録の統合

検査記録は委任状ごとに一件へまとめます。追加時はDBで委任状をロックして既存登録へ明細を追加し、仕入日・検査日・仕切書番号・在庫用の搬入先は明細ごとに保持します。一覧の等級・仕切書番号・日付・検査場所は重複を除いて表示し、数量は合算します。仕切書番号は明細で編集でき、検査場所を後から編集しても初期搬入先や在庫移動履歴は変更しません。

対応SQLは `supabase/migrations/202609290001_consolidate_inspection_authorizations.sql` です。既存の同一委任状の明細を最初の登録へまとめますが、元の登録ヘッダー・明細・ロット番号は削除しません。倉庫別・産年別の在庫が適用前後で一致しなければ全体をロールバックします。DBへ適用した後に対応画面を公開してください。

一括設定の「対象検査日」は全体・既存の検査日・未設定から選択でき、推フレの番号範囲と組み合わせて対象を限定します。バラは対象外です。対応SQLは `supabase/migrations/202610150002_inspection_metadata_date_scope.sql` で、検査日を上書きするときも変更前の日付で対象を確定します。DBへ適用した後に画面を公開してください。

`npm test` は隔離されたPostgreSQLで統合・追加・紙袋分割・明細編集・日付別一括設定を検証します。`npm run build` の後に `npm run test:inspection-browser` を実行すると、ChromeでPC・スマートフォン幅の追加・一括設定操作を検証します。Chromeのインストールが必要です。ブラウザテストの通信・業務ログイン・DB書き込みはすべてテスト用に置き換えます。

## 操作者ごとの1回取消

米穀出荷管理と仕切書読込みの保存操作は、DB内の保護された `flexcon_undo_private` に変更前後を記録します。共通ヘッダー位置のUndoアイコンから、ログイン中の操作者の最新1操作だけを取り消せます。複数行の一括設定・取込みや、仕切書保存後の画像添付は1操作です。画面表示・検索・保存失敗・値が変わらない保存では履歴を更新しません。取り消した後にさらに前の操作へ戻ることや、やり直しはできません。

関連行・参照先・ロットが後から変更・使用された場合は取り消しを拒否します。入出庫や出荷などの在庫関連操作は、明示的な参照がない在庫依存もあるため、後続の在庫関連変更があれば保守的に拒否します。権限は取消時にも確認します。全変更は1トランザクションで復元し、外部キー・一意性・業務検証を満たさなければ全体をロールバックします。FKは通常の保存では即時検証、取消中のみトランザクション内で遅延検証します。採番シーケンスは巻き戻しません。

仕切書画像は非公開のStorage内に不変の別名で保存し、削除時も取消用コピーを保持します。画像参照の復元には `purchase-statement-image` の更新が必要です。保持した画像の自動削除は行いません。印刷物・実際の荷物移動・外部送信・保存前のフォーム操作は取消対象外です。導入前の操作も対象外です。

先に `supabase/migrations/202610160001_operator_undo.sql` を適用し、Edge Function `purchase-statement-image` を更新してから画面を公開してください。新しい業務テーブル・書込みRPCを追加した場合は同マイグレーションを再実行し、登録対象を更新してください。`npm test` は実アプリの全SQLを隔離DBへ適用して取消・競合・権限・在庫整合性を検証します。`npm run test:undo-browser` はPC・スマートフォン幅、全タブ・ダイアログ上のボタン位置、同時保存・別端末操作を検証します。

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

## 仕切書のAI読込み

APIキーはGitHub Pagesの変数へ登録せず、Supabase Edge FunctionのSecretへ登録します。仕切書の画像読取りはGemini APIに統一しています。必要に応じて `GEMINI_MODEL` と `GEMINI_FALLBACK_MODEL` を設定できます。

```powershell
npx supabase login
npx supabase link --project-ref gkazhcddknmgzglcdwtk
npx supabase secrets set GEMINI_API_KEY=取得したAPIキー
npx supabase functions deploy analyze-purchase-statement --no-verify-jwt
npx supabase functions deploy purchase-statement-image --no-verify-jwt
```

`--no-verify-jwt` で公開された関数内でも、米穀出荷管理の業務ログイン情報を確認し、管理者または作業者だけが画像解析を実行できます。画像は最大辺1,800pxのJPEGへ端末内で縮小して選択中のAIへ送信し、登録時にSupabaseの非公開Storageへ保存して仕切書IDと紐付けます。保存画像はログインと権限を確認して発行する10分間の署名付きURLで表示します。

業務管理メニューからは `?app=statements` を付けて専用画面を開きます。専用画面は「仕切書読込」「仕切書一覧」「マスタ」のみを表示し、通常の米穀出荷管理画面とはナビゲーションと保存先を分離します。既存の `?view=statement-reader` も互換URLとして同じ専用画面を開きます。

仕切書は `supabase/migrations/202609180002_purchase_statement_documents.sql` で作成する専用テーブルへ保存します。共通項目は日付、仕切書№、担当者、仕入元、支払方法、消費税区分、税率、消費税額、税込合計金額、登録番号です。支払方法は空欄・現金・振込から選択し、画像取込では左下の「（現金払い・振込払い）」で手書きの丸に囲まれた方を読み取ります。消費税区分は明細表右上の「金額（税抜・税込）」を高コントラストで拡大し、明細全体の読取りと並行して専用判定します。税抜なら外税、税込なら内税として、専用判定の結果を優先して保存します。判定時は仕切書全体に加え、税区分、支払方法、明細表をそれぞれ必要十分な大きさに拡大した補助画像を使用し、品名はアプリ専用マスタの候補とも照合します。通常は高速モデルを使用し、20秒以内に応答しない場合だけ高精度モデルへ切り替えます。各モデルには待ち時間の上限を設けます。明細には産年、産地、品名、荷姿、数量、単位、単価、金額を保存します。画像内の「青森 青天のへきれき」のような表記は、産地「青森」と品名「青天のへきれき」に分けて保存します。既存明細の品名は自動変更せず、新しい読取りと編集時から分離して記録します。数量と単位はタイトル行「数量」の真下の列だけから読み取り、品名欄の荷姿表記に含まれる数量は使用しません。「免税」の行は、インボイス登録番号のない仕入元に対する金額として独立した明細に保持し、金額を必ずマイナス値で保存します。数量が記載されていない場合は空欄のまま保存できます。手入力時の税込合計金額は、外税なら明細金額と消費税額を加算し、内税なら税込明細金額だけを合計します。単価、明細金額、消費税額、税込合計金額は、入力値を変えずに3桁ごとのカンマで表示します。画像取込で税区分に基づく計算と合わない場合は赤太字で警告します。撮影読取りと手入力は同じ確認画面を使用し、読取結果は登録前に修正できます。仕切書一覧の編集画面は画面内でスクロールできるモーダルとして表示します。担当者は画像の「担当者」と「様」の間を読み取ります。明細は基本的に印刷された1行を1明細としますが、数量・単価・金額がすべて空欄の行は明細として保存しません。その行の品名、産地、産年は次の数値入り明細への引継ぎ情報、荷姿は対応する明細の補足情報としてだけ使用します。数量と単価があり品名欄が荷姿だけの行は独立した明細とし、直近の産年、産地、品名を引き継ぎます。産年を省略した明細には、その仕切書で直前に明記された産年だけを引き継ぎ、先頭から不明な場合は警告を表示して手入力を求めます。

既存の在庫取込に保存されていた仕切書は `202609180004_migrate_legacy_purchase_statement.sql` で専用テーブルへ複製します。旧在庫データは削除せず、同じ仕切書№の複数行を1仕切書の複数明細として移行します。
