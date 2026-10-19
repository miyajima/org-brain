// Aggregate-only report. This never loads prompts, conversation text, or API bodies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=path.join(os.homedir(),'.org-brain/evaluations/extraction-retention-20261018/qwen-live-20261018');
const s=JSON.parse(fs.readFileSync(path.join(root,'summary-final.json')));
if(s.partial)throw Error('final_summary_required');
const out='artifacts/extraction-retention-20261018/qwen-live';
const all=Object.values(s.projects),paired=Object.values(s.matched_pairs.projects);
const sum=(rows,fn)=>rows.reduce((n,p)=>n+fn(p),0);
const facets=['reason','condition','reported_verification'];
const facetNames={reason:'理由 R',condition:'条件・例外・留保 B',reported_verification:'検証・結果の報告 V'};
const attempted=sum(all,p=>p.before.responses+p.after.responses);
if(attempted!==188)throw Error('all_188_attempts_must_be_settled');
const costUpper=s.costs.total_usd+s.costs.unresolved_reserved_usd;
const ratio=(n,d)=>d?`${n}/${d}`:'—';
const retained=(arm,facet,raw=false,sentences=false)=>sum(paired,p=>p[arm][sentences?(raw?'retained_sentences_raw':'retained_sentences_accepted'):(raw?'retained_raw':'retained_accepted')]?.[facet]??0);
const den=(f,sentences=false)=>sum(paired,p=>p[sentences?'presented_sentences':'presented_units'][f]);
const counts=arm=>({raw:sum(paired,p=>p[arm].raw_candidates),rawEmpty:sum(paired,p=>p[arm].raw_empty_fields),accepted:sum(paired,p=>p[arm].accepted_candidates),empty:sum(paired,p=>p[arm].accepted_empty_semantic_content)});
const b=counts('before'),a=counts('after');
const report=`# OpenRouter QwenによるOrgBrain抽出の実モデル比較

観測時刻: ${new Date().toISOString()}。固定した実データを実際の外部モデルへ送り、改善前後を比較した。入力・API生応答は非公開の隔離領域に保存し、本番設定や既存記憶は変更していない。

## 結論

今回の実モデル試験では、理由・条件・例外・検証報告の保持改善を実証できなかった。候補の受理数だけでは品質を評価できず、本文の空の候補、引用条件を満たさない出力、入力時点の欠落が確認された。下表は人手の意味判定ではなく、固定した証拠区間の引用保持を測る。

同じMemHubモデルID \`qwen/qwen3-235b-a22b-2507\` は**無料ではない**。今回固定した配信先DeepInfraの料金は100万トークンあたり入力 **$0.09**、出力 **$0.55**。モデル一覧と配信先APIの観測値を \`pricing.json\` に記録した。口座への入金・支払手数料はこの料金に含めない。

## 固定条件と比較対象

- MemHubの443記憶から復元された100のuser/assistant入力組と、既存18完了ターンのコーパスを使用。443記憶を443入力として扱っていない。
- 118ケースのうち安全条件で24ケースを除外し、94組に固定。同一の証拠パケットを前後へ送信。AImaは未取得0件。対象外・内部推論・子エージェント履歴・評価会話は追加しない。
- 改善前のプロンプト＋検証器と、先行実装後のプロンプト＋検証器を比較。実行前のソースハッシュを記録。両側の出力を両側の検証器でも再生し、プロンプト差と変換差を分ける。
- 通常v2の隔離評価として任意ルーティングを迂回した。coverage/v1全経路、実運用フック、MemHubそのものとの同条件比較ではない。原資料の補助履歴を含むMemHubの443件と数値を直接比較しない。
- 配信先DeepInfra固定・フォールバックなし・ZDR要求・データ収集deny要求。temperature=0、seed=418、候補最大3、出力最大800、入力上限2,000（UTF-8バイトによる保守的上界）。各ケースの実行順を固定して交互化。1ケース1回ずつ、再試行なし。
- 188回の抽出試行＋疎通確認1回。上限$1。MemHubと同じモデル・サービスを確認したが、既存環境変数OPENROUTER_API_KEYがMemHubのキーと同一かは照合していない。

## プロジェクト別

「組」は両側ともJSONスキーマ適合・finish=stopのもの。失敗した側だけを比較から落とさず、その組を両側から除外する。「本文あり」は要確認候補の正規化後に意味フィールドが空でない件数で、保存済み・検証済み記憶ではない。R/B/Vは同じ根拠区間の全文が引用として残った数／入力中の対象区間数。カテゴリは重なり得る。

| プロジェクト | 試行組 | 比較可能組 | 本文あり 前→後 | R 前→後 | B 前→後 | V 前→後 |
|---|---:|---:|---:|---|---|---|
${Object.entries(s.projects).map(([name,p])=>{const q=s.matched_pairs.projects[name];return `| ${name} | ${p.eligible_pairs} | ${q.pairs} | ${q.before.accepted_candidates-q.before.accepted_empty_semantic_content}→${q.after.accepted_candidates-q.after.accepted_empty_semantic_content} | ${facets.map(f=>`${ratio(q.before.retained_accepted[f],q.presented_units[f])}→${ratio(q.after.retained_accepted[f],q.presented_units[f])}`).join(' | ')} |`;}).join('\n')}

## モデルに届く前の欠落

安全条件を通過した原資料のキーワードを含む区間を単位として測った。区間全体を正解ラベルとは扱わない。長文内に一つだけ理由がある場合も区間1件である。

| 情報 | 選択前の区間 | モデルへ渡せた区間 | 比較可能組の分母 |
|---|---:|---:|---:|
${facets.map(f=>`| ${facetNames[f]} | ${sum(all,p=>p.source_units[f])} | ${sum(all,p=>p.presented_units[f])} | ${den(f)} |`).join('\n')}

独立した成功ツール実行に結び付いた検証結果は、モデル提示範囲で**0区間**。assistantによる結果報告を独立検証済みへ読み替えない。実際のツール証拠を保持できるかという陽性の実データ評価は未検証。

モデルへ渡せた証拠本文は中央値${s.input_diagnostics.evidence_characters_median}文字、最小${s.input_diagnostics.evidence_characters_min}文字だった。上限2,000は実トークン数ではなく、プロンプト・スキーマ・エンベロープを含めたUTF-8バイト上界である。ツール由来の区間は${s.input_diagnostics.tool_spans}件あったが、同じcallの成功完了イベントと結び付く区間は${s.input_diagnostics.tool_spans_with_successful_same_call_event}件だった。

## 生の出力と検証後を分けた結果

| 項目（比較可能組のみ） | 改善前 | 改善後 |
|---|---:|---:|
| モデルが返した候補 | ${b.raw} | ${a.raw} |
| 意味フィールド値が空の生候補 | ${b.rawEmpty} | ${a.rawEmpty} |
| 検証で受理された要確認候補 | ${b.accepted} | ${a.accepted} |
| うち本文が空の候補 | ${b.empty} | ${a.empty} |
| 本文ありの要確認候補 | ${b.accepted-b.empty} | ${a.accepted-a.empty} |

| 対象 | 生出力 前→後 | 正規化後 前→後 |
|---|---|---|
${facets.map(f=>`| ${facetNames[f]}（区間全文） | ${ratio(retained('before',f,true),den(f))}→${ratio(retained('after',f,true),den(f))} | ${ratio(retained('before',f),den(f))}→${ratio(retained('after',f),den(f))} |`).join('\n')}

全文区間の指標が長さに左右されるため、事後の補助診断として句点・改行等で分割した対象文でも照合した。これは事前固定の主指標を置き換えず、人手の正解や意味保持率ではない。

| 対象文 | 生出力 前→後 | 正規化後 前→後 |
|---|---|---|
${facets.map(f=>`| ${facetNames[f]} | ${ratio(retained('before',f,true,true),den(f,true))}→${ratio(retained('after',f,true,true),den(f,true))} | ${ratio(retained('before',f,false,true),den(f,true))}→${ratio(retained('after',f,false,true),den(f,true))} |`).join('\n')}

同じ実モデル出力を前後の検証器へ入力した対照集計は \`summary.json\` の \`matched_pairs.normalizer_crosscheck\` を参照。出典欄、gaps、互換フィールドにだけ残った文章は本文保持に数えない。引用を言い換えた出力はこの指標では不保持であり、意味の正誤は未判定。一回ずつの出力で、統計的な改善や他モデルへの一般化は主張しない。

例えばfactoreviewの改善後出力では条件・留保の区間が1件残ったが、同じ候補の判断・制約・再利用条件等が引用元と一致せず、候補全体が却下された。情報が生出力に存在することと、根拠を満たして正規化後まで残ることを区別する。

## 失敗・費用・検証

${['before','after'].map(arm=>`${arm}: ${JSON.stringify(all.reduce((m,p)=>{for(const[k,n]of Object.entries(p[arm].statuses))m[k]=(m[k]??0)+n;return m;},{}))}`).join('。')}。比較可能組は${s.complete_pairs}/94。失敗・不明は再送していない。

smart-blockの改善後1回は出力800トークンの上限に達し（finish_reason=length）、JSONを解析できなかった。タイムアウト1回と分けて記録する。上限は変更していない。

APIが返した既知の利用料合計は **$${s.costs.total_usd.toFixed(8)}**（疎通確認を含む）。料金不明${s.costs.usage_unknown}呼出しを無料や$0と扱わず、予約上限$${s.costs.unresolved_reserved_usd.toFixed(4)}を残す。既知分＋不明分の保守的予約合計は$${costUpper.toFixed(8)}。実際の口座請求額・入金手数料・不明呼出しの確定請求は別であり、総額確定とは報告しない。

今回追加した送信・集計の8テストが合格。結果不明時の二重送信防止、秘密値を保存しないこと、料金上限、プライバシー制約、例外の欠落、出典だけの保持を加点しないこと、比較組の左右対称な除外を確認した。先行実装の既存テスト結果とは分ける。モデル呼出し完了と、本番有効化・利用者にとっての品質合格は別である。

## OrgBrainで優先する改善

1. **空の要確認候補を成果として数えない。** スキーマはfields=[]を許容し、通常v2は欠落をgapsへ入れてreviewとして受理できる。候補の最低内容、既知フィールド名、棄権（candidates=[]）を明確にする。保存件数ではなく本文あり・対象情報ありを測る。
2. **入力選択と依存関係の保持を先に直す。** 主張・理由・条件・結果を同じ出来事として選び、欠落理由を記録する。実トークン見積りと直列化の改善を検証し、上限を黙って緩めない。通常v2へ渡す場合にも同じ出来事の関連を失わない。
3. **モデルの出力契約を具体化する。** fieldsの名前・引用範囲・役割を型で制約し、要約による創作と不必要な言い換えを避ける。理由や条件がないときに作らず、あるときに本文へ写せたか検査する。
4. **検証報告と実行証拠を別に残す。** 先行修正のreported_verification保持はルール抽出とフック経路にあり、LLM側のプロンプト項目一覧・検証器には専用の写像がない。LLM経路にも未検証の報告を通す契約が必要。観測済み結果へ昇格するには同じcallの完了ツール証拠が必要。実データのツール証拠を含む固定評価を追加する。
5. **実モデルの合格条件を満たすまで本番適用しない。** 先行のルール抽出・正規化テスト改善は、今回の実モデル保持改善を保証しなかった。人手で根拠・欠落・意味変化を定めた固定評価、複数試行、既存v3や費用・安全性の回帰確認が必要。

既存の構造化された成功・判断・失敗、review/quarantine、同一callによる結果照合、出典の版管理を維持する。MemHubの短文＋原資料分離、プロジェクト別の確認、同期と抽出進行の別表示は参考にするが、confirmed状態を独立検証の保証に使わない。

## 再現と保存

\`scripts/evaluate-openrouter-extraction.mjs\` はprepare→probe→executeの一度だけの送信台帳を持つ。既存intentの再送は拒否する。生入力・出力は非公開領域のみ。\`scripts/analyze-openrouter-extraction.mjs\` は固定応答の読み取りと検証器の再生、\`scripts/report-openrouter-extraction.mjs\` は集計だけの文書化を行う。再現のために既存台帳を消したり、同じ実験を再送したりしない。

価格根拠: [OpenRouterモデル一覧](https://openrouter.ai/api/v1/models)、[今回のモデルの配信先](https://openrouter.ai/api/v1/models/qwen/qwen3-235b-a22b-2507/endpoints)。料金は観測時点のもの。
`;
fs.writeFileSync(path.join(out,'Report.md'),report);
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(s,null,2)+'\n');
console.log(JSON.stringify({report:path.join(out,'Report.md'),complete_pairs:s.complete_pairs,known_cost_usd:s.costs.total_usd}));
