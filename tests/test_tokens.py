import base64
import functools
import http.server
import json
from pathlib import Path
import threading
import time
import unittest
import re
from urllib.parse import parse_qs
from playwright.sync_api import sync_playwright, expect
from test_browser import QuietHandler

ROOT = Path(__file__).resolve().parents[1]
JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'


def jwt(payload=None, header=None):
    now = int(time.time())
    claims = {'iss': 'https://securetoken.google.com/demo-firelab', 'aud': 'demo-firelab', 'sub': 'test-user', 'iat': now, 'auth_time': now - 60, 'exp': now + 3600, **(payload or {})}
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    return encode(header or {'alg': 'RS256', 'kid': 'test-key'}) + '.' + encode(claims) + '.c2ln'


class TokenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width': 1440, 'height': 1000})
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}')
        self.page.click('.nav[data-tab="tokens"]')

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.errors, [])

    def test_decode_offline_and_token_types(self):
        network = []
        self.page.route(re.compile(r'^https://'), lambda route: (network.append(route.request.url), route.abort()))
        self.page.fill('#jwt-a', 'Bearer ' + jwt({'name': 'Demo User · 日本語'}))
        self.page.fill('#token-project', 'demo-firelab')
        self.page.click('#token-decode')
        expect(self.page.locator('#token-summary')).to_contain_text('Decoded only')
        expect(self.page.locator('#token-payload')).to_contain_text('日本語')
        self.assertEqual(network, [])
        tokens = [jwt({'iss': 'https://accounts.google.com'}), jwt({'iss': 'service-account', 'aud': 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit'}), jwt({'iss': 'https://session.firebase.google.com/demo-firelab'})]
        kinds = self.page.evaluate("async values => {const t=await import('./src/tokens.js'); return values.map(v=>t.decodeToken(v).kind)}", tokens)
        self.assertEqual(kinds, ['Google ID token', 'Firebase custom token', 'Firebase session cookie'])

    def test_invalid_and_opaque_token_rejection(self):
        for token in ['opaque-refresh-token', 'bad.%%%.sig', 'e30.W10.sig']:
            self.page.fill('#jwt-a', token)
            self.page.click('#token-decode')
            expect(self.page.locator('#token-notice')).to_have_class('inline-notice error')
        self.assertEqual(self.page.locator('#token-payload').inner_text(), '—')

    def test_claim_diff_nested_and_missing(self):
        self.page.fill('#jwt-a', jwt({'role': 'reader', 'permissions': {'read': True, 'write': False}, 'old': 1}))
        self.page.fill('#jwt-b', jwt({'role': 'editor', 'permissions': {'read': True, 'write': True}}))
        self.page.click('[data-token-tab="compare"]'); self.page.click('#token-diff-run')
        expect(self.page.locator('#token-diff')).to_contain_text('/permissions/write')
        expect(self.page.locator('#token-diff')).to_contain_text('removed')
        self.assertEqual(self.page.locator('#token-diff .changed-row').count(), 3)

    def test_crypto_valid_tampered_expired_wrong_project(self):
        generated = self.page.evaluate('''async () => {
          const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
          const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);jwk.kid='local-test';
          const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\\+/g,'-').replace(/\\//g,'_');
          const json=v=>b64(new TextEncoder().encode(JSON.stringify(v)));
          const now=Math.floor(Date.now()/1000);
          const base={iss:'https://securetoken.google.com/demo-firelab',aud:'demo-firelab',sub:'signed-test-user',iat:now-100,auth_time:now-200,exp:now+1000};
          async function sign(payload) {const data=json({alg:'RS256',kid:'local-test'})+'.'+json(payload);return data+'.'+b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(data))));}
          const valid=await sign(base);const parts=valid.split('.');parts[1]=json({...base,sub:'tampered'});
          return {jwk,valid,tampered:parts.join('.'),expired:await sign({...base,exp:now-10}),future:await sign({...base,auth_time:now+500})};
        }''')
        key_requests = []
        def keys(route):
            key_requests.append(route.request)
            route.fulfill(status=200, content_type='application/json', headers={'Cache-Control': 'public,max-age=3600'}, body=json.dumps({'keys': [generated['jwk']]}))
        self.page.route(JWKS, keys)
        results = self.page.evaluate('''async data => { const t=await import('./src/tokens.js'); return {
          valid:await t.verifyToken(data.valid,'demo-firelab'),tampered:await t.verifyToken(data.tampered,'demo-firelab'),
          expired:await t.verifyToken(data.expired,'demo-firelab'),wrongProject:await t.verifyToken(data.valid,'other-project'),future:await t.verifyToken(data.future,'demo-firelab')}; }''', generated)
        self.assertTrue(results['valid']['signatureValid'] and results['valid']['claimsValid'])
        self.assertFalse(results['tampered']['signatureValid'])
        self.assertTrue(results['expired']['signatureValid']); self.assertFalse(results['expired']['claimsValid'])
        self.assertFalse(results['wrongProject']['claimsValid']); self.assertFalse(results['future']['claimsValid'])
        self.assertEqual(len(key_requests), 1)
        self.assertIsNone(key_requests[0].post_data)
        self.assertNotIn('authorization', key_requests[0].headers)
        self.page.fill('#jwt-a', generated['valid']); self.page.fill('#token-project', 'demo-firelab'); self.page.click('#token-verify')
        expect(self.page.locator('#token-summary')).to_contain_text('Signature and claims valid')
        self.page.fill('#jwt-a', generated['tampered'])
        expect(self.page.locator('#token-summary')).not_to_contain_text('Signature and claims valid')

    def test_unsigned_and_wrong_type_never_verified(self):
        network = []
        self.page.route(re.compile(r'^https://'), lambda route: (network.append(route.request.url), route.abort()))
        self.page.click('#token-example'); self.page.click('#token-verify')
        expect(self.page.locator('#token-notice')).to_contain_text('require RS256')
        self.page.fill('#jwt-a', jwt({'iss': 'https://accounts.google.com'})); self.page.click('#token-verify')
        expect(self.page.locator('#token-notice')).to_contain_text('supports Firebase ID tokens only')
        self.assertEqual(network, [])

    def test_read_matrix_and_redacted_export(self):
        a, b = jwt({'sub': 'alice'}), jwt({'sub': 'bob'})
        self.page.fill('#jwt-a', a); self.page.fill('#jwt-b', b); self.page.fill('#token-project', 'demo-firelab')
        self.page.click('[data-token-tab="request"]'); self.page.fill('#request-path', 'posts')
        requests = []
        def respond(route):
            request = route.request; requests.append(request)
            auth = request.headers.get('authorization')
            if auth == 'Bearer ' + a: status, body = 200, {'documents': [{'name': 'private-response-marker'}]}
            elif auth == 'Bearer ' + b: status, body = 401, {'error': {'status': 'UNAUTHENTICATED'}}
            else: status, body = 403, {'error': {'status': 'PERMISSION_DENIED'}}
            route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
        self.page.route('https://firestore.googleapis.com/**', respond)
        self.page.click('#request-matrix')
        expect(self.page.locator('#token-notice')).to_contain_text('Comparison complete')
        self.assertEqual(len(requests), 3)
        self.assertTrue(all(r.method == 'GET' and 'pageSize=5' in r.url for r in requests))
        expect(self.page.locator('#request-results')).to_contain_text('readable')
        expect(self.page.locator('#request-results')).to_contain_text('unauthenticated')
        with self.page.expect_download() as info: self.page.click('#request-export')
        raw = Path(info.value.path()).read_text(); report = json.loads(raw)
        self.assertNotIn(a, raw); self.assertNotIn(b, raw); self.assertNotIn('private-response-marker', raw)
        self.assertEqual(len(report['requests']), 3)
        self.assertEqual(len(report['requests'][1]['tokenFingerprint']), 16)
        expect(self.page.locator('#log-count')).to_have_text('0')

    def test_refresh_exchange_form_encoding_no_shared_logs(self):
        token = jwt(); requests = []
        def exchange(route):
            requests.append(route.request)
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'id_token': token, 'refresh_token': 'rotated-test-refresh'}))
        self.page.route('https://securetoken.googleapis.com/**', exchange)
        self.page.locator('.refresh-details summary').click()
        self.page.fill('#token-api-key', 'test-api-key'); self.page.fill('#token-refresh', 'refresh/+%value'); self.page.click('#token-refresh-run')
        expect(self.page.locator('#token-notice')).to_contain_text('Token A updated')
        self.assertEqual(parse_qs(requests[0].post_data), {'grant_type': ['refresh_token'], 'refresh_token': ['refresh/+%value']})
        expect(self.page.locator('#jwt-a')).to_have_value(token)
        expect(self.page.locator('#token-refresh')).to_have_value('rotated-test-refresh')
        expect(self.page.locator('#log-count')).to_have_text('0')

    def test_clear_during_refresh_discards_late_credentials(self):
        self.page.evaluate('''() => {const original=window.fetch;window.fetch=(url,options)=>String(url).startsWith('https://securetoken.googleapis.com/')?new Promise(resolve=>window.finishRefresh=()=>resolve(new Response(JSON.stringify({id_token:window.fixtureToken,refresh_token:'late-secret'}),{headers:{'Content-Type':'application/json'}}))):original(url,options);}''')
        self.page.evaluate('value => window.fixtureToken=value', jwt())
        self.page.locator('.refresh-details summary').click(); self.page.fill('#token-api-key', 'test-key'); self.page.fill('#token-refresh', 'old-secret')
        self.page.click('#token-refresh-run'); self.page.wait_for_function('typeof window.finishRefresh === "function"')
        self.page.click('#tokens-clear'); self.page.evaluate('window.finishRefresh()')
        expect(self.page.locator('#token-refresh-run')).to_be_enabled()
        expect(self.page.locator('#jwt-a')).to_have_value(''); expect(self.page.locator('#token-refresh')).to_have_value('')
        expect(self.page.locator('#token-summary')).not_to_contain_text('test-user')

    def test_network_and_configuration_not_misreported_as_rules(self):
        self.page.route('https://firestore.googleapis.com/**', lambda route: route.fulfill(status=403, content_type='application/json', body=json.dumps({'error': {'status': 'PERMISSION_DENIED', 'details': [{'reason': 'SERVICE_DISABLED'}]}})))
        result = self.page.evaluate("async()=> (await import('./src/tokens.js')).readWithToken({project:'demo-firelab',path:'posts',kind:'collection',token:null,label:'No token'})")
        self.assertEqual(result['evidence']['outcome'], 'configuration error')
        self.page.unroute('https://firestore.googleapis.com/**')
        self.page.route('https://firestore.googleapis.com/**', lambda route: route.abort())
        result = self.page.evaluate("async()=> (await import('./src/tokens.js')).readWithToken({project:'demo-firelab',path:'posts',kind:'collection',token:null,label:'No token'})")
        self.assertEqual(result['evidence']['outcome'], 'network/response error')

    def test_curl_path_validation_and_safe_text(self):
        result = self.page.evaluate('''async()=> { const t=await import('./src/tokens.js');let rejected=0;for(const path of ['../users','posts/..']){try{t.buildReadURL('demo-firelab',path,'document')}catch{rejected++}}return {rejected,curl:t.requestCurl(t.buildReadURL('demo-firelab',"posts/it's-safe",'document'),true)}; }''')
        self.assertEqual(result['rejected'], 2)
        self.assertIn('FIREBASE_ID_TOKEN', result['curl'])
        self.assertIn("'\"'\"'", result['curl'])
        self.page.fill('#jwt-a', jwt({'name': '<img src=x onerror="window.xss=1">'})); self.page.click('#token-decode')
        expect(self.page.locator('#token-payload')).to_contain_text('<img')
        self.assertEqual(self.page.locator('#tokens img').count(), 0)
        self.assertFalse(self.page.evaluate('Boolean(window.xss)'))
