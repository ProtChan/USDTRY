# USD/TRY Carry Dashboard

ヒロセ通商 LION FX の **USD/TRY 売りスワップ**と、同じ時間軸に揃えた為替差損を可視化する静的ダッシュボードです。

- 公開サイト: https://protchan.github.io/USDTRY/
- ヒロセ公式: https://hirose-fx.co.jp/contents/news/Swap
- 集計開始: 2026-07-01
- 基準Lot: 1,000 USD
- 為替アンカー: 原則 23:00 JST の1時間足終値
- 複数日付与: 曜日固定ではなくヒロセ公表 `days >= 3` で判定

## Architecture

```text
Hirose swap page ──> scripts/build_data.py ──┐
                                             ├─> scripts/update_data.py ─> data/usdtry.json
Yahoo 1h FX data ──> scripts/align_market_day.py ┘          │
                                                              v
                                                       index.html
                                                       styles.css
                                                       app.js
```

責任範囲を重複させない構成です。

- `scripts/build_data.py`: ヒロセの公表スワップだけを取得・正規化する。
- `scripts/align_market_day.py`: USD/TRY と USD/JPY を同一時刻で揃え、TRY/JPYと為替差損を計算する。
- `scripts/update_data.py`: 上記2段を順番に実行し、日付・正規化・クロスレート・区間計算を検証してから最終JSONを書き出す唯一の本番エントリポイント。
- `app.js`: 状態管理、KPI、全チャート、テーブル、CSV出力を一元管理する。後から別JSが関数を上書きする方式は使わない。
- `styles.css`: PC/タブレット/スマホを一つのレスポンシブ定義で管理する。
- `beta/`: 旧β URL互換用の統合版リダイレクトのみ。

## Data definitions

### Swap / day

```text
ヒロセ公表の売りスワップ円額 ÷ 公表付与日数
```

### Fixed FX rate

USD/TRY と USD/JPY の **同一JST時刻**の1時間足終値を使用します。23:00 JSTを優先し、欠損時のみ両通貨が揃う時刻を最大3時間前まで探します。TRY/JPYは同じ観測から `USDJPY / USDTRY` で作ります。

### FX interval cost

```text
USD数量 × (次回固定USD/TRY − 当日固定USD/TRY) × 次回TRY/JPY
```

正の値はUSD/TRYショートにとって為替差損、負の値は為替差益です。日次表示だけは次回ヒロセ日付までの実カレンダー日数で割ります。複数日スワップの公表日数では割りません。

## Deployment

GitHub Actions は平日の想定公表時間帯を約5分間隔で軽量監視し、新規・訂正行があった場合にだけ本番パイプラインを実行します。15:37 JSTにはレート訂正等を拾うため強制再計算します。パイプライン・データ検証・静的ビルドが成功した場合のみGitHub Pagesへデプロイします。
