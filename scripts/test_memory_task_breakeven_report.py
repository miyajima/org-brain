import importlib.util
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('breakeven',Path(__file__).with_name('memory-task-breakeven-report.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class BreakEvenTests(unittest.TestCase):
    def test_creation_is_charged_once_and_failed_starts_are_retained(self):
        rows=[{'phase':'seed','kind':'research','total_tokens':30,'total_ms':30,'api_equivalent_usd':.3,'success':True}]
        for n in range(1,4):
            for c,v in [('none',20),('improved',5)]:rows.append({'phase':'comparison','kind':'research','case':f'research-delta-{n}','condition':c,'total_tokens':v,'total_ms':v,'api_equivalent_usd':v/100,'success':True})
        rows.append({**rows[-1],'success':False,'total_tokens':10,'total_ms':10,'api_equivalent_usd':.1})
        points=m.curve(rows,['research'])
        self.assertEqual(points[0]['with_creation']['total_tokens'],35)
        self.assertEqual(points[-1]['with_creation']['total_tokens'],55)
        self.assertEqual(points[-1]['baseline']['total_tokens'],60)

    def test_missing_pair_cannot_create_a_measured_crossing(self):
        rows=[{'phase':'seed','kind':'research','total_tokens':1,'total_ms':1,'api_equivalent_usd':.1,'success':True}, {'phase':'comparison','kind':'research','case':'research-delta-1','condition':'improved','total_tokens':1,'total_ms':1,'api_equivalent_usd':.1,'success':True}]
        self.assertEqual(m.curve(rows,['research']),[])

    def test_crossing_requires_two_later_rounds_and_minimum_six(self):
        points=[{'reuse_per_prior':n,'both_lower':n>=4} for n in range(1,7)]
        self.assertEqual(m.crossing(points),{'first_both_lower':4,'confirmed_after_two_more':4,'minimum_six_complete':True})
        self.assertIsNone(m.crossing(points[:5])['confirmed_after_two_more'])
        points[-1]['both_lower']=False
        self.assertIsNone(m.crossing(points)['confirmed_after_two_more'])

    def test_quality_qualification_requires_review_and_allows_costed_repair(self):
        seed={'id':'seed','phase':'seed','kind':'research','success':True}
        control={'id':'control','phase':'comparison','case':'research-delta-1','kind':'research','condition':'none','success':True}
        reuse={**control,'id':'reuse','condition':'improved'}
        quality={'seed':True,'control':True,'reuse':False}
        self.assertFalse(m.prefix_qualified([seed,control,reuse],['research'],1,quality))
        repaired={**reuse,'id':'repair','phase':'comparison-repair-1'}
        quality['repair']=True
        self.assertTrue(m.prefix_qualified([seed,control,reuse,repaired],['research'],1,quality))
        del quality['control']
        self.assertFalse(m.prefix_qualified([seed,control,reuse,repaired],['research'],1,quality))

    def test_repairs_do_not_erase_first_pass_quality_failures(self):
        rows=[{'id':'a','phase':'comparison','case':'research-delta-1','condition':'improved'},
              {'id':'b','phase':'comparison','case':'research-delta-2','condition':'improved'},
              {'id':'c','phase':'comparison-repair-1','case':'research-delta-1','condition':'improved'}]
        r=m.quality_rates(rows,{'a':False,'b':True,'c':True})['improved']
        self.assertEqual(r,{'initial_passed':1,'initial_tasks':2,'final_passed':2,'final_tasks':2,'repair_starts':1})

if __name__=='__main__':unittest.main()
