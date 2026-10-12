import json
from pathlib import Path
import unittest
import re
import zipfile
from playwright.sync_api import expect
import test_tokens


class WorkbenchTests(unittest.TestCase):
    setUpClass = classmethod(test_tokens.TokenTests.setUpClass.__func__)
    tearDownClass = classmethod(test_tokens.TokenTests.tearDownClass.__func__)
    setUp = test_tokens.TokenTests.setUp
    tearDown = test_tokens.TokenTests.tearDown

    def test_rate_is_shared_across_workers_identities_and_followup(self):
        result = self.page.evaluate('''async () => {
          const {auditPlan,runAudit}=await import('./src/audit-engine.js');
          const plan=auditPlan('demo-firelab','posts',[]);
          plan.identities.push({label:'Synthetic user',token:null});plan.total=2;
          const starts=[];
          const report=await runAudit(plan,{verify:false,concurrency:4,rateLimit:20,discover:true,read:async job=>{
            starts.push(performance.now());
            return {evidence:{path:job.path,kind:job.kind,identity:job.label,outcome:'readable',sampledDocuments:1},documents:[{path:'posts/a',data:{}}]};
          }});
          return {starts,report};
        }''')
        self.assertEqual(len(result['starts']), 4)
        gaps = [b-a for a,b in zip(result['starts'],result['starts'][1:])]
        self.assertTrue(all(gap >= 45 for gap in gaps), gaps)
        self.assertEqual(result['report']['rateLimit'],20)

    def test_stop_cancels_waiting_rate_slots(self):
        result = self.page.evaluate('''async () => {
          const {auditPlan,runAudit}=await import('./src/audit-engine.js');
          let stop=false,calls=0;const start=performance.now();
          const report=await runAudit(auditPlan('demo-firelab',['a','b','c'].join(String.fromCharCode(10)),[]),{verify:false,concurrency:3,rateLimit:1,stopped:()=>stop,read:async job=>{
            calls++;setTimeout(()=>stop=true,30);
            return {evidence:{path:job.path,kind:job.kind,identity:job.label,outcome:'denied'}};
          }});
          return {calls,status:report.status,duration:performance.now()-start};
        }''')
        self.assertEqual(result['calls'],1)
        self.assertEqual(result['status'],'stopped')
        self.assertLess(result['duration'],700)

    def test_invalid_rate_rejected_before_dispatch(self):
        result = self.page.evaluate('''async()=>{
          const {auditPlan,runAudit}=await import('./src/audit-engine.js');let calls=0,errors=0;
          for(const rateLimit of [-1,101,1.5,NaN])try{await runAudit(auditPlan('demo-firelab','posts',[]),{rateLimit,read:async()=>calls++});}catch{errors++;}
          return {calls,errors};
        }''')
        self.assertEqual(result,{'calls':0,'errors':4})

    def test_findings_jsonl_is_redacted_actionable_and_stable(self):
        result = self.page.evaluate('''async()=>{
          const {buildFindings,findingsJSONL}=await import('./src/audit-findings.js');
          const report={project:'demo-firelab',status:'complete',privateScope:true,requests:[{identity:'No token',path:'users/a',kind:'document',outcome:'readable'}],findings:[],mutations:[],rawToken:'DO_NOT_EXPORT_TOKEN'};
          report.highlights=buildFindings(report,{sources:[{label:'No token · rest',documents:[{path:'users/a',data:{password:'DO_NOT_EXPORT_VALUE'}}]}]});
          return {a:findingsJSONL(report),b:findingsJSONL(report)};
        }''')
        self.assertEqual(result['a'],result['b'])
        self.assertNotIn('DO_NOT_EXPORT',result['a'])
        records=[json.loads(line) for line in result['a'].splitlines()]
        self.assertEqual(records[0]['type'],'scan')
        self.assertEqual(records[1]['priority'],'action required')
        self.assertEqual(records[2]['confidence'],'field-name heuristic')
        self.assertTrue(all(r['remediation'] and r['retest'] for r in records[1:]))

    def test_empty_public_result_is_not_public_data_finding(self):
        result = self.page.evaluate('''async()=>{
          const {buildFindings}=await import('./src/audit-findings.js');
          return buildFindings({privateScope:true,requests:[{identity:'No token',path:'missing',kind:'collection',outcome:'readable',sampledDocuments:0}],findings:[],mutations:[]});
        }''')
        self.assertEqual(result['groups']['publicData'],[])

    def test_outcomes_and_jsonl_ui(self):
        self.page.fill('#token-project','demo-firelab')
        self.page.click('[data-token-tab="audit"]')
        self.page.locator('#audit-advanced summary').click()
        self.page.select_option('#audit-scope-mode','custom')
        self.page.uncheck('#audit-verify')
        self.page.fill('#audit-paths','missing\nexpired\nthrottled\nunavailable')
        def respond(route):
            path=route.request.url.split('/')[-1].split('?')[0]
            code={'missing':404,'expired':401,'throttled':429,'unavailable':503}[path]
            route.fulfill(status=code,json={'error':{'status':'SYNTHETIC'}})
        self.page.route('https://firestore.googleapis.com/**',respond)
        self.page.click('#audit-run')
        expect(self.page.locator('#audit-status')).to_contain_text('complete')
        expect(self.page.locator('#audit-metric-errors')).to_have_text('3')
        self.page.select_option('#audit-filter','error')
        expect(self.page.locator('#audit-matrix-body')).not_to_contain_text('missing')
        expect(self.page.locator('#audit-matrix-body')).to_contain_text('rate limited')
        with self.page.expect_download() as pending:self.page.click('#audit-jsonl')
        rows=[json.loads(line) for line in Path(pending.value.path()).read_text().splitlines()]
        self.assertEqual(len(rows),4)
        self.assertTrue(any(r.get('outcome') == 'unauthenticated' for r in rows))
        self.page.select_option('#audit-rate','10')
        expect(self.page.locator('#audit-jsonl')).to_be_disabled()

    def test_developer_baseline_downloads_are_offline(self):
        calls=[]
        self.page.route(re.compile(r'^https://'),lambda route:(calls.append(route.request.url),route.abort()))
        self.page.click('.nav[data-tab="security"]')
        for mode in ['deny','owner-read']:
            self.page.select_option('#security-baseline',mode)
            self.page.select_option('#security-rule-file','firelab.rules.test.mjs')
            with self.page.expect_download() as pending:self.page.click('#security-download-rule')
            code=Path(pending.value.path()).read_text()
            self.assertIn("projectId: 'demo-firelab-rules'",code)
            self.assertIn("host: '127.0.0.1'",code)
            self.assertIn("role === 'owner' ? assertSucceeds",code) if mode=='owner-read' else self.assertNotIn("role === 'owner' ? assertSucceeds",code)
        self.page.select_option('#security-rule-file','package.json')
        package=json.loads(self.page.locator('#security-rule-preview').inner_text())
        self.assertIn('--project demo-firelab-rules',package['scripts']['test'])
        self.assertEqual(calls,[])

    def test_new_scan_clears_old_graph_and_highlights(self):
        self.page.click('.nav[data-tab="overview"]');self.page.click('#demo')
        self.page.click('#autopwn-quick');self.page.click('#audit-login button[value="public"]')
        expect(self.page.locator('#audit-open-graph')).to_be_enabled()
        self.page.evaluate('''()=>{const button=document.querySelector('#audit-stop');const observer=new MutationObserver(()=>{if(!button.disabled){button.click();observer.disconnect();}});observer.observe(button,{attributes:true,attributeFilter:['disabled']});document.querySelector('#audit-run').click();}''')
        self.page.click('#audit-login button[value="public"]')
        expect(self.page.locator('#audit-run')).to_be_enabled()
        expect(self.page.locator('#audit-status')).to_contain_text('stopped')
        expect(self.page.locator('#audit-summary')).to_contain_text('completed requests only')
        expect(self.page.locator('#audit-jsonl')).to_be_enabled()

    def test_downloaded_zip_contains_matching_rules_and_tests(self):
        self.page.click('.nav[data-tab="security"]')
        for mode in ['deny','owner-read']:
            self.page.select_option('#security-baseline',mode)
            with self.page.expect_download() as pending:self.page.click('#security-download-bundle')
            with zipfile.ZipFile(pending.value.path()) as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual(len(archive.namelist()),6)
                expected=self.page.evaluate('''async mode => (await import('./src/security.js')).ruleTemplates(mode)''',mode)
                for name,content in expected.items():self.assertEqual(archive.read(name).decode(),content)


if __name__ == '__main__': unittest.main()
