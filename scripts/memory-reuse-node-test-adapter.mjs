import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
const [target,raw]=process.argv.slice(2),input=JSON.parse(raw);
if(input.op!=='test'||Object.keys(input).some(k=>k!=='op'))throw Error('unsupported_test_operation');
const root=await realpath(process.cwd()),file=await realpath(resolve(root,target));
if(!file.startsWith(root+'/')||!file.endsWith('.test.mjs'))throw Error('test_target_outside_project');
let ok=true,stdout='',stderr='',exit_code=0;
const env={...process.env};delete env.NODE_TEST_CONTEXT;
try{({stdout,stderr}=await promisify(execFile)(process.execPath,['--test',file],{cwd:root,timeout:50000,maxBuffer:1024*1024,encoding:'utf8',env}));}
catch(error){ok=false;stdout=error.stdout??'';stderr=error.stderr??'';exit_code=Number.isInteger(error.code)?error.code:1;}
console.log(JSON.stringify({ok,test_file:relative(root,file),exit_code,stdout,stderr}));
