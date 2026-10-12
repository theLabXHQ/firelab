import json
from pathlib import Path
import unittest
from playwright.sync_api import expect
import test_tokens

class ExpandedTests(unittest.TestCase):
    setUpClass = classmethod(test_tokens.TokenTests.setUpClass.__func__)
    tearDownClass = classmethod(test_tokens.TokenTests.tearDownClass.__func__)
    setUp = test_tokens.TokenTests.setUp
    tearDown = test_tokens.TokenTests.tearDown

    def prepare(self, paths='posts'):
        self.page.fill('#token-project', 'demo-firelab')
        self.page.click('[data-token-tab="audit"]')
        self.page.locator('#audit-advanced summary').click()
        self.page.select_option('#audit-scope-mode', 'custom')
        self.page.select_option('#audit-concurrency', '1')
        self.page.uncheck('#audit-verify')
        self.page.fill('#audit-paths', paths)

    def test_catalog_custom_only_dedup_and_bounds(self):
        result = self.page.evaluate('''async () => {
          const {COLLECTION_CANDIDATES:c,selectScope:s}=await import('./src/collection-candidates.js');
          const {auditPlan}=await import('./src/audit-engine.js');
          let rejected=false;try {auditPlan('demo-firelab','posts/../users',[]);}catch{rejected=true;}
          return {count:c.length,unique:new Set(c).size,custom:s({mode:'custom',custom:'posts\\n/posts/'}).paths, discovery:s({mode:'discovery',custom:'nested/doc/entries'}).paths.includes('nested/doc/entries'),rejected};
        }''')
        self.assertGreaterEqual(result['count'], 120)
        self.assertEqual(result['count'], result['unique'])
        self.assertEqual(result['custom'], ['posts'])
        self.assertTrue(result['discovery'] and result['rejected'])

    def test_concurrency_bounded_and_stop_keeps_inflight(self):
        result = self.page.evaluate('''async () => {
          const {auditPlan,runAudit}=await import('./src/audit-engine.js');
          let active=0,max=0,started=0,stop=false;
          const report=await runAudit(auditPlan('demo-firelab','one\\ntwo\\nthree\\nfour\\nfive',[]),{concurrency:3,verify:false,stopped:()=>stop,read:async p=>{
            started++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,20));stop=true;active--;
            return {evidence:{path:p.path,kind:p.kind,identity:p.label,outcome:'readable',sampledDocuments:0,http:200}};
          }});
          return {max,started,status:report.status,completed:report.completedRequests,empty:report.findings.every(f=>f.returnedData===false)};
        }''')
        self.assertEqual(result, {'max':3,'started':3,'status':'stopped','completed':3,'empty':True})

    def test_invalid_concurrency_sends_nothing(self):
        result=self.page.evaluate('''async()=>{const {auditPlan,runAudit}=await import('./src/audit-engine.js');let calls=0,failed=0;for(const concurrency of [0,51,1.5])try{await runAudit(auditPlan('demo-firelab','posts',[]),{concurrency,read:async()=>{calls++}})}catch{failed++}return {calls,failed};}''')
        self.assertEqual(result, {'calls':0,'failed':3})

    def test_canary_wire_create_update_delete_and_redaction(self):
        writes=[]
        def respond(route):
            writes.append(route.request.post_data_json['writes'][0])
            route.fulfill(json={'writeResults':[{'updateTime':f'2026-09-12T00:00:0{len(writes)}Z'}]})
        self.page.route('https://firestore.googleapis.com/**',respond)
        token=test_tokens.jwt()
        result=self.page.evaluate('''async token=>{const {probeCanary}=await import('./src/audit-write.js');return probeCanary({project:'demo-firelab',collection:'posts',label:'Token A',token,update:true});}''',token)
        self.assertEqual(len(writes),3)
        self.assertEqual(writes[0]['currentDocument'],{'exists':False})
        self.assertEqual(writes[1]['currentDocument'],{'updateTime':'2026-09-12T00:00:01Z'})
        self.assertEqual(writes[2]['currentDocument'],{'updateTime':'2026-09-12T00:00:02Z'})
        self.assertEqual(writes[0]['update']['name'],writes[2]['delete'])
        self.assertIn('/posts/_firelab_probe_',writes[2]['delete'])
        self.assertFalse(result['cleanupRequired'])
        self.assertEqual([result[x] for x in ['create','update','delete']],['allowed']*3)
        self.assertNotIn(token,json.dumps(result))

    def test_create_collision_never_deletes_existing(self):
        result=self.page.evaluate('''async()=>{const {probeCanary}=await import('./src/audit-write.js');let calls=0;const result=await probeCanary({project:'demo-firelab',collection:'posts',label:'No token',commit:async()=>{calls++;return {response:{ok:false,status:409},body:{error:{status:'ALREADY_EXISTS'}}}}});return {calls,result};}''')
        self.assertEqual(result['calls'],1)
        self.assertEqual(result['result']['create'],'precondition failed')
        self.assertEqual(result['result']['delete'],'not tested')
        self.assertFalse(result['result']['cleanupRequired'])

    def test_uncertain_create_retains_path_no_blind_delete(self):
        result=self.page.evaluate('''async()=>{const {probeCanary}=await import('./src/audit-write.js');let calls=0;const result=await probeCanary({project:'demo-firelab',collection:'posts',label:'No token',commit:async()=>{calls++;throw Error('timeout')}});return {calls,result};}''')
        self.assertEqual(result['calls'],1)
        self.assertTrue(result['result']['cleanupRequired'])
        self.assertIn('posts/_firelab_probe_',result['result']['path'])

    def test_unknown_update_cleanup_uses_last_confirmed_version(self):
        result=self.page.evaluate('''async()=>{const {probeCanary}=await import('./src/audit-write.js');const writes=[];const result=await probeCanary({project:'demo-firelab',collection:'posts',label:'No token',update:true,commit:async w=>{writes.push(w);if(writes.length===1)return {response:{ok:true,status:200},body:{writeResults:[{updateTime:'old'}]}};if(writes.length===2)throw Error('timeout');return {response:{ok:false,status:409},body:{error:{status:'FAILED_PRECONDITION'}}}}});return {writes,result};}''')
        self.assertEqual(result['writes'][2]['currentDocument'],{'updateTime':'old'})
        self.assertTrue(result['result']['cleanupRequired'])
        self.assertEqual(result['result']['delete'],'precondition failed')

    def test_write_review_cancel_keeps_requests_read_only(self):
        self.prepare()
        self.page.check('#audit-writes')
        methods=[]
        def respond(route):
            methods.append(route.request.method);route.fulfill(json={'documents':[]})
        self.page.route('https://firestore.googleapis.com/**',respond)
        self.page.click('#audit-run')
        expect(self.page.locator('#audit-write-review')).to_be_visible()
        expect(self.page.locator('#audit-write-detail')).to_contain_text('posts/_firelab_probe_')
        self.page.click('#audit-write-review button[value="cancel"]')
        expect(self.page.locator('#audit-run')).to_be_enabled()
        self.assertEqual(methods,['GET'])

    def test_read_denial_does_not_skip_create_update_delete_checks(self):
        self.prepare('inbox')
        self.page.check('#audit-writes')
        expect(self.page.locator('#audit-updates')).to_be_checked()
        writes=[]
        def respond(route):
            if route.request.method=='GET':
                route.fulfill(status=403,json={'error':{'status':'PERMISSION_DENIED'}});return
            write=route.request.post_data_json['writes'][0];writes.append(write)
            if len(writes)==2:
                route.fulfill(status=403,json={'error':{'status':'PERMISSION_DENIED'}})
            else:route.fulfill(json={'writeResults':[{'updateTime':'2026-09-12T00:00:01Z'}]})
        self.page.route('https://firestore.googleapis.com/**',respond)
        self.page.click('#audit-run')
        expect(self.page.locator('#audit-write-review')).to_be_visible()
        self.assertEqual(writes,[])
        self.page.click('#audit-write-review button[value="confirm"]')
        expect(self.page.locator('#audit-run')).to_be_enabled()
        expect(self.page.locator('#audit-matrix-body')).to_contain_text('Add allowed / Write denied / Delete allowed')
        self.assertEqual(len(writes),3)
        self.assertEqual(writes[0]['currentDocument'],{'exists':False})
        self.assertIn('inbox/_firelab_probe_',writes[2]['delete'])
        expect(self.page.locator('#audit-cleanup')).to_be_hidden()

    def test_stop_still_finishes_current_canary_cleanup(self):
        self.prepare('posts\nsettings')
        self.page.check('#audit-writes')
        self.page.uncheck('#audit-updates')
        writes=[]
        def respond(route):
            if route.request.method=='GET':route.fulfill(json={'documents':[]});return
            writes.append(route.request.post_data_json['writes'][0])
            if len(writes)==1:self.page.evaluate("document.getElementById('audit-stop').click()")
            route.fulfill(json={'writeResults':[{'updateTime':'2026-09-12T00:00:01Z'}]})
        self.page.route('https://firestore.googleapis.com/**',respond)
        self.page.click('#audit-run')
        self.page.click('#audit-write-review button[value="confirm"]')
        expect(self.page.locator('#audit-run')).to_be_enabled()
        self.assertEqual(len(writes),2)
        self.assertIn('delete',writes[1])
        expect(self.page.locator('#audit-status')).to_contain_text('stopped')

    def test_cleanup_ledger_survives_clearing_mid_delete(self):
        self.prepare()
        self.page.check('#audit-writes')
        def respond(route):
            if route.request.method=='GET':route.fulfill(json={});return
            write=route.request.post_data_json['writes'][0]
            if 'delete' in write:
                self.page.evaluate("document.getElementById('tokens-clear').click()")
                route.fulfill(status=403,json={'error':{'status':'PERMISSION_DENIED'}})
            else:route.fulfill(json={'writeResults':[{'updateTime':'2026-09-12T00:00:01Z'}]})
        self.page.route('https://firestore.googleapis.com/**',respond)
        self.page.click('#audit-run')
        self.page.click('#audit-write-review button[value="confirm"]')
        expect(self.page.locator('#audit-cleanup')).to_be_visible()
        expect(self.page.locator('#audit-cleanup-paths')).to_contain_text('posts/_firelab_probe_')
        expect(self.page.locator('#audit-export')).to_be_disabled()
        with self.page.expect_download() as pending:self.page.click('#audit-cleanup-export')
        report=json.loads(Path(pending.value.path()).read_text())
        self.assertTrue(report['entries'][0]['cleanupRequired'])

    def test_retry_errors_only_and_markdown_excludes_body(self):
        self.prepare('posts\nsettings')
        calls=[]
        def respond(route):
            calls.append(route.request.url)
            if '/settings?' in route.request.url and len(calls)<=2:route.abort()
            else:route.fulfill(json={'documents':[{'secret':'NO_EXPORT'}]})
        self.page.route('https://firestore.googleapis.com/**',respond)
        self.page.click('#audit-run')
        expect(self.page.locator('#audit-retry')).to_be_enabled()
        self.page.click('#audit-retry')
        expect(self.page.locator('#audit-status')).to_contain_text('1 / 1 reads · complete')
        self.assertEqual(len(calls),3)
        self.assertIn('/settings?',calls[-1])
        with self.page.expect_download() as pending:self.page.click('#audit-markdown')
        report=Path(pending.value.path()).read_text()
        self.assertIn('settings',report)
        self.assertNotIn('NO_EXPORT',report)

    def test_demo_client_sdk_and_canary_flow(self):
        self.page.click('.nav[data-tab="overview"]');self.page.click('#demo')
        self.page.click('.nav[data-tab="tokens"]');self.page.click('[data-token-tab="audit"]')
        self.page.locator('#audit-advanced summary').click()
        self.page.select_option('#audit-engine','sdk')
        self.page.check('#audit-writes');self.page.check('#audit-updates')
        self.page.click('#audit-run');self.page.click('#audit-login button[value="public"]')
        self.page.click('#audit-write-review button[value="confirm"]')
        expect(self.page.locator('#audit-run')).to_be_enabled()
        expect(self.page.locator('#audit-matrix-body')).to_contain_text('Add allowed / Write allowed / Delete allowed')
        expect(self.page.locator('#audit-status')).to_contain_text('Demo (simulated)')
        unknown = self.page.locator('#audit-matrix-body .access-state').filter(has_text='Delete not tested')
        self.assertGreater(unknown.count(), 0)
        self.assertTrue(all('other' in c for c in unknown.evaluate_all('(nodes)=>nodes.map(n=>n.className)')))
        expect(self.page.locator('#audit-summary')).to_contain_text('No finding does not establish')
        expect(self.page.locator('#audit-cleanup')).to_be_hidden()

    def test_report_diff_requires_same_project_and_fingerprint(self):
        result=self.page.evaluate('''async()=>{const {diffReports}=await import('./src/audit-engine.js');const a={project:'demo-firelab',engine:'rest',sampleLimit:1,requests:[{path:'posts',kind:'collection',identity:'Token A',tokenFingerprint:'x',outcome:'denied'}]};const b=structuredClone(a);b.requests[0].outcome='readable';const same=diffReports(a,b);b.requests[0].tokenFingerprint='y';const other=diffReports(a,b);b.project='another-project';return {same,other,project:diffReports(a,b)};}''')
        self.assertEqual(len(result['same']),1)
        self.assertEqual(result['other'],[])
        self.assertEqual(result['project'],[])
