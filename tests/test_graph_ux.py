import re
import unittest
from playwright.sync_api import expect
import test_tokens


class GraphUXTests(unittest.TestCase):
    setUpClass = classmethod(test_tokens.TokenTests.setUpClass.__func__)
    tearDownClass = classmethod(test_tokens.TokenTests.tearDownClass.__func__)
    setUp = test_tokens.TokenTests.setUp
    tearDown = test_tokens.TokenTests.tearDown

    def demo(self):
        self.network=[]
        self.page.route(re.compile(r'^https://'),lambda r:(self.network.append(r.request.url),r.abort()))
        self.page.click('.nav[data-tab="overview"]');self.page.click('#demo')

    def test_search_keeps_ancestors_and_enter_centers_result(self):
        self.demo();self.page.fill('#graph-search','welcome')
        self.assertEqual(self.page.locator('.graph-node').count(),3)
        expect(self.page.locator('[data-node-id="c:posts"]')).to_have_attribute('data-context','true')
        self.page.press('#graph-search','Enter')
        expect(self.page.locator('#inspector-content h2')).to_have_text('welcome')
        expect(self.page.locator('#graph-zoom')).to_have_text('100%')
        self.page.fill('#graph-search','no-such-node')
        expect(self.page.locator('#graph-empty-results')).to_be_visible()
        self.page.click('#graph-show-all')
        self.assertGreater(self.page.locator('.graph-node').count(),3)
        self.assertEqual(self.network,[])

    def test_collapse_focus_and_breadcrumbs(self):
        self.demo();self.page.select_option('#graph-jump','c:posts')
        self.page.locator('#inspector-content button',has_text='Collapse children').click()
        self.assertEqual(self.page.locator('[data-node-id="d:posts/welcome"]').count(),0)
        self.page.fill('#graph-search','welcome')
        self.assertEqual(self.page.locator('[data-node-id="d:posts/welcome"]').count(),1)
        self.page.click('#graph-show-all');self.page.select_option('#graph-jump','c:posts')
        self.page.locator('#inspector-content button',has_text='Focus branch').click()
        self.assertEqual(self.page.locator('[data-node-id="c:settings"]').count(),0)
        expect(self.page.locator('#graph-filter-status')).to_contain_text('focused branch')
        self.page.select_option('#graph-jump','d:posts/welcome')
        self.page.locator('.graph-breadcrumbs button',has_text='posts').click()
        expect(self.page.locator('#inspector-content h2')).to_have_text('posts')
        self.page.click('#graph-show-all')
        self.assertEqual(self.page.locator('[data-node-id="c:settings"]').count(),1)
        self.assertEqual(self.network,[])

    def test_type_status_and_field_name_filters_in_list(self):
        self.demo();self.page.click('#graph-view-list')
        self.page.select_option('#graph-kind','document')
        self.page.select_option('#graph-status-filter','readable')
        self.page.fill('#graph-search','published')
        expect(self.page.locator('#graph-filter-status')).to_contain_text('2 matches')
        self.assertEqual(self.page.locator('.graph-list-row[data-context="false"]').count(),2)
        self.page.locator('[data-list-node-id="d:posts/welcome"]').click()
        self.page.get_by_role('searchbox',name='Find document field').fill('title')
        self.assertEqual(self.page.locator('.field-row:visible').count(),1)
        expect(self.page.locator('.field-row:visible')).to_contain_text('Welcome to Firelab')
        self.assertEqual(self.network,[])

    def test_copy_is_explicit_and_matches_selected_sample(self):
        self.demo();self.page.select_option('#graph-jump','d:posts/welcome')
        self.page.evaluate("Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copied=text},configurable:true})")
        self.page.locator('#inspector-content button',has_text='Copy path').click()
        self.assertEqual(self.page.evaluate('window.copied'),'posts/welcome')
        self.page.locator('#inspector-content button',has_text='Copy JSON').click()
        self.assertEqual(self.page.evaluate('JSON.parse(window.copied).title'),'Welcome to Firelab')

    def test_identity_change_clears_search_and_private_field_values(self):
        self.demo();self.page.fill('#graph-search','welcome');self.page.press('#graph-search','Enter')
        self.page.click('.nav[data-tab="auth"]');self.page.fill('#email','demo@example.com');self.page.fill('#password','test-password');self.page.click('#auth-form button.primary')
        self.page.click('.nav[data-tab="graph"]')
        expect(self.page.locator('#graph-search')).to_have_value('')
        expect(self.page.locator('#inspector-content')).not_to_contain_text('Welcome to Firelab')

    def test_mobile_search_no_overflow(self):
        self.page.set_viewport_size({'width':390,'height':844});self.demo()
        expect(self.page.locator('#graph-list-view')).to_be_visible()
        self.page.fill('#graph-search','welcome')
        self.page.locator('[data-list-node-id="d:posts/welcome"]').click()
        self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth>innerWidth'))
        expect(self.page.locator('#inspector-content')).to_contain_text('Welcome to Firelab')

    def test_large_audit_starts_collapsed_and_search_reveals_sample(self):
        self.demo()
        self.page.evaluate('''async()=>{
          const {createGraph}=await import('./src/graph.js?v=1.14.1');
          const graph=createGraph({onRead:()=>{throw Error('Unexpected read')},onOpen:()=>{},onExport:()=>{},notify:()=>{}});
          graph.setSession({config:{projectId:'synthetic-graph'},demo:true});
          graph.auditSamples('synthetic-graph',{sources:[{label:'No token · rest',documents:Array.from({length:120},(_,i)=>({path:'records/item'+i,data:{title:'Synthetic '+i}}))}]});
        }''')
        self.assertEqual(self.page.locator('.graph-node').count(),2)
        self.page.fill('#graph-search','records/item119')
        self.assertEqual(self.page.locator('.graph-node').count(),3)
        self.page.press('#graph-search','Enter')
        expect(self.page.locator('#inspector-content')).to_contain_text('Synthetic 119')
        expect(self.page.locator('.subcollection-form button')).to_be_disabled()
        self.assertEqual(self.network,[])


if __name__=='__main__':unittest.main()
