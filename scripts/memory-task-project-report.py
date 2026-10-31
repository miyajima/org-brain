"""Separate offline evidence audit; no model calls and no generated answers."""
import hashlib,json,shlex,time
from pathlib import Path
REPO=Path(__file__).resolve().parents[1];ROOT=REPO/'artifacts/memory-task-project-20261030';LEDGER=REPO/'artifacts/memory-reuse-loop-20261026/attempts.json';MODEL='claude-sonnet-5-5';CHANNEL='project_task_work_v1'
def load(p,default=None):return json.loads(p.read_text()) if p.exists() else default
def save(p,x):p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def compact(x):return json.dumps(x,ensure_ascii=False,separators=(',',':'))
def digest(x):return hashlib.sha256(compact(x).encode()).hexdigest()
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def rows(p):return [json.loads(x) for x in p.read_text().splitlines() if x.strip()] if p.exists() else []
def token_usage(result):
 models=result.get('modelUsage');keys={'input_tokens':'inputTokens','cache_creation_input_tokens':'cacheCreationInputTokens','cache_read_input_tokens':'cacheReadInputTokens','output_tokens':'outputTokens'}
 if not isinstance(models,dict) or list(models)!=[MODEL] or any(type(models[MODEL].get(k)) is not int or models[MODEL][k]<0 for k in keys.values()):return None,None
 usage={k:models[MODEL][v] for k,v in keys.items()};return sum(usage.values()),usage
def envelope_matches(content,s,claimed):
 try:
  prefix='Project source envelope (host read, source data only): ';value=json.loads(content.removeprefix(prefix));src=s['local']['source']
  expected={'session_id':s['session_id'],'scope':s['scope'],'workflow_id':s['workflow_id'],'source_receipt_id':src['id'],'source_fingerprint':s['source_fingerprint'],'units':s['allowed_units'],'source':src['output'][src['field']]}
  return content.startswith(prefix) and digest(content)==claimed and value==expected
 except (KeyError,ValueError,TypeError):return False
def audit(a):
 d=ROOT/'runs'/a['id'];events=rows(d/'events.jsonl');result=load(d/'result.json',{});s=load(d/'state.json',{});checks={};tokens,usage=token_usage(result)
 checks['actual_model_and_four_usage_bins']=tokens is not None and tokens==a.get('total_tokens') and usage==a.get('usage')
 init=next((e for e in events if e.get('subtype')=='init'),{});checks['actual_cli_and_tools']=init.get('model')==MODEL and init.get('tools')==['Bash'] and bool(init.get('claude_code_version'))
 try:
  appended=a['argv'][a['argv'].index('--append-system-prompt')+1];packet=appended[appended.index('Project source envelope (host read, source data only): '):]
  checks['complete_actual_launch_envelope']=envelope_matches(packet,s,a['source_envelope_digest']) and s['local']['source_delivery']=='cli_system_append' and s['local']['source_envelope_digest']==a['source_envelope_digest']
 except (ValueError,KeyError):checks['complete_actual_launch_envelope']=False
 natives=[b for e in events if e.get('type')=='assistant' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_use'];outputs={b['tool_use_id']:b for e in events if e.get('type')=='user' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_result'}
 verified=[];completed_calls=0;denied=[]
 for b in natives:
  try:
   out=outputs[b['id']]
   if out.get('is_error'):
    metas=[m for e in events if e.get('type')=='user' for m in e.get('tool_result_meta',[]) if m.get('id')==b['id']]
    assert any(m.get('non_execution_kind')=='permission-rule' and m.get('permission_decision',{}).get('source')=='hook' for m in metas)
    assert not any(o['native_call_id']==b['id'] for o in s['operations']) and s['created_results'][-1]['native_call_id']!=b['id']
    denied.append(b['id']);verified.append(True);continue
   argv=shlex.split(b['input']['command']);assert b['name']=='Bash' and len(argv)==4 and Path(argv[1])==REPO/'scripts/memory-reuse-claude.mjs' and argv[2]=='run'
   request=json.loads(argv[3]);out=outputs[b['id']];assert not out.get('is_error');value=json.loads(out['content']);private=load(d/('invocation-'+value['reuse_invocation_id']+'.json'))
   assert private['native_call_id']==b['id'] and private['request']==request and private['output']==value and request['task_id']==s['task_id'] and request['adapter']==s['adapter'] and request['uses']==[]
   x=request['input'];assert x['op']==('patch' if s['choice']=='delta' else 'write') and set(x['sections'])==set(s['allowed_units'])
   effective={u:x['sections'][u] if u in s['allowed_units'] else s['prior']['sections'][u] for u in s['requested_units']};assert effective==value['artifact']['sections']
   assert sha(REPO/value['artifact']['path'])==value['artifact']['sha256']==s['created_results'][-1]['content_digest']==sha(d/'deliverable.md')
   verified.append(True);completed_calls+=1
  except (ValueError,KeyError,TypeError,AssertionError,FileNotFoundError):verified.append(False)
 checks['native_arguments_output_and_file']=completed_calls>0 and all(verified)
 checks['scoped_file_provenance']=bool(s.get('created_results')) and s.get('scope',{}).get('principal_id')=='local'
 if s.get('choice')=='delta':
  prior=s['prior'];checks['prior_bytes_and_file_versions']=sha(REPO/prior['path'])==prior['content_digest'] and all(sha(REPO/x['path'])==x['sha256'] for x in prior['file_sources'])
  seed=next((x for x in load(LEDGER) if x.get('channel')==CHANNEL and x.get('phase')=='seed' and x.get('success') and x['task_completion'].get('artifact_id')==prior['id']),None)
  checks['real_prior_generation']=seed is not None
  receipt=load(ROOT/'human-answers'/(s['session_id']+'.json'),{})
  if receipt.get('provenance')=='user_requested_scenario':checks['requested_scenario_is_not_human_adoption']=receipt.get('raw_user_instruction')=='全パターン実行して' and s.get('decision_source')=='simulated_local_user'
  else:checks['actual_human_answer']=receipt.get('provenance')=='native_user_answer' and s.get('decision_source')=='native_question_answer' and receipt.get('question_call_id')==s['local']['decision']['human_evidence']['call_id']
 return {'id':a['id'],'case':a['case'],'phase':a['phase'],'condition':a['condition'],'passed':all(checks.values()),'checks':checks,'cli_version':init.get('claude_code_version'),'verified_completed_calls':completed_calls,'verified_non_execution_rejections':denied,'raw_driver_success':a.get('success'),'outcome':'completed_with_rework' if denied else 'completed'}
def strict_sum(xs,key):return sum(x[key] for x in xs) if xs and all(isinstance(x.get(key),(int,float)) for x in xs) else None
def summarize(xs):return {'n':len(xs),'total_tokens':strict_sum(xs,'total_tokens'),'machine_ms':strict_sum(xs,'total_ms'),'api_equivalent_usd':strict_sum(xs,'api_equivalent_usd')}
def main():
 started=time.monotonic();ledger=load(LEDGER);corrections=load(ROOT/'arithmetic-corrections.json',{})
 current=[]
 for x in ledger:
  if x.get('channel')!=CHANNEL:continue
  item=dict(x);correction=corrections.get(x['id'])
  if correction:item.update(raw_total_ms=x['total_ms'],raw_setup_ms=x['setup_ms'],total_ms=x['total_ms']-correction['double_counted_host_ms'],setup_ms=x['setup_ms']-correction['double_counted_host_ms'],arithmetic_correction=correction)
  current.append(item)
 success=[x for x in current if x.get('artifact_path') and x.get('task_completion',{}).get('status') in ['completed_full','completed_delta']];audits=[audit(x) for x in success];save(ROOT/'audit.json',audits)
 offers=load(ROOT/'human-offers.json',[]);pairs=[]
 for case in load(ROOT/'cases.json',[]):
  baseline=next((x for x in success if x['phase']=='comparison' and x['case']==case['id'] and x['condition']=='control'),None);offer=next((x for x in offers if x['id']==case['id']),None);answer=load(ROOT/'answered'/((offer['session_id'] if offer else 'missing')+'.json'),{})
  reuse=next((x for x in success if x['phase']=='comparison' and x['case']==case['id'] and x['condition']=='reuse'),None)
  route=None
  if answer.get('completion',{}).get('status')=='completed_with_existing_result':
   s=load(REPO/'.local/memory-reuse/task-confirmations'/(offer['session_id']+'.json'));p=s['prior'];full=set(case['units']).issubset(p['covered_units']);receipt=load(ROOT/'human-answers'/(offer['session_id']+'.json'),{})
   source_ok=receipt.get('provenance')=='native_user_answer' and s['decision_source']=='native_question_answer' or receipt.get('provenance')=='user_requested_scenario' and receipt.get('raw_user_instruction')=='全パターン実行して' and s['decision_source']=='simulated_local_user'
   accepted=not s['operations'] and not any(x['id']=='claude:'+s['session_id'] for x in current) and s['choice']=='existing' and sha(REPO/p['path'])==p['content_digest'] and source_ok
   route={'choice':'existing','verified':accepted,'same_requested_scope':full,'total_tokens':0,'api_equivalent_usd':0,'total_ms':offer['host_process_elapsed_ms']+answer['host_process_elapsed_ms'],'prior_id':p['id'],'reused_units':p['covered_units'],'model_starts':0}
  elif reuse:
   s=load(ROOT/'runs'/reuse['id']/'state.json');route={'choice':s['choice'],'verified':next(x for x in audits if x['id']==reuse['id'])['passed'],'same_requested_scope':True,'total_tokens':reuse['total_tokens'],'api_equivalent_usd':reuse['api_equivalent_usd'],'total_ms':reuse['total_ms'],'prior_id':s.get('prior',{}).get('id'),'reused_units':reuse['task_completion']['reused_units'],'model_starts':1}
  pairs.append({'case':case['id'],'kind':case['kind'],'baseline':{k:baseline[k] for k in ['id','total_tokens','total_ms','api_equivalent_usd']} if baseline else None,'reuse':route})
 matched=[p for p in pairs if p['baseline'] and p['reuse'] and p['reuse']['verified'] and p['reuse']['same_requested_scope']];batch=load(ROOT/'human-answer-batch.json',{});window=batch.get('response_window_ms');active=batch.get('human_active_ms');all_matched=len(matched)==6
 by_choice={}
 for choice in ['existing','delta','full']:
  items=[p for p in matched if p['reuse']['choice']==choice]
  if items:
   base=summarize([p['baseline'] for p in items]);reuse=summarize([p['reuse'] for p in items]);by_choice[choice]={'n':len(items),'baseline':base,'reuse':reuse,'change_pct':{k:(reuse[k]/base[k]-1)*100 for k in ['total_tokens','machine_ms','api_equivalent_usd'] if base[k]}}
 full=[]
 for case in load(ROOT/'scenario-cases.json',[]):
  base=next((x for x in success if x['phase']=='comparison' and x['condition']=='control' and x['case']==case['baseline_case']),None);attempts=[x for x in current if x['case']==case['id'] and x['condition']=='reuse'];done=next((x for x in success if x['case']==case['id']),None)
  full.append({'case':case['id'],'baseline_case':case['baseline_case'],'baseline':{k:base[k] for k in ['total_tokens','total_ms','api_equivalent_usd']},'reuse':{'total_tokens':strict_sum(attempts,'total_tokens'),'total_ms':strict_sum(attempts,'total_ms'),'api_equivalent_usd':strict_sum(attempts,'api_equivalent_usd')},'attempts':[x['id'] for x in attempts],'completed':done is not None,'audit_passed':next((x['passed'] for x in audits if done and x['id']==done['id']),False)})
 if full:
  base_full=summarize([p['baseline'] for p in full]);reuse_full=summarize([p['reuse'] for p in full]);by_choice['full']={'n':len(full),'baseline':base_full,'reuse':reuse_full,'includes_failed_starts_and_rework':True,'change_pct':{k:(reuse_full[k]/base_full[k]-1)*100 for k in ['total_tokens','machine_ms','api_equivalent_usd'] if base_full[k]}}
 base=summarize([p['baseline'] for p in matched]);reused=summarize([p['reuse'] for p in matched]);human_inclusive=reused['machine_ms']+window if all_matched and window is not None else None
 report={'status':'requested_nine_scenarios_completed_human_effect_unobserved' if all_matched and len(full)==3 and all(x['completed'] and x['audit_passed'] for x in full) else 'incomplete','model':MODEL,'effort':'medium','cumulative_starts':len(ledger),'additional_starts':len(current),'maximum_starts':437,'api_equivalent_all_evaluation_usd':strict_sum(current,'api_equivalent_usd'),'actual_billing_usd':None,'preparation':summarize([x for x in success if x['phase']=='seed']),'retained_failures':[{k:x.get(k) for k in ['id','failure_reason','api_equivalent_usd','total_tokens']} for x in current if not x.get('success')],'matched_pairs':len(matched),'audited_successful_model_runs':len(audits),'audit_passed':sum(x['passed'] for x in audits),'baseline':base,'reuse':reused,'by_choice':by_choice,'pairs':pairs,'supplemental_full':full,'full_comparator_note':'Three existing full-scope controls are shared with delta; not nine independent baseline samples. Full includes its unsuccessful CLI start.','human':{'native_ui_response_window_ms':window,'self_reported_active_ms':active,'timing_group_count':1 if window is not None else None,'pre_work_human_inclusive_ms':human_inclusive,'pre_work_saves_elapsed_time':human_inclusive<base['machine_ms'] if human_inclusive is not None else None,'final_human_review_and_rework_ms':None,'whole_task_human_inclusive_savings_verified':False,'instruction_response_window_is_not_task_confirmation':load(ROOT/'method-change.json',{}).get('instruction_response_window_upper_bound_ms')},'origin':'solicited real-project tasks, forced scenarios requested by user; not organic adoption','organic_reuse_observed':None,'real_team_effect':'not_observed','cloud_deploy':False,'offline_audit_ms':(time.monotonic()-started)*1000,'parent_implementation_and_audit_cost':None,'semantic_review':load(ROOT/'quality-review.json',{'status':'unassessed'})}
 creation=report['preparation'];with_creation={'total_tokens':reused['total_tokens']+creation['total_tokens'],'machine_ms':reused['machine_ms']+creation['machine_ms'],'api_equivalent_usd':reused['api_equivalent_usd']+creation['api_equivalent_usd']}
 report['reference_creation_allocated_to_six_forced_routes']={'values':with_creation,'change_vs_six_controls_pct':{k:(with_creation[k]/base[k]-1)*100 for k in with_creation},'note':'Reference allocation only: 3 initial outputs plus 3 existing and 3 delta routes. Not organic adoption; creation setup contains inner preparation timer, comparison setup includes complete host processes. Preparation failures and full-route tests are separate evaluation costs.'}
 report['arithmetic_corrections']=corrections
 report['validation']=load(ROOT/'validation.json',{})
 report['cli_versions']=sorted({x['cli_version'] for x in audits})
 report['reuse_evidence']={'distinct_original_results':len({p['reuse']['prior_id'] for p in matched if p['reuse']['choice'] in ['existing','delta']}),'result_task_pairs':sum(p['reuse']['choice'] in ['existing','delta'] for p in matched),'retained_unit_applications':sum(len(p['reuse']['reused_units']) for p in matched),'original_memory_model_read_claims':0,'human_adoption_is_unobserved':True}
 provider_tokens=[]
 for a in current:
  result=load(ROOT/'runs'/a['id']/'result.json',{});n,_=token_usage(result)
  if n is None and result.get('duration_api_ms')==0 and result.get('total_cost_usd')==0 and result.get('modelUsage')=={} and all(result.get('usage',{}).get(k)==0 for k in ['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']):n=0
  provider_tokens.append(n)
 report['total_evaluation_tokens']=sum(provider_tokens) if all(x is not None for x in provider_tokens) else None
 save(ROOT/'report.json',report)
 lines=['# 通常Claude作業への導入と実資料評価','',f"状態: {report['status']}。累計{len(ledger)}回、今回{len(current)}回。API換算{report['api_equivalent_all_evaluation_usd']:.7f} USD（上限3.60 USD）。",'', '通常設定に調査・分析・文書作成の3対象を導入。`pnpm claude:work research|analysis|document` で開始する。クラウド展開なし。','',f"実モデルの操作・資料・成果の照合: {report['audit_passed']}/{len(audits)}。記憶なし6件と再利用6件の比較は {len(matched)} 組が成立。人の実回答がない作業は実行しない。",'', '| 作業 | 記憶なしトークン | 再利用トークン | 記憶なし秒 | 再利用の機械処理秒 |','|---|---:|---:|---:|---:|']
 for p in pairs:
  b=p['baseline'];u=p['reuse'];lines.append('| '+p['case']+' | '+('—' if not b else str(b['total_tokens']))+' | '+('未実施' if not u else str(u['total_tokens']))+' | '+('—' if not b else f"{b['total_ms']/1000:.2f}")+' | '+('未実施' if not u else f"{u['total_ms']/1000:.2f}")+' |')
 lines+=['','| 選択（各3種類） | トークン変化 | 機械処理の計上時間変化 | API換算費用変化 |','|---|---:|---:|---:|']
 for choice,v in by_choice.items():lines.append('| '+choice+' | '+f"{v['change_pct']['total_tokens']:+.1f}% | {v['change_pct']['machine_ms']:+.1f}% | {v['change_pct']['api_equivalent_usd']:+.1f}% |")
 lines+=['','全体実施は失敗1回と同じCLI内の拒否・再実行を含む。生のドライバ成功フラグは保持する。最後の文書は一度拒否された後、別の実呼出IDで完成したため、未実行の拒否と成功のネイティブ引数・出力・成果ファイルを別に照合する。全体実施と差分は同じ3件の対照を共有し、9組の独立した対照とは数えない。', '',f"初回成果3件の作成費は {creation['api_equivalent_usd']:.7f} USD、{creation['total_tokens']:,}トークン、記録済み時間{creation['machine_ms']/1000:.2f}秒。これを既存3件＋差分3件へ一度配分する参考値は {with_creation['total_tokens']:,}トークン、{with_creation['machine_ms']/1000:.2f}秒、{with_creation['api_equivalent_usd']:.7f} USD。実利用の採用率を示すものではない。1回の差分3件だけへ作成費を全配分すると、トークンとAPI換算費用は記憶なし3件より多く、初回から回収できるとは限らない。",'', '初期の未認証停止は0 USD、長い文脈の失敗は0.0556396 USD、全体実施の未完了1回は0.1051246 USD。全て総評価費に含む。最後の全体実施のセットアップ加算に同じホスト処理150.24 msが2度含まれていたため、原ログを変えず、記録済みの重複項だけを派生集計から除いた。CLI実測時間は変更しない。詳細は arithmetic-corrections.json。', '',f"実際の課題に対する人の確認時間: {'未観測' if window is None else f'{window/1000:.2f}秒'}。能動的な確認時間: {'欠測' if active is None else f'{active/1000:.2f}秒（本人申告）'}。利用者は「全パターン実行して」と指定したため、9分岐を評価用に選んだ。実際に十分と判断した採用実績・確認時間へ置き換えない。最終的な人の成果確認と手戻りも未観測のため、全作業の人を含む削減は認定しない。",'', '今回依頼した実資料の利用と、自発的な通常利用・他メンバーによる利用を分ける。実請求額・親の実装と監査費用は未取得。ホストの資料読取・注入と、モデルによる原本読取を混同しない。','', '未認証の停止と、長いフック追加文脈が退避された試行を失敗として保持。修正後は資料本文を起動時の文脈へ渡し、フックには短い範囲とコマンドを渡す。詳しい条件は [PROTOCOL.md](PROTOCOL.md)、通常手順は [導入手順](../../docs/MEMORY_REUSE_ORDINARY_WORK.md)。']
 (ROOT/'REPORT.md').write_text('\n'.join(lines)+'\n');print(json.dumps({k:report[k] for k in ['status','cumulative_starts','additional_starts','api_equivalent_all_evaluation_usd','matched_pairs','audit_passed','audited_successful_model_runs']},ensure_ascii=False))
 with (ROOT/'REPORT.md').open('a') as f:f.write('\n最終検証: モデル計測前の機能・回帰100件、計測後に追加した欠測表示の1件を含む当該モジュール7件、別集計の2件が通過（異なるNodeテスト計101件）。lint・構文・差分検査が通過。CLI実版は'+', '.join(report['cli_versions'])+'、モデルは'+MODEL+'。全評価の4区分合計は'+str(report['total_evaluation_tokens'])+'トークン。初回の未認証実行はAPI未到達・使用量0が実ログで確認できたため0とし、欠測を補完したものではない。通常の実回答・自発的利用はまだ0件の観測で、人の確認時間はnull。最初の未認証1件は新しいwork-observationsの導入前で、そこだけの開始数17件と実行台帳18件が異なる。実行上限と総費用は台帳を正とする。\n')
if __name__=='__main__':main()
