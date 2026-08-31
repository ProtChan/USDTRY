# USD/TRY Swap Watch

ヒロセ通商 LION FX の **USD/TRY 売りスワップ**を、円換算かつ「1日あたり」に正規化して可視化する静的サイトです。

- 公開サイト: https://protchan.github.io/USDTRY/
- 公式ページ: https://hirose-fx.co.jp/contents/news/Swap
- 公式過去CSV: https://hirose-fx.co.jp/swap/lionfx_swap.csv
- 集計開始日: 2026-07-01
- 単位: 1 Lot = 1,000 USD
- 正規化: 円換算後の売りスワップ ÷ 付与日数

GitHub Actions が毎日 10:30 JST にデータを確認し、変更がある場合だけ履歴を更新します。GitHub Pages は Actions から自動デプロイされます。
