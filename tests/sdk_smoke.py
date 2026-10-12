import functools
import http.server
import json
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    requests = []
    service_requests = []

    def intercept_storage(route):
        assert route.request.method == 'GET', 'Only read operations in Storage smoke test'
        service_requests.append('storage')
        name = 'readme.txt'
        if route.request.url.split('?')[0].endswith('/o'):
            body = {'prefixes': ['docs/'], 'items': [{'name': name, 'bucket': 'demo-firelab.appspot.com'}], 'nextPageToken': 'next-page'}
        else:
            body = {'name': name, 'bucket': 'demo-firelab.appspot.com', 'size': '10', 'contentType': 'text/plain', 'generation': '1'}
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body))

    def intercept_function(route):
        service_requests.append('function')
        assert route.request.post_data_json == {'data': {'test': True}}
        route.fulfill(status=200, content_type='application/json', body='{"data":{"message":"intercepted response"}}')

    def intercept(route):
        url = route.request.url.split('?')[0]
        requests.append({'url': url, 'body': route.request.post_data_json})
        doc = {'name': 'projects/demo-firelab/databases/(default)/documents/posts/welcome', 'fields': {'title': {'stringValue': 'Adapter verified'}}, 'createTime': '2026-01-01T00:00:00Z', 'updateTime': '2026-01-01T00:00:00Z'}
        if url.endswith(':runQuery'):
            body = [{'document': doc, 'readTime': '2026-01-01T00:00:00Z'}]
        elif url.endswith(':batchGet'):
            body = [{'found': doc, 'readTime': '2026-01-01T00:00:00Z'}]
        elif url.endswith(':commit'):
            body = {'writeResults': [{'updateTime': '2026-01-01T00:00:00Z'}], 'commitTime': '2026-01-01T00:00:00Z'}
        else:
            raise AssertionError(f'Unexpected request: {url}')
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body))

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.route('https://fonts.googleapis.com/**', lambda route: route.abort())
            page.route('https://firestore.googleapis.com/**', intercept)
            page.route('https://firebasestorage.googleapis.com/**', intercept_storage)
            page.route('https://us-central1-demo-firelab.cloudfunctions.net/**', intercept_function)
            page.goto(f'http://127.0.0.1:{server.server_port}')
            result = page.evaluate('''async () => {
              const f = await import('./src/firebase.js');
              for (const name of ['app','auth','firestore/lite','database','storage','functions']) await f.sdk(name);
              const s = await f.connect({apiKey:'fake-key',projectId:'demo-firelab',storageBucket:'demo-firelab.appspot.com'},()=>{});
              try {
                const query = await f.firestore(s,{operation:'query',path:'posts',filters:[{field:'published',op:'==',value:true}],limit:10});
                const get = await f.firestore(s,{operation:'get',path:'posts/welcome'});
                const set = await f.firestore(s,{operation:'set',path:'posts/welcome',data:{title:'test'},merge:true});
                const update = await f.firestore(s,{operation:'update',path:'posts/welcome',data:{title:'updated'}});
                const del = await f.firestore(s,{operation:'delete',path:'posts/welcome'});
                const storageList = await f.storage(s,{operation:'list',path:''});
                const metadata = await f.storage(s,{operation:'metadata',path:'readme.txt'});
                const callable = await f.invoke(s,{name:'helloWorld',region:'us-central1',data:{test:true}});
                return {query,get,set,update,del,storageList,metadata,callable};
              } finally { await f.disconnect(s); }
            }''')
            assert result['query']['documents'][0]['data']['title'] == 'Adapter verified', result
            assert result['get']['exists'], result
            assert all(result[key]['completed'] for key in ['set', 'update', 'del']), result
            assert len(requests) == 5, requests
            assert requests[0]['body']['structuredQuery']['limit'] == 10, requests[0]
            assert requests[0]['body']['structuredQuery']['where']['fieldFilter']['value'] == {'booleanValue': True}, requests[0]
            assert requests[3]['body']['writes'][0]['currentDocument']['exists'], requests[3]
            assert 'delete' in requests[4]['body']['writes'][0], requests[4]
            assert result['storageList']['files'] == ['readme.txt'], result
            assert result['storageList']['nextPageToken'] == 'next-page', result
            assert result['metadata']['size'] == 10, result
            assert result['callable']['message'] == 'intercepted response', result
            assert service_requests == ['storage', 'storage', 'function'], service_requests

            page.fill('#config', json.dumps({'apiKey':'fake-key','projectId':'demo-firelab','storageBucket':'demo-firelab.appspot.com'}))
            workspace = {'schema':'firelab.workspaces/v1','workspace':{'name':'SDK restore','config':{'apiKey':'fake-key','projectId':'demo-firelab','storageBucket':'demo-firelab.appspot.com'},'collectionPaths':['workspace_saved_collection'],'scanPaths':['workspace_saved_collection'],'settings':{}}}
            page.set_input_files('#workspace-file',{'name':'workspace.json','mimeType':'application/json','buffer':json.dumps(workspace).encode()})
            expect(page.locator('#notice')).to_contain_text('Workspace imported')
            page.click('#workspace-open')
            expect(page.locator('#notice')).to_contain_text('Opened')
            page.click('#connect-form button.primary')
            expect(page.locator('#connection')).to_have_text('● SDK ready', timeout=30000)
            expect(page.locator('#connection-next')).to_be_visible()
            page.click('#connection-next button[value="later"]')
            expect(page.locator('#graph-nodes')).to_contain_text('workspace_saved_collection')
            assert page.locator('#audit-paths').input_value() == 'workspace_saved_collection'
            page.click('.nav[data-tab="tokens"]')
            example = page.evaluate("btoa(JSON.stringify({alg:'RS256',kid:'example'})).replace(/=/g,'') + '.' + btoa(JSON.stringify({iss:'https://securetoken.google.com/demo-firelab',aud:'demo-firelab',sub:'example'})).replace(/=/g,'') + '.c2ln'")
            page.fill('#jwt-a', example)
            page.locator('#jwt-a').dispatch_event('change')
            expect(page.locator('#connection-next')).to_be_visible()
            expect(page.locator('#connection-next-message')).to_contain_text('Firebase ID token')
            page.click('#connection-next button[value="login"]')
            expect(page.locator('#auth')).to_be_visible()
            page.click('#auth-audit-cancel')
            page.click('#audit-token-tools')
            page.click('#tokens-clear')

            page.click('.nav[data-tab="overview"]')
            page.locator('.console-panel summary').click()
            page.click('#enable-console')
            expect(page.locator('#console-status')).to_contain_text('Enabled for demo-firelab', timeout=30000)
            assert page.evaluate('Boolean(window.authService && window.firestoreService && window.storageService && window.functionsService && window.firelabSDK)')
            page.click('.nav[data-tab="tokens"]')
            page.click('[data-token-tab="audit"]')
            page.locator('#audit-advanced summary').click()
            page.select_option('#audit-engine', 'sdk')
            page.select_option('#audit-scope-mode', 'custom')
            page.fill('#audit-paths', 'posts')
            before = len(requests)
            page.click('#audit-run')
            page.click('#audit-login button[value="public"]')
            expect(page.locator('#audit-status')).to_contain_text('1 / 1 reads · complete', timeout=30000)
            assert len(requests) == before + 1
            assert requests[-1]['url'].endswith(':runQuery')
            assert requests[-1]['body']['structuredQuery']['limit'] == 5
            expect(page.locator('#audit-matrix-body')).to_contain_text('Allowed')
            expect(page.locator('#audit-open-graph')).to_be_enabled()
            page.click('.nav[data-tab="overview"]')
            page.click('#disconnect')
            expect(page.locator('#connection')).to_have_text('● Disconnected')
            assert page.evaluate("['authService','firestoreService','storageService','functionsService','firelabSDK'].every(k => !(k in window))")
            browser.close()
        print('PASS: six CDN modules, SDK initialization, Firestore query/get/set/update/delete, Storage listing/metadata, callable serialization and response decoding, console bridge lifecycle, connection/token sign-in prompts, Client SDK audit transport and graph samples, disconnect. All project transport intercepted; no live Firebase project accessed.')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
