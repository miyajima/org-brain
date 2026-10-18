import test from "node:test";
import assert from "node:assert/strict";
import { armMetrics, chooseThreshold, assertReusableProjection, verifyProjection } from "./local-relevance-comparison.mjs";
import {DatabaseSync} from "node:sqlite";

test("calibration preserves every existing target for both arms and uses the declared tie break", () => {
  const rows=[{expected_ids:["target"],arms:{a:["target","noise"],b:["noise","target"]},scores:{target:0.3,noise:0.1}},
    {expected_ids:[],arms:{a:["noise"],b:["noise"]},scores:{noise:0.1}}];
  const result=chooseThreshold(rows,[0.05,0.1,0.25,0.5]);
  assert.equal(result.threshold,0.25);
  assert.equal(result.qualified,true);
  assert.equal(result.grid.find(x=>x.threshold===0.5).lost_targets,2);
  assert.equal(chooseThreshold(rows,[0.5]).qualified,false);
});

test("an interrupted evaluation reuses only a complete matching embedding space", () => {
  assert.doesNotThrow(()=>assertReusableProjection([{provider:"p",feature_count:768,vector_format:"dense-f32",count:12}],"p",768,12));
  for(const rows of [[],[{provider:"other",feature_count:768,vector_format:"dense-f32",count:12}],
    [{provider:"p",feature_count:1024,vector_format:"dense-f32",count:12}],
    [{provider:"p",feature_count:768,vector_format:"dense-f32",count:11}]]){
    assert.throws(()=>assertReusableProjection(rows,"p",768,12),/projection/);
  }
});

test("matching counts do not hide missing, orphaned, NULL or malformed vectors", () => {
  const db=new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE memory_retrieval_units_v4(id TEXT,tenant_id TEXT); CREATE TABLE memory_retrieval_unit_embeddings_v4(unit_id TEXT,tenant_id TEXT,provider TEXT,feature_count INTEGER,vector_format TEXT,vector_blob BLOB);");
    db.exec("INSERT INTO memory_retrieval_units_v4 VALUES('a','default'),('b','default')");
    const insert=db.prepare("INSERT INTO memory_retrieval_unit_embeddings_v4 VALUES(?,'default','p',768,'dense-f32',?)");
    insert.run("a",Buffer.alloc(3072));insert.run("b",Buffer.alloc(3072));
    assert.doesNotThrow(()=>verifyProjection(db,"p",768));
    db.exec("UPDATE memory_retrieval_unit_embeddings_v4 SET unit_id='orphan' WHERE unit_id='b'");
    assert.throws(()=>verifyProjection(db,"p",768),/projection/);
    db.exec("UPDATE memory_retrieval_unit_embeddings_v4 SET unit_id='b',vector_blob=NULL WHERE unit_id='orphan'");
    assert.throws(()=>verifyProjection(db,"p",768),/projection/);
    db.prepare("UPDATE memory_retrieval_unit_embeddings_v4 SET vector_blob=? WHERE unit_id='b'").run(Buffer.alloc(4));
    assert.throws(()=>verifyProjection(db,"p",768),/projection/);
  } finally {db.close();}
});

test("evaluation distinguishes raw retrieval, filtered rank, missed targets and unrelated questions", () => {
  const rows=[{expected_ids:["t"],arms:{a:["n","t"]},scores:{t:0.8,n:0.1}},
    {expected_ids:["absent"],arms:{a:["n"]},scores:{n:0.1}},
    {expected_ids:[],arms:{a:["n"]},scores:{n:0.1}}];
  const result=armMetrics(rows,"a",0.5);
  assert.equal(result.raw.hit_at_1,0);assert.equal(result.selected.hit_at_1,0.5);
  assert.equal(result.selected.negative_any_result_rate,0);
  assert.equal(result.raw.negative_any_result_rate,1);
  assert.equal(result.lost_targets,0);
});
