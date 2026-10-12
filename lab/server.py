import argparse
import json
import os
import sys
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse, unquote
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from serve import Handler as StaticHandler
PROJECT = 'demo-firelab-lab'
PASSWORD = 'Firelab-lab-only-2026!'
AUTH = 'http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1'
FIRESTORE = f'http://127.0.0.1:18085/v1/projects/{PROJECT}/databases/(default)/documents'
RUNTIME = ROOT / 'lab' / '.runtime'
CONFIG = {'apiKey':'firelab-local-key','projectId':PROJECT,'authDomain':f'{PROJECT}.firebaseapp.com','storageBucket':f'{PROJECT}.appspot.com','databaseURL':f'https://{PROJECT}-default-rtdb.firebaseio.com'}


def request(url, body=None, method=None, owner=False, raw=False):
    headers={'Content-Type':'application/json'}
    if owner: headers['Authorization']='Bearer owner'
    data=body if isinstance(body,bytes) else json.dumps(body).encode() if body is not None else None
    if raw: headers['Content-Type']='text/plain'
    with urlopen(Request(url,data=data,headers=headers,method=method),timeout=15) as response:
        data=response.read()
        return json.loads(data) if data else {}


def login(name):
    return request(f'{AUTH}/accounts:signInWithPassword?key=firelab-local-key',{'email':f'{name}@firelab.test','password':PASSWORD,'returnSecureToken':True})


def session():
    users={}
    for name in ('alice','bob','admin'):
        result=login(name)
        users[name]={'uid':result['localId'],'email':result['email'],'idToken':result['idToken'],'refreshToken':result['refreshToken'],'expiresIn':result['expiresIn']}
    alice=users['alice']['uid'];bob=users['bob']['uid']
    paths=['public','open_write','blind_write','signed_in',f'users/{alice}',f'users/{bob}',f'users/{alice}/notes',f'users/{bob}/notes','admin_only','update_only','delete_only','validated','locked']
    value={'environment':'local-emulator','config':CONFIG,'users':users,'password':PASSWORD,'paths':paths,'collectionPaths':[p for p in paths if len(p.split('/'))%2]}
    RUNTIME.mkdir(exist_ok=True,mode=0o700)
    target=RUNTIME/'session.json';target.write_text(json.dumps(value,indent=2));os.chmod(target,0o600)
    return value


def seed():
    users={}
    for name in ('alice','bob','admin'):
        try:result=request(f'{AUTH}/accounts:signUp?key=firelab-local-key',{'email':f'{name}@firelab.test','password':PASSWORD,'returnSecureToken':True})
        except HTTPError as error:
            body=json.loads(error.read())
            if body.get('error',{}).get('message')!='EMAIL_EXISTS':raise
            result=login(name)
        users[name]=result['localId']
    request(f'{AUTH}/projects/{PROJECT}/accounts:update',{'localId':users['admin'],'customAttributes':json.dumps({'admin':True})},owner=True)
    docs={
        'public/welcome':{'title':'Local Firebase lab','nextPath':'open_write/example'},
        'open_write/example':{'title':'Public create, update and delete','apiKey':'SYNTHETIC_NOT_A_SECRET','linkedPath':f"users/{users['alice']}/notes/first"},
        'blind_write/example':{'title':'Read denied, writes allowed'},
        'signed_in/example':{'title':'Any authenticated lab user'},
        'admin_only/example':{'title':'Admin claim required'},
        'update_only/example':{'title':'Create denied, existing update allowed'},
        'delete_only/example':{'title':'Create denied, existing delete allowed'},
        'validated/example':{'title':'Requires the application schema','owner':users['alice']},
        'locked/example':{'title':'Deny all control'}
    }
    for name,uid in users.items():
        docs[f'users/{uid}']={'name':name,'owner':uid}
        docs[f'users/{uid}/notes/first']={'title':f'{name} private note','owner':uid}
    writes=[{'update':{'name':f'projects/{PROJECT}/databases/(default)/documents/{path}','fields':{k:{'stringValue':v} for k,v in data.items()}}} for path,data in docs.items()]
    request(FIRESTORE+':commit',{'writes':writes},owner=True)
    request(f'http://127.0.0.1:19000/.json?ns={PROJECT}-default-rtdb',{'public':{'welcome':'Lab public data'},'open_write':{'example':True},'users':{uid:{'name':name} for name,uid in users.items()},'locked':{'example':True}},method='PUT',owner=True)
    for path in ['public/readme.txt','open_write/example.txt',f"users/{users['alice']}/private.txt",'locked/example.txt']:
        from urllib.parse import quote
        request(f'http://127.0.0.1:19199/v0/b/{PROJECT}.appspot.com/o?uploadType=media&name={quote(path,safe="")}',b'Firelab synthetic fixture',owner=True,raw=True)
    session()
    print(f'Seeded {len(docs)} documents and 3 lab users. Tokens saved locally under lab/.runtime/session.json; values not printed.',flush=True)


class Handler(StaticHandler):
    def do_GET(self):
        if self.headers.get('Host') not in ('localhost:4300','127.0.0.1:4300'):
            self.send_error(403);return
        if any(part.startswith('.') for part in unquote(urlparse(self.path).path).split('/') if part):
            self.send_error(404);return
        if urlparse(self.path).path=='/__lab/session':
            try:
                data=json.dumps(session()).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            except Exception:
                self.send_error(503,'Start the emulators and seed the local lab first')
            return
        super().do_GET()
    def do_HEAD(self):
        if self.headers.get('Host') not in ('localhost:4300','127.0.0.1:4300') or any(part.startswith('.') for part in unquote(urlparse(self.path).path).split('/') if part):
            self.send_error(404);return
        super().do_HEAD()
    def list_directory(self,path):self.send_error(404);return None
    def log_message(self,*args):pass


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--seed',action='store_true');args=parser.parse_args()
    if args.seed:seed()
    else:
        print('Firelab local lab: http://localhost:4300/?lab=1',flush=True)
        ThreadingHTTPServer(('127.0.0.1',4300),Handler).serve_forever()
