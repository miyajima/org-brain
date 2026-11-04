const MARKER='ORGBRAIN_TASK_SECTIONS';
const valid=session=>typeof session==='string'&&/^[\w:-]{1,128}$/u.test(session);
export function taskSectionsCommand(prefix,session,sections){
 if(!valid(session))throw Error('invalid_task_session');
 return prefix+" task '"+session+"' <<'"+MARKER+"'\n"+JSON.stringify(sections)+'\n'+MARKER;
}
export function parseTaskSectionsCommand(command,prefix){
 if(typeof command!=='string'||Buffer.byteLength(command)>70000)return null;
 const start=prefix+" task '";if(!command.startsWith(start))return null;
 const cut=command.indexOf("'",start.length),session_id=command.slice(start.length,cut);if(!valid(session_id))return null;
 const opening="' <<'"+MARKER+"'\n";if(command.slice(cut,cut+opening.length)!==opening)return null;
 const text=command.endsWith('\n')?command.slice(0,-1):command,end='\n'+MARKER;if(!text.endsWith(end))return null;
 const body=text.slice(cut+opening.length,-end.length);
 try{const sections=JSON.parse(body);if(!sections||Array.isArray(sections)||typeof sections!=='object')return null;return {session_id,sections,raw_stdin:body+'\n'};}catch{return null;}
}
