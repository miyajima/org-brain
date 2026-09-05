# Router v3.3 共通基準によるnative再レビュー

既存120件を同じ基準で再評価する、ローカル成果物用のアダプタ。
通常Router、旧v3.3契約、旧回答、UI、DBには接続しない。
直接API、app server、埋め込み、学習、fallbackは実装していない。

## 実行順序

1. `node scripts/memory-extraction-router-v33-rereview.mjs prepare --manifest SOURCE_MANIFEST --previous-labels PREVIOUS_LABELS --out NEW_PRIVATE_DIRECTORY`
   - outは存在しないディレクトリを指定する。sourceは既存v3.3のdevelopment 120件、previousはnativeラベル成果物を指定する。
   - 本文、group、fold、元ラベル、共通基準をhashで固定する。旧ラベルは親の比較用にのみ参照する。
2. fresh-contextのSol/mediumに `sol/instructions.json` と `sol/batch-01.json`〜`batch-12.json` だけを渡す。
   - 出力は `answer-01.json`〜`answer-12.json`。各10件の配列。初回を保存後は変更禁止。ファイル0600。
   - 子は個別に本文を評価する。外部呼び出し、他方の回答・予測の参照、再帰的な委譲は禁止。
3. 親は `checkpoint --manifest NEW_MANIFEST` で受領し、初回のraw JSONを別ファイルへ不変保存する。
4. 当該モデルの120件が揃ったら `repairs --manifest NEW_MANIFEST --channel sol` を実行する。
   - 件数0なら追加実行不要。件数ありなら同じ子に `sol/repairs.json` だけを渡し、`repair-answers.json` へ1回だけ出力させる。
   - 修復できない場合も元回答を返す。再修復は行わず、検証不通過を保留として残す。
5. Sol終了後、Luna/highで手順2〜4を実施する。同時に動く実行子は1名までとする。
6. 各子の最終回答後、`runtime --manifest NEW_MANIFEST --channel sol --parent-log PARENT_LOG --task NATIVE_TASK_NAME` で実際のnative metadataを記録する。Lunaも同様。
7. `finalize --manifest NEW_MANIFEST` で `final/` を新規作成する。未回答・未実施の形式修正があれば拒否する。二度目のfinalizeは拒否する。

`inspect` は読取専用。再開時は既存の新revisionの回答を再利用し、`prepare`や完了バッチを再実行しない。

## 検証と境界

- 引用は一意に見つかる完全一致のみ。文字位置はUTF-16でローカル計算し、既存validatorを再利用する。
- 形式修正は同じラベル・判断文・lesson type・confidence・根拠数・turn IDを保持する。
- 引用修正は空白・引用符表記の違いだけを認める。これはモデルの修正案を制限する検査であり、本文の近似一致や自動補正ではない。演算子・数値・単語変更は拒否する。
- 曖昧な引用、識別子不明、別turn参照は自動修復対象にしない。意味上の不一致にも修復依頼を作らない。
- 初回と修復の両方を保持し、両者が有効・accepted・同じラベルの場合のみ確定する。正規根拠はSol側。
- sampled development 80件の確定72・耐久20・運用20・group30を検査する。不足時は `insufficient_ai_review_support`。
- 候補率47%に対するTP上限は `min(D, floor(47*N/100), floor(47*S/100))`。Recall95%に届かなければ `target_constraints_infeasible` を併記する。
- 件数条件を満たしてもAI補助開発評価にすぎない。旧revisionとのラベル遷移は正解率改善の証拠ではない。
- native metadataは実行設定の証拠であり、プロバイダー内部のモデル保証ではない。取得できない場合は未検証と記録する。
- runは0700、ファイル0600。実行内容はCodexの非公開セッションログにも残る。共有ファイルシステムをAPI式の隔離と表現しない。

## テスト

`node --test scripts/memory-extraction-router-v33-rereview.test.mjs`

既存v3.3のcloud/core/CLIテスト、対象eslint、`git diff --check`も実行する。
テスト内の会話は単体テスト専用であり、実験の120件へ混入させない。
