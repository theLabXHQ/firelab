import functools
import http.server
import json
from pathlib import Path
import threading
import unittest

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


class FirelabTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width': 1440, 'height': 1050})
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('https://fonts.googleapis.com/**', lambda route: route.abort())
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}')

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.errors, [])

    def demo(self):
        self.page.click('#demo')
        expect(self.page.locator('#connection')).to_have_text('● Demo mode')

    def tab(self, name):
        self.page.click(f'.nav[data-tab="{name}"]')

    def submit(self, form):
        self.page.click(f'#{form}-form button.primary')

    def result(self):
        expect(self.page.locator('#notice')).not_to_contain_text('in progress')
        return json.loads(self.page.locator('#result').text_content())

    def confirm(self):
        self.page.click('#review button[value="confirm"]')

    def test_disconnected_guard(self):
        self.tab('firestore')
        self.page.fill('#fs-path', 'posts')
        self.submit('firestore')
        expect(self.page.locator('#notice')).to_contain_text('Connect a project')

    def test_config_parser_and_no_execution(self):
        results = self.page.evaluate('''async () => {
          const {parseConfig} = await import('./src/core.js');
          const good = parseConfig("const firebaseConfig = {apiKey:'abc',projectId:'demo',databaseURL:'https://demo.firebaseio.com',};");
          let rejected = false;
          try { parseConfig("{apiKey: alert('oops'), projectId: 'demo'}"); } catch {rejected = true;}
          let missing = false;
          try {parseConfig('{"projectId":"demo"}');} catch {missing = true;}
          const literal = parseConfig('{"apiKey":"abc,}","projectId":"demo"}');
          return {good, rejected, missing, literal};
        }''')
        self.assertEqual(results['good']['databaseURL'], 'https://demo.firebaseio.com')
        self.assertTrue(results['rejected'])
        self.assertTrue(results['missing'])
        self.assertEqual(results['literal']['apiKey'], 'abc,}')

    def test_query_and_filter(self):
        self.demo()
        self.tab('firestore')
        self.page.fill('#fs-filters', '[{"field":"title","op":"==","value":"Welcome to Firelab"}]')
        self.submit('firestore')
        self.assertEqual(self.result()['result']['count'], 1)

    def test_invalid_path_and_filter(self):
        self.demo()
        self.tab('firestore')
        self.page.fill('#fs-path', 'users/alice')
        self.submit('firestore')
        self.assertIn('odd number', self.result()['result']['error'])
        self.page.fill('#fs-path', 'posts')
        self.page.fill('#fs-filters', '[{"field":"name","op":"in","value":1}]')
        self.submit('firestore')
        self.assertIn('nonempty array', self.result()['result']['error'])

    def test_crud_and_cancel(self):
        self.demo()
        self.tab('firestore')
        self.page.select_option('#fs-operation', 'set')
        self.page.fill('#fs-path', 'posts/test')
        self.page.fill('#fs-data', '{"title":"Created","count":1}')
        self.submit('firestore')
        expect(self.page.locator('#review')).to_be_visible()
        self.page.click('#review button[value="cancel"]')
        expect(self.page.locator('#notice')).to_contain_text('cancelled')
        self.page.select_option('#fs-operation', 'get')
        self.submit('firestore')
        self.assertFalse(self.result()['result']['exists'])
        self.page.select_option('#fs-operation', 'set')
        self.submit('firestore')
        self.confirm()
        self.assertTrue(self.result()['result']['completed'])
        self.page.select_option('#fs-operation', 'update')
        self.page.fill('#fs-data', '{"count":2}')
        self.submit('firestore')
        self.confirm()
        self.result()
        self.page.select_option('#fs-operation', 'get')
        self.submit('firestore')
        self.assertEqual(self.result()['result']['data'], {'title': 'Created', 'count': 2})
        self.page.select_option('#fs-operation', 'delete')
        self.submit('firestore')
        self.confirm()
        self.result()
        self.page.select_option('#fs-operation', 'get')
        self.submit('firestore')
        self.assertFalse(self.result()['result']['exists'])

    def test_auth_changes_permissions_and_clears_password(self):
        self.demo()
        self.tab('firestore')
        self.page.fill('#fs-path', 'users')
        self.submit('firestore')
        self.assertEqual(self.result()['status'], 'denied')
        self.tab('auth')
        self.page.fill('#email', 'demo@example.com')
        self.page.fill('#password', 'not-a-real-password')
        self.submit('auth')
        self.result()
        expect(self.page.locator('#password')).to_have_value('')
        self.tab('firestore')
        self.submit('firestore')
        self.assertEqual(self.result()['result']['count'], 1)
        self.tab('auth')
        self.page.click('#signout')
        self.result()
        self.tab('firestore')
        self.submit('firestore')
        self.assertEqual(self.result()['status'], 'denied')

    def test_permission_checks(self):
        self.demo()
        self.tab('checks')
        self.submit('checks')
        report = self.result()['result']
        self.assertEqual(report['completed'], 4)
        self.assertEqual({x['path']: x['status'] for x in report['results']}, {'posts': 'readable', 'settings': 'readable', 'users': 'denied', 'private': 'denied'})
        expect(self.page.locator('#progress-label')).to_contain_text('Complete')

    def test_realtime_write_and_read(self):
        self.demo()
        self.tab('realtime')
        self.page.select_option('#rt-operation', 'set')
        self.page.fill('#rt-data', '{"enabled":false}')
        self.submit('realtime')
        self.confirm()
        self.result()
        self.page.select_option('#rt-operation', 'get')
        self.submit('realtime')
        self.assertEqual(self.result()['result']['value'], {'enabled': False})

    def test_storage_upload_list_download_delete(self):
        self.demo()
        self.tab('storage')
        self.page.select_option('#st-operation', 'upload')
        self.page.fill('#st-path', 'test.txt')
        self.page.set_input_files('#st-file', {'name': 'test.txt', 'mimeType': 'text/plain', 'buffer': b'hello demo'})
        self.submit('storage')
        self.confirm()
        self.result()
        self.page.select_option('#st-operation', 'metadata')
        self.submit('storage')
        self.assertEqual(self.result()['result']['size'], 10)
        self.page.select_option('#st-operation', 'download')
        with self.page.expect_download() as info:
            self.submit('storage')
        self.assertEqual(info.value.suggested_filename, 'test.txt')
        self.result()
        self.page.select_option('#st-operation', 'delete')
        self.submit('storage')
        self.confirm()
        self.result()
        self.page.select_option('#st-operation', 'list')
        self.page.fill('#st-path', '')
        self.submit('storage')
        self.assertNotIn('test.txt', self.result()['result']['files'])

    def test_callable_review(self):
        self.demo()
        self.tab('functions')
        self.page.fill('#fn-name', 'helloWorld')
        self.page.fill('#fn-data', '{"name":"Demo User"}')
        self.submit('functions')
        self.confirm()
        self.assertEqual(self.result()['result']['received'], {'name': 'Demo User'})

    def test_export_disconnect(self):
        self.demo()
        self.tab('activity')
        with self.page.expect_download() as info:
            self.page.click('#export')
        report = json.loads(Path(info.value.path()).read_text())
        self.assertNotIn('author', report)
        self.assertTrue(report['entries'][0]['demo'])
        self.tab('overview')
        self.page.click('#disconnect')
        expect(self.page.locator('#connection')).to_have_text('● Disconnected')
        expect(self.page.locator('#log-count')).to_have_text('0')

    def test_xss_rendered_as_text(self):
        self.demo()
        self.tab('firestore')
        self.page.select_option('#fs-operation', 'set')
        self.page.fill('#fs-path', 'posts/xss')
        self.page.fill('#fs-data', json.dumps({'html': '<img src=x onerror="window.xss=true">'}))
        self.submit('firestore')
        self.confirm()
        self.result()
        self.page.select_option('#fs-operation', 'get')
        self.submit('firestore')
        self.result()
        self.assertFalse(self.page.evaluate('Boolean(window.xss)'))
        self.assertEqual(self.page.locator('#result img').count(), 0)

    def test_mobile_and_theme(self):
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        self.page.click('#theme')
        expect(self.page.locator('html')).not_to_have_class('light')
        for name in ['tokens', 'graph', 'auth', 'firestore', 'realtime', 'storage', 'functions', 'checks', 'activity']:
            self.tab(name)
            self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'), name)

    def test_android_xml_import_and_manual_correction(self):
        self.page.fill('#config', '<resources><string name="google_api_key">test-key</string><string name="google_app_id">1:123:android:abc</string><string name="google_storage_bucket">example-project.appspot.com</string></resources>')
        expect(self.page.locator('#config-feedback')).to_contain_text('Android XML')
        expect(self.page.locator('#config-feedback')).to_contain_text('example-project (inferred)')
        self.page.click('#mode-manual')
        expect(self.page.locator('#cfg-projectId')).to_have_value('example-project')
        expect(self.page.locator('#cfg-apiKey')).to_have_value('test-key')
        self.page.fill('#cfg-projectId', 'corrected-project')
        self.page.click('#mode-paste')
        self.assertEqual(json.loads(self.page.locator('#config').input_value())['projectId'], 'corrected-project')

    def test_google_services_file_import(self):
        config = {'project_info': {'project_id': 'android-demo', 'project_number': '123', 'storage_bucket': 'android-demo.firebasestorage.app'}, 'client': [{'client_info': {'mobilesdk_app_id': '1:123:android:abc'}, 'api_key': [{'current_key': 'test-key'}]}]}
        self.page.set_input_files('#config-file', {'name': 'google-services.json', 'mimeType': 'application/json', 'buffer': json.dumps(config).encode()})
        expect(self.page.locator('#config-feedback')).to_contain_text('google-services.json')
        self.page.click('#mode-manual')
        expect(self.page.locator('#cfg-appId')).to_have_value('1:123:android:abc')
        expect(self.page.locator('#cfg-messagingSenderId')).to_have_value('123')

    def test_xml_rejection_and_js_comments(self):
        result = self.page.evaluate('''async () => {
          const {parseConfig} = await import('./src/core.js');
          let rejected = 0;
          for (const text of ['<!DOCTYPE x><resources/>','<string name="google_api_key">abc','<string name="google_api_key">a</string><string name="google_api_key">b</string>']) {
            try {parseConfig(text);} catch {rejected++;}
          }
          const config = parseConfig('const firebaseConfig = { /* test */ apiKey: "abc", // key\\n projectId: "demo", databaseURL: "https://demo.firebaseio.com", };');
          return {rejected, config};
        }''')
        self.assertEqual(result['rejected'], 3)
        self.assertEqual(result['config']['databaseURL'], 'https://demo.firebaseio.com')

    def test_graph_opens_on_demo_and_inspects_documents(self):
        self.demo()
        expect(self.page.locator('#graph')).to_be_visible()
        self.page.locator('[data-node-id="d:posts/welcome"] .node-heading').click()
        expect(self.page.locator('#inspector-content')).to_contain_text('Welcome to Firelab')
        self.page.locator('#inspector-content button', has_text='Open document editor').click()
        expect(self.page.locator('#firestore')).to_be_visible()
        expect(self.page.locator('#fs-path')).to_have_value('posts/welcome')
        expect(self.page.locator('#fs-operation')).to_have_value('get')

    def test_graph_nested_paths_and_denied_state(self):
        self.demo()
        self.page.fill('#graph-paths', 'posts/welcome/comments')
        self.page.click('#graph-add-form button')
        expect(self.page.locator('[data-node-id="c:posts/welcome/comments"]')).to_have_count(1)
        self.page.locator('[data-node-id="c:private"] .node-heading').click()
        self.page.click('.graph-load')
        expect(self.page.locator('[data-node-id="c:private"]')).to_have_class('graph-node collection denied selected')
        expect(self.page.locator('#inspector-content')).to_contain_text('not allowed')

    def test_graph_subcollection_and_zoom(self):
        self.demo()
        self.page.locator('[data-node-id="d:posts/welcome"] .node-heading').click()
        self.page.fill('#graph-subcollection', 'comments')
        self.page.click('.subcollection-form button')
        expect(self.page.locator('[data-node-id="c:posts/welcome/comments"]')).to_have_count(1)
        before = self.page.locator('#graph-zoom').inner_text()
        self.page.click('#graph-zoom-in')
        self.assertNotEqual(before, self.page.locator('#graph-zoom').inner_text())
        self.page.click('#graph-reset')
        expect(self.page.locator('#graph-zoom')).to_have_text('100%')

    def test_graph_clears_samples_when_identity_changes(self):
        self.demo()
        self.tab('auth')
        self.page.fill('#email', 'demo@example.com')
        self.page.fill('#password', 'demo-password')
        self.submit('auth')
        self.result()
        self.tab('graph')
        self.page.locator('[data-node-id="d:posts/welcome"] .node-heading').click()
        expect(self.page.locator('#inspector-content')).not_to_contain_text('Welcome to Firelab')
        expect(self.page.locator('#inspector-content')).to_contain_text('no document data')

    def test_graph_mobile_connected_no_overflow(self):
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.demo()
        self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        expect(self.page.locator('#graph-list-view')).to_be_visible()
        self.page.locator('[data-list-node-id="c:posts"]').click()
        expect(self.page.locator('.graph-load')).to_be_visible()
        self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))

    def test_graph_list_and_readable_view(self):
        self.demo()
        self.page.click('#graph-view-list')
        expect(self.page.locator('#graph-canvas')).to_be_hidden()
        self.page.locator('[data-list-node-id="d:posts/welcome"]').click()
        expect(self.page.locator('#inspector-content')).to_contain_text('Welcome to Firelab')
        expect(self.page.locator('#graph-jump')).to_have_value('d:posts/welcome')
        self.page.click('#graph-view-map')
        expect(self.page.locator('#graph-zoom')).to_have_text('100%')
        self.page.select_option('#graph-jump', 'c:users')
        expect(self.page.locator('#inspector-content h2')).to_have_text('users')
        self.page.click('#graph-fit')
        self.page.click('#graph-readable')
        expect(self.page.locator('#graph-zoom')).to_have_text('100%')

    def test_graph_export_and_disconnect(self):
        self.demo()
        self.page.locator('[data-node-id="project"] .node-heading').click()
        with self.page.expect_download() as info:
            self.page.locator('#inspector-content button', has_text='Export graph').click()
        data = json.loads(Path(info.value.path()).read_text())
        self.assertEqual(data['project'], 'firelab-demo')
        self.assertTrue(any(node.get('path') == 'posts/welcome' for node in data['nodes']))
        self.tab('overview')
        self.page.click('#disconnect')
        expect(self.page.locator('#connection')).to_have_text('● Disconnected')
        self.tab('graph')
        expect(self.page.locator('#graph-disconnected')).to_be_visible()
        self.assertEqual(self.page.locator('.graph-node').count(), 0)

    def test_graph_drag_and_pan(self):
        self.demo()
        node = self.page.locator('[data-node-id="c:posts"]')
        heading = node.locator('.node-heading').bounding_box()
        before = node.evaluate('(n) => n.style.left')
        self.page.mouse.move(heading['x'] + 35, heading['y'] + 15)
        self.page.mouse.down()
        self.page.mouse.move(heading['x'] + 80, heading['y'] + 45, steps=5)
        self.page.mouse.up()
        moved = node.evaluate('(n) => n.style.left')
        self.assertNotEqual(before, moved)
        node.locator('.node-heading').click()
        self.page.click('.graph-load')
        expect(self.page.locator('#notice')).to_contain_text('completed')
        self.assertEqual(node.evaluate('(n) => n.style.left'), moved)
        canvas = self.page.locator('#graph-canvas')
        canvas.focus()
        before = self.page.locator('#graph-world').get_attribute('style')
        self.page.keyboard.press('ArrowRight')
        self.assertNotEqual(before, self.page.locator('#graph-world').get_attribute('style'))

    def test_error_classification(self):
        self.assertEqual(self.page.evaluate('''async () => {
          const {classify} = await import('./src/core.js');
          return ['permission-denied','unavailable','failed-precondition','storage/unauthorized'].map(code => classify({code}));
        }'''), ['denied', 'error', 'error', 'denied'])


if __name__ == '__main__':
    unittest.main()
