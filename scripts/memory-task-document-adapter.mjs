import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {runDocumentWork} from '../packages/orgbrain-cli/src/lib/memory-task-document-adapter.mjs';
const [workflow_id,raw]=process.argv.slice(2),root=resolve(process.env.ORGBRAIN_REUSE_ROOT||process.cwd());
const config=JSON.parse(await readFile(join(root,'.local/memory-reuse/config.json'),'utf8'));
const workflow=config.task_workflows?.[workflow_id];if(!workflow)throw Error('unconfigured_document_workflow');
console.log(JSON.stringify(await runDocumentWork({root,workflow,workflow_id,input:JSON.parse(raw)})));
