import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from server import seed

ROOT=Path(__file__).resolve().parents[1]


def main():
    seed()
    with sync_playwright() as p:
        browser=p.chromium.launch()
        page=browser.new_page(viewport={'width':1440,'height':1000})
        page.set_default_timeout(30000)
        errors=[];blocked=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        def external(route):
            if route.request.url.startswith('https://www.gstatic.com/firebasejs/'):route.continue_()
            else:blocked.append(route.request.url.split('?')[0]);route.abort()
        page.route(re.compile(r'^https://'),external)
        page.goto('http://127.0.0.1:4300/?lab=1')
        page.click('#lab-load');expect(page.locator('#lab-status')).to_contain_text('Fresh emulator tokens')
        page.click('#autopwn-quick')
        page.check('#audit-writes');page.check('#audit-updates')
        page.locator('#audit-advanced summary').click()
        page.fill('#audit-write-limit','100')
        page.click('#audit-run')
        expect(page.locator('#audit-write-review')).to_be_visible(timeout=60000)
        page.click('#audit-write-review button[value="confirm"]')
        expect(page.locator('#audit-export')).to_be_enabled(timeout=90000)
        with page.expect_download() as event:page.click('#audit-export')
        report=json.loads(Path(event.value.path()).read_text())
        assert report['environment']=='local-emulator'
        assert report['status']=='complete'
        def read(path,label):return next(x['outcome'] for x in report['requests'] if x['path']==path and x['identity']==label)
        def mutation(path,label):return next(x for x in report['mutations'] if x['collection']==path and x['identity']==label)
        assert read('public','No token')=='readable'
        assert read('signed_in','No token')=='denied'
        assert read('signed_in','Token A')=='readable'
        assert read('locked','Token A')=='denied'
        for path in ['open_write','blind_write']:
            m=mutation(path,'No token');assert [m[k] for k in ['create','update','delete']]==['allowed']*3,m
        for path in ['update_only','delete_only','validated']:
            m=mutation(path,'Token A');assert m['create']=='denied' and m['update']==m['delete']=='not tested',m
        assert not any(m['cleanupRequired'] for m in report['mutations'])
        page.click('#audit-open-graph');expect(page.locator('#graph-nodes')).to_contain_text('public')
        page.screenshot(path=str(ROOT/'lab'/'.runtime'/'preview-local-lab.png'),full_page=True)
        page.click('.nav[data-tab="auth"]');page.fill('#email','alice@firelab.test');page.fill('#password','Firelab-lab-only-2026!');page.click('#auth-form button.primary')
        expect(page.locator('#identity')).to_have_text('alice@firelab.test')
        result=page.evaluate('''async()=>{
            const f=await import('./src/firebase.js?v=1.14.1');
            const lab=await (await fetch('/__lab/session')).json();
            const checks=[];const s=await f.connect(lab.config,()=>{});
            async function check(name,fn,allowed=true){try{await fn();checks.push({name,allowed:true,expected:allowed})}catch(e){if(!String(e.code).includes('permission-denied')&&!String(e.code).includes('unauthorized')&&!String(e.code).includes('PERMISSION_DENIED'))throw e;checks.push({name,allowed:false,expected:allowed})}}
            try{
                await f.authenticate(s,{method:'password',action:'signin',email:'alice@firelab.test',password:lab.password});
                const alice=lab.users.alice.uid,bob=lab.users.bob.uid;
                await check('owner document',()=>f.firestore(s,{operation:'get',path:`users/${alice}`}));
                await check('other user document',()=>f.firestore(s,{operation:'get',path:`users/${bob}`}),false);
                await check('existing update with create denied',()=>f.firestore(s,{operation:'update',path:'update_only/example',data:{title:'Updated local fixture'}}));
                await check('existing delete with create denied',()=>f.firestore(s,{operation:'delete',path:'delete_only/example'}));
                await check('valid app schema',()=>f.firestore(s,{operation:'set',path:'validated/from-app',data:{title:'Valid schema',owner:alice}}));
                await check('valid schema cleanup',()=>f.firestore(s,{operation:'delete',path:'validated/from-app'}));
                await check('RTDB public',()=>f.realtime(s,{operation:'get',path:'public'}));
                await check('RTDB owner',()=>f.realtime(s,{operation:'get',path:`users/${alice}`}));
                await check('RTDB other user',()=>f.realtime(s,{operation:'get',path:`users/${bob}`}),false);
                await check('RTDB write',()=>f.realtime(s,{operation:'set',path:'open_write/smoke',data:{ok:true}}));
                await check('RTDB delete',()=>f.realtime(s,{operation:'delete',path:'open_write/smoke'}));
                await check('Storage public',()=>f.storage(s,{operation:'list',path:'public'}));
                await check('Storage owner',()=>f.storage(s,{operation:'metadata',path:`users/${alice}/private.txt`}));
                await check('Storage denied',()=>f.storage(s,{operation:'list',path:'locked'}),false);
                await check('Storage upload',()=>f.storage(s,{operation:'upload',path:'open_write/smoke.txt',file:new Blob(['lab'])}));
                await check('Storage delete',()=>f.storage(s,{operation:'delete',path:'open_write/smoke.txt'}));
                await check('non-admin read',()=>f.firestore(s,{operation:'get',path:'admin_only/example'}),false);
                await f.authenticate(s,{method:'password',action:'signin',email:'admin@firelab.test',password:lab.password});
                await check('admin claim read',()=>f.firestore(s,{operation:'get',path:'admin_only/example'}));
                const {readWithToken,verifyToken,exchangeRefreshToken}=await import('./src/tokens.js?v=1.14.1');
                const adminRead=await readWithToken({project:lab.config.projectId,path:'admin_only',kind:'collection',token:lab.users.admin.idToken,label:'Admin'});
                checks.push({name:'admin token REST read',allowed:adminRead.evidence.outcome==='readable',expected:true});
                let rejected=false;try{await verifyToken(lab.users.alice.idToken,lab.config.projectId)}catch{rejected=true}
                checks.push({name:'unsigned token rejected by production verifier',allowed:rejected,expected:true});
                const refreshed=await exchangeRefreshToken(lab.config.apiKey,lab.users.alice.refreshToken);
                checks.push({name:'refresh exchange',allowed:Boolean(refreshed.idToken),expected:true});
                let blocked=false;try{await f.connect({apiKey:'x',projectId:'another-project'},()=>{})}catch{blocked=true}
                checks.push({name:'other project rejected in lab',allowed:blocked,expected:true});
                return checks;
            }finally{await f.disconnect(s)}
        }''')
        assert all(x['allowed']==x['expected'] for x in result),result
        assert not errors,errors
        assert not blocked,blocked
        output={'environment':'local-emulator','autopwn':report,'serviceChecks':result,'unexpectedCloudRequests':len(blocked),'limitations':['Unsigned tokens do not demonstrate production signature verification.','Canary create denial leaves existing-document update/delete unknown.','Functions, IAM, App Check and production transport are outside this lab.']}
        (ROOT/'lab/.runtime/report.json').write_text(json.dumps(output,indent=2))
        print(f"PASS: {len(report['requests'])} AutoPwn reads, {len(report['mutations'])} canary sequences, {len(result)} service/token checks; graph and SDK UI login; no cloud service requests.")
        browser.close()
        seed()


if __name__=='__main__':main()
