# Console UX 録画評価

## 対象

- 1440×900 の字幕・クリック強調付き操作録画
- 390×844 の初回操作・横幅監査
- Home → Decision → Access Drawer → Decision Trace Map → 全知識3Dマップ → Skill生成 → Agent context preview → Reviews

## 暫定スコア: 83 / 100

| 観点 | 点数 | 観測 |
| --- | ---: | --- |
| 理解・導線 | 19/20 | 決定→理由→根拠→成果物、全知識表示、Skill/Agent/Reviewsの流れが明確 |
| アクセシビリティ | 18/20 | キーボード用2Dリスト、状態通知、44px操作領域を確認。VoiceOver実機は未実施 |
| 初回操作・レスポンシブ | 14/20 | Mapの主要操作は390pxで見えるが、Home検索・カード、Skill送信、Agentフォームは初期viewport外 |
| 操作効率 | 15/20 | 初回カーソル配置を除き、700px以上の移動が9操作。上部操作と下部リストの往復がある |
| フィードバック・性能 | 17/20 | 字幕、loading/fallback、reduced-motion、truncationは確認。WebGL ReadPixels stall警告が4件 |

## スクロールが必要だった箇所

- Decision Mapの2D「根拠」ボタン: `+400px`。その後「全知識を表示」へ戻るため `-400px`。
- Skillのprivate draft生成: `+205px`。390px幅では送信ボタンが `y=1338`。
- Agentのcontext preview: `+576px`。390px幅ではtextareaが `y=1746`、送信が `y=1954`。
- AgentからReviewsへ移動: `-637px` の上方向移動。

## マウス移動が大きかった箇所

Playwrightのターゲット中心間距離で計測。初回カーソル配置を除くと700px以上が9操作。

- 推論関係トグル: 985px
- Agentへのナビゲーション: 942px
- 根拠ノード選択: 919px
- Skill化操作: 897px
- Reviewsへのナビゲーション: 898px
- Access Drawer: 756px

## 改善優先度

1. **P0 モバイルHome**: ヒーロー領域を圧縮し、検索と最初の決定カードを390×844の初期viewportへ移す。
2. **P0 Agentモバイル**: preview formを`minmax(0, 1fr)`と`width:100%`で再配置し、送信ボタンを画面内へ置く。現状は要素幅722px・x=595で画面外に出る。
3. **P1 Map**: 2Dリストと「全知識を表示」を同じsticky action railへまとめ、上下400pxの往復をなくす。
4. **P1 コンテキスト保持**: Skills/Agentsのグローバル遷移でdecision_id・agent_idを失わない導線を追加する。
5. **P1 3D性能**: `ReadPixels`の頻度を抑え、1,500ノード負荷で長時間タスクと初回操作時間を測定する。

