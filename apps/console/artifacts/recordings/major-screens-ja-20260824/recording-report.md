# OrgBrain 主要画面操作録画

## 成果物

- `ux-evaluation-ja.mp4`: 配布用MP4。86.56秒、1440×900、25fps、H.264、字幕焼き込み。
- `recording.webm`: Playwrightの原本録画。
- `player.html`: MP4/WebMをローカル再生するプレイヤー。
- `recording-manifest.json`: 録画方式、画面サイズ、成果物パス。
- `metrics.json`: 26操作の遷移、スクロール、対象位置と390×844のmobile確認。
- `browser-diagnostics.json`: console、page error、request failureの診断。
- `preflight-dom.json`と`preflight-*.png`: 録画直前に確認した7画面のDOMと画面証拠。

## 収録した流れ

1. 決定一覧の検索。
2. 決定詳細から理由・根拠を確認。
3. アクセス設定を開き、同じ画面で閉じる。
4. 決定の道筋マップで全体表示、推論関係、2D関係リストを操作。
5. 全知識3Dマップで閲覧可能な62ノードを全表示。
6. 決定から非公開のスキル下書きを生成。
7. エージェントの利用構成と、実際に渡るコンテキストを確認。
8. 要確認の決定で残る不足を確認。

字幕は動画内オーバーレイへ焼き込み、外部VTTは生成していない。各操作にはクリック位置と対象領域の強調を付けた。

## 検品結果

- 26/26ステップ完遂。
- preflight対象7/7画面へ到達。
- page error 0件、request failure 0件、console error 0件。
- mobile確認5画面で横スクロール0件。
- MP4全体をffmpegでデコードし、エラー0件。
- ChromiumのWebGL読み戻しによる性能警告が4件ある。描画失敗ではなく、録画中の3Dマップのフレーム読み出しに伴う既知警告として診断ログへ保存した。

## SHA-256

- `ux-evaluation-ja.mp4`: `dcd77ddf1b2adc1c21c8870d7854fc4927160eae44742a8f5742942c1eeb1020`
- `recording.webm`: `c0dadfb23ba1d7cc9e932922f4f920d24aa2fd18bfe820a10a5a7ed920fc65d7`
