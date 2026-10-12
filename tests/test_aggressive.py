import unittest
from playwright.sync_api import expect
import test_tokens

class AggressiveTests(unittest.TestCase):
    setUpClass = classmethod(test_tokens.TokenTests.setUpClass.__func__)
    tearDownClass = classmethod(test_tokens.TokenTests.tearDownClass.__func__)
    setUp = test_tokens.TokenTests.setUp
    tearDown = test_tokens.TokenTests.tearDown

    def scan(self, options):
        return self.page.evaluate('''async options => {
          const {auditPlan,runAudit}=await import('./src/audit-engine.js');
          const plan=auditPlan('demo-firelab','posts',[]);
          let calls=[], stop=false;
          const report=await runAudit(plan,{verify:false,concurrency:3,...options,
            stopped:()=>stop,
            read:async job=>{
              calls.push(job.path);
              if(options.stop) stop=true;
              const data={self:'projects/demo-firelab/databases/(default)/documents/posts/a',
                ref:'projects/demo-firelab/databases/(default)/documents/private/b',
                foreign:'projects/other-project/databases/(default)/documents/private/c'};
              return {evidence:{identity:job.label,path:job.path,kind:job.kind,outcome:'readable',sampledDocuments:1},
                documents:[{path:job.kind==='collection'?'posts/a':job.path,data}]};
            }});
          return {calls,report};
        }''', options)

    def test_reference_followup_deduplication_and_project_boundary(self):
        result=self.scan({'discover': True})
        self.assertEqual(result['calls'],['posts','posts/a','private/b'])
        self.assertEqual(result['report']['plannedRequests'],3)
        self.assertEqual(result['report']['discovery']['addedPaths'],2)

    def test_budget_and_stop(self):
        result=self.scan({'discover':True,'maxPaths':2})
        self.assertEqual(len(result['calls']),2)
        self.assertTrue(result['report']['discovery']['limitReached'])
        result=self.scan({'discover':True,'stop':True})
        self.assertEqual(result['calls'],['posts'])
        self.assertEqual(result['report']['status'],'stopped')

    def test_standard_does_not_expand(self):
        self.assertEqual(self.scan({})['calls'],['posts'])

    def test_findings_exclude_values(self):
        result=self.page.evaluate('''async()=>{
          const {buildFindings}=await import('./src/audit-findings.js');
          return buildFindings({requests:[{identity:'No token',path:'users/a',kind:'document',outcome:'readable'}],findings:[],mutations:[]},
            {sources:[{label:'No token',documents:[{path:'users/a',data:{email:'PRIVATE_VALUE',nested:{password:'SECRET_VALUE'}}}]}]});
        }''')
        self.assertEqual(len(result['groups']['publicData']),1)
        self.assertEqual(result['groups']['sensitiveFields'][0]['fields'],['email','nested.password'])
        self.assertNotIn('PRIVATE_VALUE',str(result))
        self.assertNotIn('SECRET_VALUE',str(result))

    def test_preset_and_custom_scope(self):
        self.page.fill('#token-project','demo-firelab')
        self.page.click('[data-token-tab="audit"]')
        self.page.select_option('#audit-profile','aggressive')
        expect(self.page.locator('#audit-concurrency')).to_have_value('50')
        expect(self.page.locator('#audit-sample')).to_have_value('100')
        expect(self.page.locator('#audit-scope-mode')).to_have_value('discovery')
        self.page.locator('#audit-advanced summary').click()
        self.page.uncheck('#audit-verify')
        self.page.select_option('#audit-scope-mode','custom')
        self.page.fill('#audit-paths','posts')
        calls=[]
        def respond(route):
            calls.append(route.request)
            route.fulfill(json={'documents':[{'name':'projects/demo-firelab/databases/(default)/documents/posts/a','fields':{'email':{'stringValue':'PRIVATE_VALUE'}}}]})
        self.page.route('https://firestore.googleapis.com/**',respond)
        self.page.click('#audit-run')
        expect(self.page.locator('#audit-status')).to_contain_text('1 / 1 reads · complete')
        self.assertEqual(len(calls),1)
        self.assertTrue(all(r.method=='GET' for r in calls))
        expect(self.page.locator('#audit-highlights')).to_contain_text('email')
        expect(self.page.locator('#audit-highlights')).not_to_contain_text('PRIVATE_VALUE')

    def test_followup_checks_each_identity_and_distinguishes_get_from_list(self):
        result=self.page.evaluate('''async()=>{
          const {auditPlan,runAudit}=await import('./src/audit-engine.js');
          const plan=auditPlan('demo-firelab','posts',[]);
          plan.identities.push({label:'Synthetic signed-in',token:null}); plan.total=2;
          let active=0, peak=0;
          const report=await runAudit(plan,{verify:false,discover:true,concurrency:2,read:async job=>{
            peak=Math.max(peak,++active);
            await new Promise(resolve=>setTimeout(resolve,5)); active--;
            const denied=job.kind==='document' && job.label==='No token';
            return {evidence:{identity:job.label,path:job.path,kind:job.kind,outcome:denied?'denied':'readable',sampledDocuments:1},
              documents:denied?[]:[{path:'posts/a',data:{}}]};
          }});
          return {report,peak};
        }''')
        self.assertLessEqual(result['peak'],2)
        self.assertEqual(result['report']['completedRequests'],4)
        self.assertEqual(result['report']['plannedRequests'],4)
        self.assertTrue(any(f['finding']=='Read permission differs across tested identities' for f in result['report']['findings']))
