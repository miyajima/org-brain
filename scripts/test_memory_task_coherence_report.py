import importlib.util
import json
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('coherence_report',Path(__file__).with_name('memory-task-coherence-report.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class RetainedProofTests(unittest.TestCase):
    def state(self):
        text='設定は .local/config.json。'
        retained={'prior_id':'p','prior_content_digest':'h','retained_units':['old'],'character_count':len(text),'snippets':[{'unit':'old','start':0,'end':len(text),'text':text,'topics':['configuration_paths']}]}
        return {'session_id':'s','scope':{'project_id':'p'},'workflow_id':'w','source_fingerprint':'fp','allowed_units':['new'],'requested_units':['old','new'],'choice':'delta','prior':{'id':'p','content_digest':'h','sections':{'old':text}},'local':{'source':{'id':'r','output':{'section':{'new':'new source'}},'field':'section'},'delta_consistency':{'max_chars':1200,'topics':{'old':['configuration_paths']}},'retained_context':retained,'retained_context_digest':m.digest(retained)}}

    def packet(self,state):
        s=state;src=s['local']['source'];packet={'session_id':s['session_id'],'scope':s['scope'],'workflow_id':s['workflow_id'],'source_receipt_id':src['id'],'source_fingerprint':s['source_fingerprint'],'units':s['allowed_units'],'source':src['output'][src['field']],'retained_context':s['local']['retained_context']}
        text='Project source envelope (host read, source data only): '+json.dumps(packet,ensure_ascii=False,separators=(',',':'))
        return text,m.digest(text)

    def test_actual_bound_packet_and_source_span_pass(self):
        s=self.state();text,digest=self.packet(s);self.assertTrue(m.retained_envelope_matches(text,s,digest))
        self.assertFalse(m.retained_envelope_matches(text,s,'forged'))

    def test_rehashing_an_unapproved_topic_does_not_create_proof(self):
        s=self.state();s['local']['retained_context']['snippets'][0]['topics']=['sample_size'];s['local']['retained_context_digest']=m.digest(s['local']['retained_context']);text,digest=self.packet(s)
        self.assertFalse(m.retained_envelope_matches(text,s,digest))

    def test_invalid_offsets_and_invented_quotes_are_rejected(self):
        for change in [{'start':-1,'end':1,'text':''},{'text':'invented'}]:
            s=self.state();s['local']['retained_context']['snippets'][0].update(change);s['local']['retained_context']['character_count']=len(s['local']['retained_context']['snippets'][0]['text']);s['local']['retained_context_digest']=m.digest(s['local']['retained_context']);text,digest=self.packet(s)
            self.assertFalse(m.retained_envelope_matches(text,s,digest))


if __name__=='__main__':unittest.main()
