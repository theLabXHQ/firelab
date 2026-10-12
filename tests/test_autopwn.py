import json
from pathlib import Path
import unittest
import re
from playwright.sync_api import expect
import test_tokens
from test_tokens import jwt

class AutoPwnTests(unittest.TestCase):
    setUpClass = classmethod(test_tokens.TokenTests.setUpClass.__func__)
    tearDownClass = classmethod(test_tokens.TokenTests.tearDownClass.__func__)
    setUp = test_tokens.TokenTests.setUp
    tearDown = test_tokens.TokenTests.tearDown

    def prepare(self):
        self.page.fill('#token-project', 'demo-firelab')
        self.page.click('[data-token-tab="audit"]')
        self.page.locator('#audit-advanced summary').click()
        self.page.uncheck('#audit-verify')
        self.page.select_option('#audit-scope-mode', 'custom')
        self.page.select_option('#audit-concurrency', '1')

    def test_matrix_get_list_and_redacted_report(self):
        self.prepare()
        token = jwt()
        self.page.click('#audit-token-tools')
        self.page.fill('#jwt-a', token)
        self.page.click('[data-token-tab="audit"]')
        self.page.fill('#audit-paths', 'posts\nposts/welcome\nposts')
        self.page.check('#audit-private')
        calls = []
        def respond(route):
            calls.append(route.request)
            if route.request.headers.get('authorization'):
                route.fulfill(status=403, json={'error': {'status': 'PERMISSION_DENIED'}})
            else:
                route.fulfill(json={'documents': [{'fields': {'secret': 'MUST_NOT_EXPORT'}}]})
        self.page.route('https://firestore.googleapis.com/**', respond)
        self.page.click('#audit-run')
        expect(self.page.locator('#audit-status')).to_contain_text('4 / 4 reads · complete')
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(r.method == 'GET' for r in calls))
        expect(self.page.locator('#audit-results')).to_contain_text('list')
        expect(self.page.locator('#audit-results')).to_contain_text('get')
        with self.page.expect_download() as pending:
            self.page.click('#audit-export')
        report = Path(pending.value.path()).read_text()
        self.assertNotIn(token, report)
        self.assertNotIn('MUST_NOT_EXPORT', report)
        data = json.loads(report)
        self.assertEqual(data['completedRequests'], 4)
        self.assertTrue(any('Unexpected' in x['finding'] for x in data['findings']))
        self.assertTrue(data['coverage']['untested'])

    def test_invalid_scope_sends_nothing(self):
        self.prepare()
        calls = []
        self.page.route(re.compile(r'^https://'), lambda r: (calls.append(r.request.url), r.abort()))
        for scope in ['posts/../private', '\n'.join('path'+str(i) for i in range(501))]:
            self.page.fill('#audit-paths', scope)
            self.page.click('#audit-run')
            expect(self.page.locator('#audit-status')).not_to_contain_text('Starting')
        self.assertEqual(calls, [])

    def test_stop_preserves_partial_report(self):
        self.prepare()
        self.page.fill('#audit-paths', 'posts\nusers\nsettings')
        calls = []
        def respond(route):
            calls.append(route.request.url)
            self.page.evaluate("document.getElementById('audit-stop').click()")
            route.fulfill(json={})
        self.page.route('https://firestore.googleapis.com/**', respond)
        self.page.click('#audit-run')
        expect(self.page.locator('#audit-status')).to_contain_text('1 / 3 reads · stopped')
        self.assertEqual(len(calls), 1)
        expect(self.page.locator('#audit-export')).to_be_enabled()

    def test_clear_discards_inflight_and_stops_queue(self):
        self.prepare()
        self.page.fill('#audit-paths', 'posts\nusers')
        calls = []
        def respond(route):
            calls.append(route.request.url)
            self.page.evaluate("document.getElementById('tokens-clear').click()")
            route.fulfill(json={})
        self.page.route('https://firestore.googleapis.com/**', respond)
        self.page.click('#audit-run')
        expect(self.page.locator('#audit-run')).to_be_enabled()
        self.assertEqual(len(calls), 1)
        expect(self.page.locator('#audit-results')).to_be_empty()
        expect(self.page.locator('#audit-export')).to_be_disabled()

    def test_network_failure_is_not_permission_denial(self):
        self.prepare()
        self.page.fill('#audit-paths', 'posts')
        self.page.route('https://firestore.googleapis.com/**', lambda r: r.abort())
        self.page.click('#audit-run')
        expect(self.page.locator('#audit-status')).to_contain_text('complete')
        expect(self.page.locator('#audit-results')).to_contain_text('network/response error')
        expect(self.page.locator('#audit-results')).not_to_contain_text('denied')

    def test_quick_start_guides_disconnected_user(self):
        self.page.click('#autopwn-quick')
        expect(self.page.locator('#overview')).to_be_visible()
        expect(self.page.locator('#notice')).to_contain_text('Paste your Firebase config')

    def demo_start(self):
        self.page.click('.nav[data-tab="overview"]')
        self.page.click('#demo')
        self.page.click('#autopwn-quick')
        expect(self.page.locator('#audit-login')).to_be_visible()

    def test_demo_public_requires_no_manual_inputs(self):
        calls = []
        self.page.route(re.compile(r'^https://'), lambda r: (calls.append(r.request.url), r.abort()))
        self.demo_start()
        self.page.click('#audit-login button[value="public"]')
        expect(self.page.locator('#audit-status')).to_contain_text('complete · Demo')
        expect(self.page.locator('#audit-results')).to_contain_text('posts')
        expect(self.page.locator('#audit-results')).to_contain_text('denied')
        self.assertEqual(calls, [])

    def test_login_redirect_and_resume(self):
        self.demo_start()
        self.page.click('#audit-login button[value="login"]')
        expect(self.page.locator('#auth')).to_be_visible()
        expect(self.page.locator('#auth-guidance')).to_be_visible()
        self.page.fill('#email', 'tester@example.com')
        self.page.fill('#password', 'demo-password')
        self.page.click('#auth-form button.primary')
        expect(self.page.locator('#token-audit')).to_be_visible()
        expect(self.page.locator('#audit-status')).to_contain_text('complete · Demo')
        expect(self.page.locator('#audit-results')).to_contain_text('Signed-in demo')
        expect(self.page.locator('#audit-results')).to_contain_text('No token')

    def test_cancel_login_sends_no_requests(self):
        self.demo_start()
        self.page.click('#audit-login button[value="cancel"]')
        expect(self.page.locator('#audit-run')).to_be_enabled()
        expect(self.page.locator('#audit-results')).to_be_empty()

    def test_access_matrix_filters_and_open_path(self):
        self.demo_start()
        self.page.click('#audit-login button[value="public"]')
        expect(self.page.locator('#audit-status')).to_contain_text('complete')
        expect(self.page.locator('#tokens-heading')).to_have_text('AutoPwn')
        expect(self.page.locator('#autopwn-quick')).to_have_class('nav active')
        self.page.fill('#audit-search', 'posts/welcome')
        expect(self.page.locator('#audit-matrix-body tr')).to_have_count(1)
        expect(self.page.locator('#audit-matrix-body')).to_contain_text('Allowed')
        expect(self.page.locator('#audit-matrix-body')).to_contain_text('Not tested')
        self.page.select_option('#audit-filter', 'denied')
        expect(self.page.locator('#audit-matrix-body')).to_contain_text('No matching results')
        self.page.select_option('#audit-filter', 'all')
        self.page.click('#audit-matrix-body button')
        expect(self.page.locator('#firestore')).to_be_visible()
        expect(self.page.locator('#fs-path')).to_have_value('posts/welcome')
        expect(self.page.locator('#fs-operation')).to_have_value('get')
