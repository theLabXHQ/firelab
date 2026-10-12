from pathlib import Path
import json
import re
import unittest
from playwright.sync_api import expect
import test_tokens

CONFIG = {'apiKey':'synthetic-public-key','projectId':'demo-firelab'}

class WorkspaceTests(unittest.TestCase):
    setUpClass = classmethod(test_tokens.TokenTests.setUpClass.__func__)
    tearDownClass = classmethod(test_tokens.TokenTests.tearDownClass.__func__)
    setUp = test_tokens.TokenTests.setUp
    tearDown = test_tokens.TokenTests.tearDown

    def save(self):
        self.page.click('.nav[data-tab="overview"]')
        self.page.fill('#config',json.dumps(CONFIG))
        self.page.fill('#workspace-name','Development')
        self.page.click('#workspace-save')
        expect(self.page.locator('#notice')).to_contain_text('Saved workspace')

    def test_persist_open_update_delete(self):
        self.save()
        self.page.reload()
        self.page.select_option('#workspace-list',index=1)
        self.page.click('#workspace-open')
        expect(self.page.locator('#notice')).to_contain_text('Opened')
        self.assertEqual(json.loads(self.page.locator('#config').input_value())['projectId'],CONFIG['projectId'])
        self.page.fill('#workspace-name','Renamed')
        self.page.click('#workspace-update')
        expect(self.page.locator('#workspace-list')).to_contain_text('Renamed')
        self.page.on('dialog',lambda d:d.accept())
        self.page.click('#workspace-delete')
        expect(self.page.locator('#workspace-list option')).to_have_count(1)

    def test_open_clears_session_and_credentials_without_network(self):
        self.save()
        self.page.click('#demo')
        self.page.click('.nav[data-tab="overview"]')
        self.page.evaluate("() => { document.getElementById('password').value='SECRET'; document.getElementById('jwt-a').value='TOKEN_SECRET';document.getElementById('audit-writes').checked=true; }")
        calls=[]
        self.page.route(re.compile(r'^https://'),lambda r:(calls.append(r.request.url),r.abort()))
        self.page.click('#workspace-open')
        expect(self.page.locator('#project-name')).to_have_text('No project connected')
        self.assertEqual(self.page.locator('#password').input_value(),'')
        self.assertEqual(self.page.locator('#jwt-a').input_value(),'')
        self.assertFalse(self.page.locator('#audit-writes').is_checked())
        self.assertEqual(calls,[])
        self.assertNotIn('SECRET',self.page.evaluate('JSON.stringify(localStorage)'))

    def test_import_export_settings_and_sanitization(self):
        self.page.click('.nav[data-tab="overview"]')
        item={'schema':'firelab.workspaces/v1','workspace':{'name':'<b>Staging</b>','config':{**CONFIG,'password':'SECRET'},'token':'SECRET','collectionPaths':['posts'],'scanPaths':['posts/welcome'],'settings':{'audit-profile':'aggressive'},'documents':[{'secret':'SECRET'}]}}
        self.page.set_input_files('#workspace-file',{'name':'project.json','mimeType':'application/json','buffer':json.dumps(item).encode()})
        expect(self.page.locator('#notice')).to_contain_text('Workspace imported')
        self.assertNotIn('SECRET',self.page.evaluate('JSON.stringify(localStorage)'))
        self.page.click('#workspace-open')
        self.assertEqual(self.page.locator('#audit-profile').input_value(),'aggressive')
        self.assertEqual(self.page.locator('#audit-paths').input_value(),'posts/welcome')
        with self.page.expect_download() as event:self.page.click('#workspace-export')
        exported=json.loads(Path(event.value.path()).read_text())
        self.assertEqual(exported['workspace']['collectionPaths'],['posts'])
        self.assertNotIn('SECRET',json.dumps(exported))

    def test_invalid_import_preserves_existing(self):
        self.save()
        for raw in ['null','{}','not json']:
            self.page.set_input_files('#workspace-file',{'name':'bad.json','mimeType':'application/json','buffer':raw.encode()})
            expect(self.page.locator('#notice')).to_have_class('error')
            expect(self.page.locator('#workspace-list option')).to_have_count(2)

    def test_storage_failures_and_limits(self):
        result=self.page.evaluate('''async()=>{
          const {workspaceStore}=await import('./src/workspaces.js');
          const messages=[];const item={name:'Test',config:{apiKey:'fake',projectId:'demo-test'}};
          for(const storage of [()=>{throw Error('blocked')},()=>({getItem:()=>null,setItem:()=>{throw Error('quota')}}),()=>({getItem:()=> 'null'})]){
            try{workspaceStore(storage).save(item)}catch(e){messages.push(e.message)}
          } return messages;
        }''')
        self.assertEqual(len(result),3)
        self.assertIn('unavailable',result[0]);self.assertIn('full or blocked',result[1])

    def test_mobile_no_horizontal_overflow(self):
        self.page.set_viewport_size({'width':390,'height':844})
        self.page.evaluate("document.querySelector('.nav[data-tab=overview]').click()")
        self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))

if __name__=='__main__': unittest.main()
