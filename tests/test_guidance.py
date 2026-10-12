import json
from pathlib import Path
import unittest
import re
from playwright.sync_api import expect
import test_tokens

class GuidanceTests(unittest.TestCase):
    setUpClass = classmethod(test_tokens.TokenTests.setUpClass.__func__)
    tearDownClass = classmethod(test_tokens.TokenTests.tearDownClass.__func__)
    setUp = test_tokens.TokenTests.setUp
    tearDown = test_tokens.TokenTests.tearDown

    def demo_scan(self):
        self.page.click('.nav[data-tab="overview"]');self.page.click('#demo')
        self.page.click('#autopwn-quick');self.page.click('#audit-login button[value="public"]')
        expect(self.page.locator('#audit-run')).to_be_enabled()

    def test_navigation_is_compact(self):
        self.assertEqual(self.page.locator('.nav .nav-description').count(), 0)
        expect(self.page.locator('.nav[data-tab="firestore"]')).to_contain_text('Firestore')

    def test_auto_scope_includes_known_and_candidates(self):
        result=self.page.evaluate('''async()=>{const {selectScope}=await import('./src/collection-candidates.js');return selectScope({known:['custom/doc/nested']}).paths;}''')
        self.assertIn('custom/doc/nested',result);self.assertIn('users',result);self.assertGreater(len(result),240)

    def test_rest_samples_validate_paths_preserve_values_and_bound_memory(self):
        result=self.page.evaluate('''async()=>{
          const {sampleDocuments,createSampleStore}=await import('./src/audit-samples.js');
          const job={label:'No token',path:'posts',kind:'collection'};
          const response={evidence:{engine:'rest'},body:{documents:[{name:'projects/demo-firelab/databases/(default)/documents/posts/a',fields:{large:{integerValue:'9007199254740993'},html:{stringValue:'<img src=x onerror=alert(1)>'},obj:{mapValue:{fields:{yes:{booleanValue:true}}}}}},{name:'projects/other/databases/(default)/documents/posts/b',fields:{}},{name:'projects/demo-firelab/databases/(default)/documents/private/c',fields:{}}]}};
          const docs=sampleDocuments('demo-firelab',job,response);const store=createSampleStore(1);store.add('demo-firelab',job,response);store.add('demo-firelab',{...job,label:'Token A'},response);return {docs,snapshot:store.snapshot()};
        }''')
        self.assertEqual(len(result['docs']),1)
        self.assertEqual(result['docs'][0]['data']['large'],'9007199254740993')
        self.assertTrue(result['docs'][0]['data']['obj']['yes'])
        self.assertEqual(result['snapshot']['count'],1);self.assertTrue(result['snapshot']['truncated'])

    def test_scan_populates_graph_without_extra_reads_and_clears_on_token_change(self):
        network=[];self.page.route(re.compile(r'^https://'),lambda r:(network.append(r.request.url),r.abort()))
        self.demo_scan()
        expect(self.page.locator('#audit-open-graph')).to_be_enabled()
        self.page.click('#audit-open-graph')
        expect(self.page.locator('#graph')).to_be_visible()
        expect(self.page.locator('#graph-source')).to_have_value('0')
        expect(self.page.locator('#graph-source-note')).to_contain_text('No token')
        self.page.select_option('#graph-jump','d:posts/welcome')
        expect(self.page.locator('#inspector-content')).to_contain_text('Welcome to Firelab')
        self.page.click('.nav[data-tab="tokens"]');self.page.fill('#jwt-a','changed')
        self.assertEqual(self.page.locator('#graph-source option').count(),1)
        self.assertEqual(network,[])

    def test_graph_identity_sources_are_separate(self):
        self.page.click('.nav[data-tab="overview"]');self.page.click('#demo')
        self.page.click('.nav[data-tab="auth"]');self.page.fill('#email','demo@example.com');self.page.fill('#password','example');self.page.click('#auth-form button.primary')
        self.page.click('#autopwn-quick');expect(self.page.locator('#audit-run')).to_be_enabled()
        self.page.click('#audit-open-graph')
        options=self.page.locator('#graph-source option').all_text_contents()
        self.assertTrue(any('Signed-in demo' in x for x in options))
        for idx,text in enumerate(options):
            if 'No token' in text:
                self.page.select_option('#graph-source',str(idx-1))
                self.assertEqual(self.page.locator('[data-node-id="d:users/demo"]').count(),0)
            if 'Signed-in demo' in text:
                self.page.select_option('#graph-source',str(idx-1))
                self.assertEqual(self.page.locator('[data-node-id="d:users/demo"]').count(),1)

    def test_graph_fullscreen_enters_and_exits(self):
        self.page.click('.nav[data-tab="overview"]');self.page.click('#demo')
        self.page.click('#graph-fullscreen')
        expect(self.page.locator('#graph-fullscreen')).to_have_attribute('aria-pressed','true')
        self.page.click('#graph-fullscreen')
        expect(self.page.locator('#graph-fullscreen')).to_have_attribute('aria-pressed','false')

    def test_security_review_and_baselines_are_offline_redacted(self):
        calls=[];self.page.route(re.compile(r'^https://'),lambda r:(calls.append(r.request.url),r.abort()))
        self.page.click('.nav[data-tab="security"]');self.page.click('#security-run')
        expect(self.page.locator('#security-checks')).to_contain_text('Not verified')
        expect(self.page.locator('#security-checks')).to_contain_text('Hiding this config does not protect data')
        self.page.select_option('#security-baseline','owner-read')
        expect(self.page.locator('#security-rule-preview')).to_contain_text('request.auth.uid == uid')
        expect(self.page.locator('#security-rule-preview')).to_contain_text('allow write: if false')
        self.page.select_option('#security-rule-file','database.rules.json')
        with self.page.expect_download() as pending:self.page.click('#security-download-rule')
        rules=json.loads(Path(pending.value.path()).read_text())
        self.assertFalse(rules['rules']['.write'])
        self.assertEqual(calls,[])
        result=self.page.evaluate('''async()=>{const {securityReview}=await import('./src/security.js');return securityReview({apiKey:'SECRET_KEY',projectId:'demo-firelab'},null,'{"private_key":"PRIVATE_MATERIAL"}');}''')
        serialized=json.dumps(result)
        self.assertIn('Private server credential detected',serialized)
        self.assertNotIn('SECRET_KEY',serialized);self.assertNotIn('PRIVATE_MATERIAL',serialized)
