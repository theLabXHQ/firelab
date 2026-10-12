import importlib.util
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import test_tokens

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('firelab_preview', ROOT / 'serve.py')
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class StaticServerSecurityTests(unittest.TestCase):
    def setUp(self):
        self.server = preview.ThreadingHTTPServer(('127.0.0.1', 0), preview.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_only_browser_assets_are_served(self):
        for path in ['/', '/index.html?v=1', '/icon.svg', '/src/app.js', '/src/workbench.css']:
            with urlopen(self.base + path) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
                self.assertEqual(response.headers['X-Frame-Options'], 'DENY')
        for method in ['GET', 'HEAD']:
            for path in ['/lab/.runtime/session.json', '/lab/%2eruntime/session.json', '/.git/config', '/firestore-debug.log', '/README.md', '/src/', '/src/../README.md', '/src/%2e%2e/README.md', '/src/%2f../.git/config', '/src/%5c../.git/config', '/.env', '/lab/firestore.rules']:
                with self.subTest(method=method, path=path), self.assertRaises(HTTPError) as raised:
                    urlopen(Request(self.base + path, method=method))
                self.assertEqual(raised.exception.code, 404)

    def test_symlink_cannot_expose_private_file(self):
        with tempfile.TemporaryDirectory() as directory:
            previous = preview.ROOT
            preview.ROOT = Path(directory)
            try:
                (preview.ROOT / 'src').mkdir()
                (preview.ROOT / 'secret.txt').write_text('PRIVATE')
                (preview.ROOT / 'src' / 'leak.js').symlink_to(preview.ROOT / 'secret.txt')
                with self.assertRaises(HTTPError) as raised:
                    urlopen(self.base + '/src/leak.js')
                self.assertEqual(raised.exception.code, 404)
            finally:
                preview.ROOT = previous

    def test_lab_uses_same_file_boundary(self):
        sys.path.insert(0, str(ROOT))
        spec = importlib.util.spec_from_file_location('firelab_lab_server', ROOT / 'lab/server.py')
        lab = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(lab)
        server = lab.ThreadingHTTPServer(('127.0.0.1', 0), lab.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for path in ['/firestore-debug.log', '/lab/.runtime/session.json', '/.git/config']:
                with self.assertRaises(HTTPError) as raised:
                    urlopen(Request(f'http://127.0.0.1:{server.server_port}{path}', headers={'Host': 'localhost:4300'}))
                self.assertEqual(raised.exception.code, 404)
            with self.assertRaises(HTTPError) as raised:
                urlopen(Request(f'http://127.0.0.1:{server.server_port}/__lab/session', headers={'Host': 'attacker.test'}))
            self.assertEqual(raised.exception.code, 403)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class ConfigSecurityTests(unittest.TestCase):
    setUpClass = classmethod(test_tokens.TokenTests.setUpClass.__func__)
    tearDownClass = classmethod(test_tokens.TokenTests.tearDownClass.__func__)
    setUp = test_tokens.TokenTests.setUp
    tearDown = test_tokens.TokenTests.tearDown

    def test_database_destination_validation(self):
        result = self.page.evaluate('''async()=>{
          const {parseConfig}=await import('./src/core.js?v=1.14.1');
          const good=['https://demo.firebaseio.com','https://demo-default-rtdb.europe-west1.firebasedatabase.app'];
          const bad=['https://attacker.example','https://demo.firebaseio.com.attacker.example','https://firebaseio.com','https://demo.firebaseio.com:8443','https://user:pass@demo.firebaseio.com','https://demo.firebaseio.com/path','https://demo.firebaseio.com?ns=other','https://demo.firebaseio.com/#fragment','http://demo.firebaseio.com','https://127.0.0.1'];
          const accepts=url=>{try{parseConfig(JSON.stringify({apiKey:'fake',projectId:'demo-project',databaseURL:url}));return true}catch{return false}};
          return {good:good.map(accepts),bad:bad.map(accepts)};
        }''')
        self.assertTrue(all(result['good']))
        self.assertFalse(any(result['bad']))

    def test_sdk_rejects_untrusted_destination_before_import(self):
        result = self.page.evaluate('''async()=>{
          const {connect}=await import('./src/firebase.js?v=1.14.1');
          try{await connect({apiKey:'fake',projectId:'demo-project',databaseURL:'https://attacker.example'},()=>{});return 'accepted'}catch(e){return e.message}
        }''')
        self.assertIn('official Firebase', result)

    def test_workspace_import_rejects_untrusted_destination(self):
        result = self.page.evaluate('''async()=>{
          const {workspaceStore}=await import('./src/workspaces.js?v=1.14.1');
          let writes=0;const store=workspaceStore(()=>({getItem:()=>null,setItem:()=>writes++}));
          try{store.import(JSON.stringify({schema:'firelab.workspaces/v1',workspace:{name:'hostile',config:{apiKey:'fake',projectId:'demo-project',databaseURL:'https://attacker.example'}}}))}catch{}
          return writes;
        }''')
        self.assertEqual(result, 0)


if __name__ == '__main__':
    unittest.main()
