import json
import unittest
from playwright.sync_api import expect
import test_tokens


class ReviewTests(unittest.TestCase):
    setUpClass=classmethod(test_tokens.TokenTests.setUpClass.__func__)
    tearDownClass=classmethod(test_tokens.TokenTests.tearDownClass.__func__)
    setUp=test_tokens.TokenTests.setUp
    tearDown=test_tokens.TokenTests.tearDown

    def scan(self):
        self.page.fill('#token-project','demo-firelab')
        self.page.route('https://firestore.googleapis.com/**',lambda route:route.fulfill(json={'documents':[{'name':'projects/demo-firelab/databases/(default)/documents/posts/item','fields':{'title':{'stringValue':'PRIVATE_DOCUMENT_VALUE'}}}]}))
        self.page.click('[data-token-tab="audit"]');self.page.locator('#audit-advanced summary').click()
        self.page.select_option('#audit-scope-mode','custom');self.page.fill('#audit-paths','posts')
        self.page.click('#audit-run');expect(self.page.locator('#audit-export')).to_be_enabled()

    def test_token_only_scan_graph_without_sdk(self):
        self.scan();self.page.click('#audit-open-graph')
        expect(self.page.locator('#graph-connected')).to_be_visible()
        expect(self.page.locator('#graph-session')).to_contain_text('AUDIT SNAPSHOT / demo-firelab')
        self.page.select_option('#graph-jump','d:posts/item')
        expect(self.page.locator('#inspector-content')).to_contain_text('PRIVATE_DOCUMENT_VALUE')
        expect(self.page.locator('#inspector-content button',has_text='Open document editor')).to_be_disabled()
        self.page.click('.nav[data-tab="tokens"]');self.page.fill('#token-project','another-project')
        self.page.click('.nav[data-tab="graph"]');expect(self.page.locator('#graph-disconnected')).to_be_visible()
        self.assertEqual(self.page.locator('.graph-node').count(),0)

    def test_other_project_snapshot_cannot_open_current_sdk_editor(self):
        self.page.evaluate('''async()=>{
          const {createGraph}=await import('./src/graph.js?v=1.14.1');
          const g=createGraph({onRead:()=>{},onOpen:()=>{throw Error('Wrong project')},onExport:()=>{},notify:()=>{}});
          g.setSession({config:{projectId:'project-one'},demo:true});g.addPaths(['original']);
          g.auditSamples('project-two',{sources:[{label:'No token',documents:[{path:'other/item',data:{title:'Snapshot'}}]}]});
        }''')
        self.page.click('.nav[data-tab="graph"]');self.page.select_option('#graph-jump','d:other/item')
        expect(self.page.locator('#inspector-content button',has_text='Open document editor')).to_be_disabled()
        self.page.select_option('#graph-source','')
        expect(self.page.locator('#graph-session')).to_contain_text('project-one')
        expect(self.page.locator('#graph-nodes')).to_contain_text('original')
        expect(self.page.locator('#graph-nodes')).not_to_contain_text('Snapshot')

    def test_history_persists_without_document_values(self):
        self.scan();self.page.locator('#scan-history summary').first.click();self.page.fill('#history-name','Before rules')
        self.page.click('#history-save');expect(self.page.locator('#history-count')).to_contain_text('1/20')
        saved=self.page.evaluate('localStorage.getItem("firelab.scan-history.v1")')
        self.assertNotIn('PRIVATE_DOCUMENT_VALUE',saved)
        self.page.reload();self.page.click('.nav[data-tab="tokens"]');self.page.click('[data-token-tab="audit"]')
        self.page.locator('#scan-history summary').first.click();self.page.select_option('#history-selected',index=1)
        self.page.click('#history-open');expect(self.page.locator('#history-preview')).to_contain_text('demo-firelab')
        self.page.select_option('#history-baseline',index=1);self.page.click('#history-compare')
        expect(self.page.locator('#history-comparison')).to_contain_text('1 matching read cases · 0 read changes')
        with self.page.expect_download() as event:self.page.click('#history-export')
        from pathlib import Path
        self.assertNotIn('PRIVATE_DOCUMENT_VALUE',Path(event.value.path()).read_text())
        self.page.on('dialog',lambda d:d.accept());self.page.click('#history-delete');expect(self.page.locator('#history-count')).to_contain_text('0/20')

    def test_history_allowlist_and_comparison_boundaries(self):
        result=self.page.evaluate('''async()=>{
          const {cleanReport,compareSavedReports}=await import('./src/scan-history.js?v=1.14.1');
          const r={project:'demo-test',engine:'rest',status:'complete',sampleLimit:5,environment:'firebase',requests:[{path:'posts',kind:'collection',identity:'Token A',tokenFingerprint:'1234567890abcdef',outcome:'denied',body:{secret:'NEVER_KEEP'}}],mutations:[{collection:'posts',path:'posts/canary',identity:'Token A',create:'denied',update:'not tested',delete:'not tested',token:'NEVER_KEEP'}],tokens:[{token:'NEVER_KEEP'}],password:'NEVER_KEEP',sources:[{data:'NEVER_KEEP'}]};
          const before=cleanReport(r),after=structuredClone(before);after.requests[0].outcome='readable';after.mutations[0].create='allowed';after.mutations[0].update='allowed';
          const match=compareSavedReports(before,after);after.requests[0].tokenFingerprint='abcdef1234567890';const otherToken=compareSavedReports(before,after);after.environment='local-emulator';const environment=compareSavedReports(before,after);
          return {clean:JSON.stringify(before),match,otherToken,environment};
        }''')
        self.assertNotIn('NEVER_KEEP',result['clean']);self.assertEqual(len(result['match']['readChanges']),1)
        self.assertEqual([r['kind'] for r in result['match']['writeChanges']],['permission outcome changed','test coverage or inconclusive outcome changed'])
        self.assertEqual(result['otherToken']['matchingReads'],0);self.assertEqual(result['otherToken']['writeChanges'],[])
        self.assertFalse(result['environment']['compatible'])

    def test_history_storage_failure_preserves_previous_data(self):
        result=self.page.evaluate('''async()=>{
          const {scanHistoryStore}=await import('./src/scan-history.js?v=1.14.1');
          const report={project:'demo-test',engine:'rest',status:'complete',sampleLimit:5,requests:[],mutations:[]};
          let raw=null,fail=false;const storage={getItem:()=>raw,setItem:(_,value)=>{if(fail)throw Error('quota');raw=value}};
          const store=scanHistoryStore(()=>storage);store.save('Before',report);const original=raw;fail=true;let quota=false;try{store.save('After',report)}catch(e){quota=e.message.includes('full or blocked')}
          const intact=raw===original;raw='bad json';let corrupt=false;try{store.save('Another',report)}catch{corrupt=raw==='bad json'}
          return {quota,intact,corrupt};
        }''')
        self.assertEqual(result,{'quota':True,'intact':True,'corrupt':True})

    def test_authentication_failure_is_inconclusive(self):
        result=self.page.evaluate("async()=>{const {buildFindings}=await import('./src/audit-findings.js?v=1.14.1');return buildFindings({requests:[{path:'posts',identity:'Token A',outcome:'unauthenticated'}],findings:[],mutations:[]}).groups.errors}")
        self.assertEqual(len(result),1);self.assertEqual(result[0]['confidence'],'inconclusive')

    def test_canary_limit_selection_and_evidence_rows(self):
        self.page.click('[data-token-tab="audit"]');self.page.locator('#audit-advanced summary').click()
        self.page.evaluate('''async()=>{
          const {setupAutoPwn}=await import('./src/autopwn.js?v=1.14.1');
          const a=setupAutoPwn(()=>{},{onComplete:r=>window.finalReport=r,context:async()=>({project:'demo-test',demo:true,signedIn:true,paths:[],read:async job=>{await new Promise(r=>setTimeout(r,job.path==='first'?60:1));return {evidence:{path:job.path,kind:job.kind,identity:job.label,outcome:'denied',http:403}}},canaryCommit:()=>async()=>({response:{ok:true,status:200},body:{writeResults:[{updateTime:'synthetic-version'}]}})})});
          const $=id=>document.getElementById(id);$('audit-scope-mode').value='custom';$('audit-paths').value='first\\nsecond';$('audit-concurrency').value='5';$('audit-writes').checked=true;$('audit-updates').checked=true;$('audit-write-limit').value='1';window.auditPromise=a.start(true);
        }''')
        expect(self.page.locator('#audit-write-review')).to_be_visible()
        self.page.evaluate("window.firstEvidenceRow=document.querySelector('#audit-results tr')")
        self.page.click('#audit-write-review button[value="confirm"]');expect(self.page.locator('#audit-export')).to_be_enabled()
        result=self.page.evaluate('({report:window.finalReport,sameRow:window.firstEvidenceRow===document.querySelector("#audit-results tr")})')
        self.assertEqual(result['report']['mutations'][0]['collection'],'first')
        self.assertEqual(result['report']['mutations'][0]['identity'],'No token')
        self.assertTrue(result['sameRow'])
        expect(self.page.locator('#audit-write-coverage')).to_contain_text('3 eligible collection/identity pairs excluded')


if __name__=='__main__':unittest.main()
