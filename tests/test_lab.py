import unittest
from playwright.sync_api import expect
import test_tokens


class LabTests(unittest.TestCase):
    setUpClass=classmethod(test_tokens.TokenTests.setUpClass.__func__)
    tearDownClass=classmethod(test_tokens.TokenTests.tearDownClass.__func__)
    setUp=test_tokens.TokenTests.setUp
    tearDown=test_tokens.TokenTests.tearDown

    def lab(self):
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}/?lab=1')

    def test_normal_workspace_keeps_cloud_endpoints(self):
        expect(self.page.locator('#lab-panel')).to_be_hidden()
        result=self.page.evaluate("async()=>{const {labURL,LAB}=await import('./src/lab.js?v=1.14.1');return {LAB,url:labURL('https://firestore.googleapis.com/v1/projects/real-project/databases/(default)/documents/posts')}}")
        self.assertFalse(result['LAB'])
        self.assertTrue(result['url'].startswith('https://firestore.googleapis.com'))

    def test_lab_routes_only_fixed_project(self):
        self.lab();expect(self.page.locator('#lab-panel')).to_be_visible()
        result=self.page.evaluate('''async()=>{
            const {labURL}=await import('./src/lab.js?v=1.14.1');
            const good=labURL('https://firestore.googleapis.com/v1/projects/demo-firelab-lab/databases/(default)/documents/posts');
            let rejected=0;
            for(const url of ['https://firestore.googleapis.com/v1/projects/another-project/databases/(default)/documents/posts','https://example.com/','https://securetoken.googleapis.com/v1/token?key=real-key'])try{labURL(url)}catch{rejected++}
            return {good,rejected,again:labURL(good)};
        }''')
        self.assertEqual(result['rejected'],3)
        self.assertTrue(result['good'].startswith('http://127.0.0.1:18085/'))
        self.assertEqual(result['again'],result['good'])

    def test_lab_sdk_rejects_cloud_config_before_loading_sdk(self):
        self.lab()
        message=self.page.evaluate("async()=>{const f=await import('./src/firebase.js?v=1.14.1');try{await f.connect({projectId:'other-project',apiKey:'fake'},()=>{})}catch(e){return e.message}}")
        self.assertIn('only demo-firelab-lab',message)

    def test_request_preview_and_curl_target_emulator(self):
        self.lab()
        result=self.page.evaluate("async()=>{const {buildReadURL,requestCurl}=await import('./src/tokens.js?v=1.14.1');const url=buildReadURL('demo-firelab-lab','public','collection');return requestCurl(url,true)}")
        self.assertIn('127.0.0.1:18085',result)
        self.assertNotIn('firestore.googleapis.com',result)

    def test_production_verifier_rejects_emulator_token(self):
        self.lab()
        token=test_tokens.jwt({'aud':'demo-firelab-lab','iss':'https://securetoken.google.com/demo-firelab-lab'}, {'alg':'none'})
        message=self.page.evaluate("async token=>{const {verifyToken}=await import('./src/tokens.js?v=1.14.1');try{await verifyToken(token,'demo-firelab-lab')}catch(e){return e.message}}",token)
        self.assertIn('Unsigned emulator tokens are not verified',message)


if __name__=='__main__':unittest.main()
