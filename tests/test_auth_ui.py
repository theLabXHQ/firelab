import json
import unittest
from playwright.sync_api import expect
import test_tokens


class AuthUITests(unittest.TestCase):
    setUpClass = classmethod(test_tokens.TokenTests.setUpClass.__func__)
    tearDownClass = classmethod(test_tokens.TokenTests.tearDownClass.__func__)
    setUp = test_tokens.TokenTests.setUp
    tearDown = test_tokens.TokenTests.tearDown

    def test_hidden_invalid_email_does_not_block_other_methods(self):
        self.page.click('.nav[data-tab="overview"]');self.page.click('#demo')
        self.page.click('.nav[data-tab="auth"]');self.page.fill('#email','invalid-email')
        self.page.select_option('#auth-method','anonymous')
        expect(self.page.locator('#email')).to_be_disabled()
        self.page.click('#auth-form button.primary')
        expect(self.page.locator('#review')).to_be_visible()
        self.page.click('#review button[value="confirm"]')
        expect(self.page.locator('#identity')).to_have_text('Anonymous user')
        self.page.select_option('#auth-method','password')
        expect(self.page.locator('#email')).to_be_enabled()
        self.assertFalse(self.page.locator('#auth-form').evaluate('(form)=>form.checkValidity()'))

    def test_readonly_diagnostic_and_invalid_key_message(self):
        self.page.click('.nav[data-tab="overview"]')
        self.page.fill('#config',json.dumps({'apiKey':'SYNTHETIC_KEY','projectId':'demo-firelab','messagingSenderId':'123'}))
        self.page.click('.nav[data-tab="auth"]')
        calls=[]
        def invalid(route):
            calls.append(route.request.method)
            route.fulfill(status=400,json={'error':{'message':'API key not valid. Please pass a valid API key.','details':[{'reason':'API_KEY_INVALID'}]}})
        self.page.route('https://identitytoolkit.googleapis.com/**',invalid)
        self.page.click('#auth-diagnose')
        expect(self.page.locator('#notice')).to_contain_text('auth/invalid-api-key')
        expect(self.page.locator('#notice')).not_to_contain_text('SYNTHETIC_KEY')
        self.page.unroute('https://identitytoolkit.googleapis.com/**')
        self.page.route('https://identitytoolkit.googleapis.com/**',lambda r:(calls.append(r.request.method),r.fulfill(json={'projectId':'123','authorizedDomains':['localhost'],'apiKey':'NEVER_EXPORT'})))
        self.page.click('#auth-diagnose')
        expect(self.page.locator('#notice')).to_contain_text('completed')
        result=json.loads(self.page.locator('#result').inner_text())['result']
        self.assertTrue(result['projectNumberMatches'])
        self.assertNotIn('NEVER_EXPORT',json.dumps(result))
        self.assertEqual(calls,['GET','GET'])

    def test_auth_error_guidance_excludes_sdk_message(self):
        result=self.page.evaluate('''async()=>{const {safeError}=await import('./src/core.js');return ['auth/invalid-api-key','auth/operation-not-allowed','auth/invalid-credential','auth/invalid-custom-token','auth/network-request-failed'].map(code=>safeError({code,message:'SECRET_TOKEN_AND_PASSWORD'}));}''')
        self.assertNotIn('SECRET_TOKEN_AND_PASSWORD',str(result))
        self.assertTrue(any('provider is disabled' in text for text in result))
        self.assertTrue(any('Tokens & requests' in text for text in result))


if __name__ == '__main__': unittest.main()
