import functools
import http.server
import json
import re
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_browser import QuietHandler
from test_tokens import jwt


def main():
    root=Path(__file__).resolve().parents[1]
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=str(root)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    state={'method':'password','error':None}; calls=[]
    def transport(route):
        url=route.request.url
        if url.startswith('https://www.gstatic.com/firebasejs/'):return route.continue_()
        if not url.startswith('https://identitytoolkit.googleapis.com/'):
            raise AssertionError('Unexpected external request: '+url.split('?')[0])
        endpoint=url.split('?')[0].split('/')[-1]
        calls.append((endpoint,route.request.post_data_json))
        if state['error']:
            return route.fulfill(status=400,json={'error':{'message':state['error']}})
        if endpoint=='projects':return route.fulfill(json={'projectId':'123','authorizedDomains':['localhost']})
        anonymous=state['method']=='anonymous'
        user={'localId':'test-user','createdAt':'1700000000000','lastLoginAt':'1700000000000','providerUserInfo':[]}
        if not anonymous:user.update(email='tester@example.com',emailVerified=True,passwordHash='synthetic')
        if endpoint=='accounts:lookup':return route.fulfill(json={'users':[user]})
        expected={'password':'accounts:signInWithPassword','register':'accounts:signUp','anonymous':'accounts:signUp','google':'accounts:signInWithIdp','custom':'accounts:signInWithCustomToken'}[state['method']]
        assert endpoint==expected,(endpoint,expected)
        assert url.endswith('key=corrected-synthetic-key'), 'Sign-in used a stale API key'
        return route.fulfill(json={'localId':'test-user','idToken':jwt(),'refreshToken':'synthetic-refresh','expiresIn':'3600',**({} if anonymous else {'email':'tester@example.com'})})
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch();page=browser.new_page();errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.route(re.compile(r'^https://'),transport)
            page.goto(f'http://127.0.0.1:{server.server_port}')
            page.fill('#config',json.dumps({'apiKey':'fake-key','projectId':'demo-firelab'}));page.click('#connect-form button.primary')
            expect(page.locator('#connection-next')).to_be_visible(timeout=30000);page.click('#connection-next button[value="later"]')
            page.click('.nav[data-tab="auth"]')

            state['error']='API key not valid. Please pass a valid API key.'
            page.fill('#email','tester@example.com');page.fill('#password','synthetic-password');page.click('#auth-form button.primary')
            expect(page.locator('#auth-key-repair')).to_be_visible()
            expect(page.locator('#auth-key-current')).to_contain_text('fake-key')
            state['error']=None
            page.fill('#auth-replacement-key','corrected-synthetic-key');page.click('#auth-repair-form button')
            expect(page.locator('#auth-key-repair')).to_be_hidden()
            expect(page.locator('#notice')).to_contain_text('Reconnect Authentication completed')
            expect(page.locator('#auth')).to_be_visible()
            assert page.locator('#password').input_value()==''
            for method in ['password','register','anonymous','google','custom']:
                state['method']=method
                page.select_option('#auth-method','password' if method=='register' else method)
                if method in ['password','register']:
                    page.select_option('#auth-action','register' if method=='register' else 'signin')
                    page.fill('#email','tester@example.com');page.fill('#password','synthetic-password')
                elif method in ['google','custom']:page.fill('#token','synthetic-token')
                page.click('#auth-form button.primary')
                if method in ['register','anonymous']:page.click('#review button[value="confirm"]')
                expect(page.locator('#identity')).to_have_text('Anonymous user' if method=='anonymous' else 'tester@example.com',timeout=15000)
                expect(page.locator('#notice')).to_contain_text('Authenticate completed')
                page.click('#signout');expect(page.locator('#identity')).to_have_text('Unauthenticated')
            for code,help_text in [('INVALID_LOGIN_CREDENTIALS','Firebase rejected these credentials'),('OPERATION_NOT_ALLOWED','provider is disabled'),('API key not valid. Please pass a valid API key.','Firebase rejected the API key')]:
                state['method']='password';state['error']=code
                page.select_option('#auth-method','password');page.select_option('#auth-action','signin')
                page.fill('#email','tester@example.com');page.fill('#password','synthetic-password');page.click('#auth-form button.primary')
                expect(page.locator('#notice')).to_have_class('error')
                expect(page.locator('#notice')).to_contain_text(help_text)
                assert 'synthetic-password' not in page.locator('#result').inner_text()
            assert not errors,errors
            assert any(endpoint=='accounts:signInWithPassword' and body['password']=='synthetic-password' for endpoint,body in calls)
            browser.close()
        print('PASS: wrong-key UI repair and reconnection; real Auth SDK email/password, registration, anonymous, Google credential, custom token, sign-out and three error responses. All project endpoints intercepted.')
    finally:server.shutdown();server.server_close()


if __name__=='__main__':main()
