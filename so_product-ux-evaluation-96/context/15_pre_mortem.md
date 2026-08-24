# Pre-Mortem

## 実査前

1. 手入力scoreを再利用して点が再現できない。対策: 固定rubricと計算scriptを先に作る。
2. mockや静的確認だけで96点を付ける。対策: evidence capとunverified 0点を適用する。
3. 見た目の修正で完遂不能を隠す。対策: fresh Local、遷移、操作、復旧を先に測る。
4. Cloudflareを暗黙に変更する。対策: host、policy、artifact、rollback、tenantを別承認にする。

## 改善後

1. 92.7点を96点と丸めて報告する。対策: live未検証を0点のまま保持する。
2. 同じ画面修正を続けても総合点が動かない。対策: 残点差をCloud、AI parity、team boundary、manual readingへ分解する。
3. live実査がproduction dataへ混入する。対策: synthetic tenantとmanifest IDだけで作成・archiveする。
4. OAuth成功だけでhookやrevokeまで合格にする。対策: 一つずつterminal readbackを保存する。
