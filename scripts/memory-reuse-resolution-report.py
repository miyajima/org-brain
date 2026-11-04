"""Read-only re-audit of real model output, native operations, and separate reuse routes."""
import hashlib,json,math,shlex,sqlite3
from pathlib import Path
REPO=Path(__file__).resolve().parents[1];ROOT=REPO/'artifacts/memory-reuse-resolution-20261027';LEDGER=REPO/'artifacts/memory-reuse-loop-20261026/attempts.json';ARMS=['none','knowledge','results'];FIELDS=['target','mode','batch_size','region','retain_days','deduplicate','partitions'];TOKEN_KEYS=['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']
def load(p):return json.loads(p.read_text())
def rows(p):return [json.loads(x) for x in p.read_text().splitlines() if x] if p.exists() else []
def save(p,x):p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def total(rs,key):return sum(r[key] for r in rs) if all(isinstance(r.get(key),(int,float)) for r in rs) else None
def paired_cases(rs):
 sets=[{x['case'] for x in rs if x['condition']==arm and x['phase']=='resolution' and x['status']=='observed' and x.get('prompt_revision')==2} for arm in ARMS]
 return sorted(set.intersection(*sets))
def digest(x):return hashlib.sha256(json.dumps(x,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def audit(r,corpus):
 d=ROOT/'runs'/r['id'];w=Path(r['workspace']);events=rows(d/'events.jsonl');result=load(d/'result.json');config=load(d/'config.json');state=load(d/'state.json');rule=corpus['rules'][r['target']]
 expected={'target':r['target'],'mode':rule['mode'],'batch_size':rule['batch_size'],'region':rule['region'],'retain_days':rule['retain_days'],'deduplicate':True,'partitions':math.ceil(state['records']/rule['batch_size'])}
 assert set(expected)==set(FIELDS) and expected==state['expected']
 assert list(result['modelUsage'])==['claude-sonnet-5-5'] and r['argv'][r['argv'].index('--effort')+1]=='medium'
 assert all(type(result['usage'][k]) is int for k in TOKEN_KEYS) and sum(result['usage'][k] for k in TOKEN_KEYS)==r['total_tokens']
 assert not result.get('permission_denials') and not r['hook_errors'] and r['native_arguments_match']
 base=Path(r['argv'][r['argv'].index('--settings')+1]);assert base.parent==w
 runtime=ROOT/'runtime/r22'
 assert sha(runtime/'manifest.json')==r['runtime_manifest_sha256']
 calls=rows(d/'calls.jsonl');apply=[x for x in calls if x['args'].get('op')=='apply'];assert len(apply)==1 and apply[0]['args']['plan']==expected and apply[0]['result']['applied_plan']==expected and apply[0]['result']['ok']
 native=[b for e in events if e.get('type')=='assistant' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_use'];tool_results={b['tool_use_id']:b for e in events if e.get('type')=='user' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_result'}
 records=[];backend_ids=[];resolve_calls=0
 for b in native:
  argv=shlex.split(b['input']['command']);assert argv[:2]==[r['argv'][r['argv'].index('--allowedTools')+1].split(' ')[0][5:],str(runtime/'scripts/memory-reuse-claude.mjs')] and len(argv)==4
  req=json.loads(argv[3]);assert req['task_id']==r['id'] and req['adapter']=='plan';tr=tool_results[b['id']];assert not tr.get('is_error');out=json.loads(tr['content'])
  if argv[2]=='resolve':
   resolve_calls+=1;entry=load(d/'resolutions'/(out['source_resolution_id']+'.json'));assert entry['request']==req and entry['output']==out
   backend_ids.extend(x['adapter_call_id'] for x in out.get('results',[]))
  else:
   assert argv[2]=='run';entry=load(d/'invocations'/(out['reuse_invocation_id']+'.json'));assert entry['request']==req and entry['output']==out and entry['digest']==digest(out) and entry['native_call_id']==b['id'];backend_ids.append(out['adapter_call_id']);records.append((entry,b['id']))
 assert sorted(backend_ids)==sorted(x['result']['adapter_call_id'] for x in calls)
 assert len(records)==1
 o=load(d/'observation.json');entry,native_id=records[0];derived=o['derived_applications'];ordinary=o['collection']['recorded'];assert isinstance(ordinary,int)
 db=sqlite3.connect(w/'memory.sqlite');db.row_factory=sqlite3.Row;apps=[dict(x) for x in db.execute('select * from memory_reuse_applications where task_id=?',(r['id'],))];artifacts=[dict(x) for x in db.execute("select * from memory_reuse_artifacts where kind='result'")];db.close();save(d/'evidence-applications.json',apps);save(d/'evidence-result-artifacts.json',artifacts)
 if r['condition']=='results' and r['eligible']:
  assert len(derived)==1 and ordinary==0 and entry['request']['uses']==[] and entry['request']['result_id']==derived[0]['artifact_id'];assert len(apps)==1 and apps[0]['native_call_id']==native_id and apps[0]['verified_at'] is not None
  prior=load(d/'prior-result-import.json');assert prior['artifact_id']==derived[0]['artifact_id'] and prior['native_call_id']!=native_id and prior['model_calls']==0
  old=REPO/'artifacts/memory-reuse-bundled-20261027/runs'/prior['prior_task'];assert sha(old/'events.jsonl')==prior['prior_events_sha256'] and sha(old/'outcome.json')==prior['prior_outcome_sha256']
  oldout=load(old/'outcome.json');oldstate=load(old/'state.json');assert oldout['success'] and oldout['meaning_preserved'] and oldout['native_arguments_match'] and oldout['adapter_sha256']==r['adapter_sha256'];assert oldstate['target']==state['target'] and oldstate['records']==state['records'] and oldstate['rule']==rule
  oldevents=rows(old/'events.jsonl');oldcall=next(b for e in oldevents if e.get('type')=='user' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_result' and b['tool_use_id']==prior['native_call_id']);assert not oldcall.get('is_error') and json.loads(oldcall['content'])['applied_plan']==expected
  refs=derived[0]['source_refs'];assert len(refs)==1 and refs[0]['source_id']=='synthetic-'+r['target']
 elif r['condition']=='knowledge' and r['eligible']:
  assert ordinary==1 and len(derived)==0 and len(entry['request']['uses'])==1
  receipts=load(d/'evidence-receipts.json');assert len(receipts)==1 and receipts[0]['context_id'] is not None;use=json.loads(receipts[0]['observation_json']);assert use['action_call_id']==native_id and use['source_id']=='synthetic-'+r['target'];refs=r['verified_sources']
 else:assert ordinary==0 and len(derived)==0;refs=[]
 checks=rows(d/'freshness/check-events.jsonl');primes=rows(d/'freshness/prime-events.jsonl')
 if r['eligible'] and r['condition']!='none':
  assert checks and all(x['fresh'] for x in checks);assert any(x['phase']=='context' for x in checks) if r['condition']=='knowledge' else any(x['phase']=='result_lookup' for x in checks)
  assert any(x['phase']=='before_action' for x in checks) and any(x['phase']=='native_completion' for x in checks)
  proof=load(d/'freshness/plan.json');assert proof['coverage']==config['freshness_profiles']['plan']['coverage_contract'] and sorted(proof['coverage']['fields'])==sorted(FIELDS)
 return {'id':r['id'],'native_action':native_id,'refs':refs,'route':'result' if derived else 'original' if ordinary else 'none','cross_principal':bool(derived and r['prior_result']['owner']!=r['principal']),'resolve_calls':resolve_calls,'freshness_checks':len(checks),'freshness_check_ms':sum(x['elapsed_ms'] for x in checks),'freshness_source_bytes':sum(x['source_bytes_read'] for x in checks),'prime_calls':len(primes),'prime_ms':sum(x['elapsed_ms'] for x in primes),'prime_source_bytes':sum(x['source_bytes_read']+(x.get('validator_source_bytes_read') or 0) for x in primes)}
def summarize(rs,checks):
 audits={x['id']:x for x in checks};out={}
 for arm in ARMS:
  g=[x for x in rs if x['condition']==arm];uses=[audits[x['id']] for x in g if audits[x['id']]['refs']]
  out[arm]={'n':len(g),'success':sum(x['success'] for x in g),'meaning_preserved':sum(x['meaning_preserved'] for x in g),'unique_knowledge':len({z['source_id'] for x in uses for z in x['refs']}),'use_tasks':len(uses),'personal_uses':sum(bool(audits[x['id']]['refs']) for x in g if x['audience']=='personal'),'team_uses':sum(bool(audits[x['id']]['refs']) for x in g if x['audience']=='team'),'cross_principal_uses':sum(x['cross_principal'] for x in uses),'original_uses':sum(x['route']=='original' for x in uses),'result_applications':sum(x['route']=='result' for x in uses),'ineligible_uses':sum(bool(audits[x['id']]['refs']) for x in g if not x['eligible']),**{k:total(g,k) for k in ['total_tokens','api_equivalent_usd','total_ms','setup_ms','cli_ms','read_calls','apply_calls','model_responses','result_import_ms']},'usage':{k:sum(x['usage'][k] for x in g) for k in TOKEN_KEYS},'tracking_missing':sum(not isinstance((x.get('collection') or {}).get('recorded'),int) or not isinstance(x.get('derived_applications'),list) for x in g),**{k:sum(audits[x['id']][k] for x in g) for k in ['resolve_calls','freshness_checks','freshness_check_ms','freshness_source_bytes','prime_calls','prime_ms','prime_source_bytes']}}
  out[arm]['mean_seconds']=out[arm]['total_ms']/len(g)/1000 if g else None
 return out
def main():
 allrows=load(LEDGER);runs=[x for x in allrows if x.get('channel')=='source_result_v2'];assert not any(x['status']=='started' for x in runs)
 runtime=ROOT/'runtime/r22'
 for f,h in load(runtime/'manifest.json').items():assert sha(runtime/f)==h,f
 mainruns=[x for x in runs if x['phase']=='resolution' and x['status']=='observed'];checks=[audit(x,load(ROOT/'corpus.json')) for x in mainruns];cases=paired_cases(runs);matched=[x for x in mainruns if x['case'] in cases];stats=summarize(matched,checks);base=stats['none']
 for arm in ['knowledge','results']:
  s=stats[arm];s['vs_none']={k:(s[k]/base[k]-1)*100 for k in ['total_tokens','total_ms','api_equivalent_usd']}
 upstream=[x['prior_result'] for x in matched if x['condition']=='results' and x['prior_result']];creation={k:sum(x[k] for x in upstream) for k in ['original_creation_tokens','original_creation_ms','original_creation_api_equivalent_usd']}
 s=stats['results'];savings=base['total_tokens']-s['total_tokens'];creation['estimated_repeated_sets_to_recover_tokens']=math.ceil(creation['original_creation_tokens']/savings) if savings>0 else None;creation['basis']='Historical whole task cost of producing each prior result; separate from current evaluation and already in prior 330-start ledger.'
 for metric,key in [('total_ms','original_creation_ms'),('api_equivalent_usd','original_creation_api_equivalent_usd')]:
  delta=base[metric]-s[metric];creation['estimated_repeated_sets_to_recover_'+metric]=math.ceil(creation[key]/delta) if delta>0 else None
 report={'cumulative_cli_starts':len(allrows),'additional_cli_starts':len(runs),'approved_cap':360,'paired_cases':cases,'paired_n_per_condition':len(cases),'paired_personal_tasks':sum(x['audience']=='personal' for x in matched if x['condition']=='none'),'paired_team_tasks':sum(x['audience']=='team' for x in matched if x['condition']=='none'),'main_comparison':stats,'preparation_failures':[{'id':x['id'],'label':x['label'],'success':x['success'],'total_tokens':x['total_tokens'],'api_equivalent_usd':x['api_equivalent_usd'],'diagnosis':x['diagnosis']} for x in runs if x['phase']=='preparation'],'unpaired_observed':[x['id'] for x in mainruns if x['case'] not in cases],'additional_total_tokens':total(runs,'total_tokens'),'additional_api_equivalent_usd':total(runs,'api_equivalent_usd'),'upstream_result_creation':creation,'actual_billing_usd':None,'parent_implementation_cost':None,'natural_claude_reuse':'unobserved','real_team_effect':'unobserved','cloud_deploy':False}
 assert report['cumulative_cli_starts']<=360 and report['additional_api_equivalent_usd']<=1.0;save(ROOT/'audit.json',{'passed':True,'audited_real_runs':len(checks),'evidence':checks});save(ROOT/'report.json',report)
 lines=['# 条件充足時の原本調査省略と前回結果の再利用','',f'主比較は同じ{len(cases)}課題×3条件。準備2回の失敗を含め追加{len(runs)}回、累計{len(allrows)}/360回。失敗を除いた10回比較とは扱わない。モデルはclaude-sonnet-5-5、effort medium。合成課題、個人と別利用者によるチーム模擬。','','|指標|記憶なし|条件を満たす知識|知識＋前回結果|','|---|---:|---:|---:|']
 for label,k in [('成功','success'),('必須条件保持','meaning_preserved'),('総トークン','total_tokens'),('平均秒','mean_seconds'),('API換算USD','api_equivalent_usd'),('実原本照会','read_calls'),('モデル応答','model_responses'),('再利用知識数','unique_knowledge'),('利用課題','use_tasks'),('個人での利用','personal_uses'),('チーム模擬での利用','team_uses'),('別利用者による結果適用','cross_principal_uses'),('原本を使った記録','original_uses'),('結果適用の記録','result_applications'),('対象外誤適用','ineligible_uses'),('観測欠測','tracking_missing')]:
  values=[stats[x][k] for x in ARMS];lines.append('|'+label+'|'+'|'.join(f'{v:.4f}' if isinstance(v,float) else str(v) for v in values)+'|')
 lines+=['','記憶なし比（当回の準備・CLI・フック・注入・追跡・検証・結果取り込みを含む）:']
 for arm in ['knowledge','results']:
  v=stats[arm]['vs_none'];lines.append(f"- {arm}: トークン{v['total_tokens']:+.2f}%、時間{v['total_ms']:+.2f}%、API換算{v['api_equivalent_usd']:+.2f}%。")
 lines+=['','トークンの内訳（キャッシュ読み込みも省略せず合計）:','','|区分|記憶なし|知識|知識＋前回結果|','|---|---:|---:|---:|']
 for k in TOKEN_KEYS:lines.append('|'+k+'|'+'|'.join(str(stats[x]['usage'][k]) for x in ARMS)+'|')
 lines+=['','内部処理は総時間の内数。モデルが原本を調査する呼び出しを省いても、ローカルで版・権限・出典ハッシュを確認する読み取りは残る。']
 for arm in ARMS:
  z=stats[arm];lines.append(f"- {arm}: 準備{z['setup_ms']:.3f}ms、結果取り込み{z['result_import_ms']:.3f}ms、事前検証{z['prime_calls']}回/{z['prime_ms']:.3f}ms、最新確認{z['freshness_checks']}回/{z['freshness_check_ms']:.3f}ms、事前検証の出典読取{z['prime_source_bytes']}bytes、最新確認の出典読取{z['freshness_source_bytes']}bytes。")
 lines+=['',f"今回の全30開始のAPI換算費用は{report['additional_api_equivalent_usd']:.6f} USD。準備失敗も含む。実請求・親Codex実装費・CPU金額は未取得。初回のランタイム固定や検証用準備は別勘定で、比較試行ごとの準備時間は総時間に含む。",'',f"結果を作った過去の成功タスク全体は{creation['original_creation_tokens']}トークン、{creation['original_creation_ms']/1000:.3f}秒、API換算{creation['original_creation_api_equivalent_usd']:.6f} USD。既存330開始の内数であり今回の実行数・請求へ二重加算しない。キャッシュが既にある当回の節約と、作成費込みの回収は別に評価する。",'',f"再利用だけを目的に過去タスク全体の作成費を追加負担すると仮定すると、今回1セットの再利用では回収できない。当回の差が維持される場合、同じ9課題セットの再利用でトークンは{creation['estimated_repeated_sets_to_recover_tokens']}回、API換算費用は{creation['estimated_repeated_sets_to_recover_api_equivalent_usd']}回、時間は{creation['estimated_repeated_sets_to_recover_total_ms']}回が回収の目安。旧方式でのタスク全体を割り当てた計算であり、キャッシュ保存だけの増分費用や将来の効果を実測した値ではない。",'', '原本照会の省略は、全必須条件・入力・出典バイト/版・環境・実装・権限・期限の照合が通るときだけ。結果の適用は元の成功操作と今回の実操作/Stopを照合し、モデルの原本読取へ置き換えない。固定モデル回答の再生はしていない。','', '今回の削減は固定した合成課題での結果。Claudeの実業務での自然な再利用と実メンバーのチーム効果は未観測。通常作業用の完全条件プロファイルは未設定。クラウド展開なし。','','準備失敗の詳細と未対比較1件はreport.json、実操作/利用確認の照合はaudit.json、原ログはruns/、条件はPROTOCOL.md。']
 (ROOT/'REPORT.md').write_text('\n'.join(lines)+'\n');print(json.dumps({'paired_n':len(cases),'stats':stats,'additional_fee':report['additional_api_equivalent_usd']},ensure_ascii=False))
if __name__=='__main__':main()
