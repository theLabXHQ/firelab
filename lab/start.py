import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import time
from urllib.request import urlopen
from server import Handler, ThreadingHTTPServer, ROOT, RUNTIME, seed


def main():
    binary=os.environ.get('FIRELAB_FIREBASE_BIN') or str(ROOT/'lab/node_modules/.bin/firebase')
    if not Path(binary).is_file():binary=shutil.which('firebase')
    if not binary or not shutil.which('java') or not shutil.which('node'):
        raise SystemExit('Install Node 22+, Java 21+, and run npm install in lab/ first.')
    for port in (4300,19099,18085,19000,19199,19440,19450,19150):
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            try:sock.bind(('127.0.0.1',port))
            except OSError:raise SystemExit(f'Port {port} is already in use. Stop the previous lab before starting a new one.')
    RUNTIME.mkdir(exist_ok=True,mode=0o700)
    with (RUNTIME/'emulators.log').open('w') as log:
        proc=subprocess.Popen([binary,'emulators:start','--config',str(ROOT/'lab/firebase.json'),'--project','demo-firelab-lab','--only','auth,firestore,database,storage'],cwd=RUNTIME,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            for _ in range(180):
                if proc.poll() is not None:raise RuntimeError('Emulators exited. Inspect lab/.runtime/emulators.log.')
                try:
                    with urlopen('http://127.0.0.1:19440/emulators',timeout=1) as response:
                        import json
                        services=json.load(response)
                    if all(name in services for name in ('auth','firestore','database','storage')):break
                except OSError:pass
                time.sleep(1)
            else:raise RuntimeError('Emulator startup timed out. Inspect lab/.runtime/emulators.log.')
            seed()
            print('Open http://localhost:4300/?lab=1 and click Load / renew lab tokens. Ctrl+C stops the lab.',flush=True)
            ThreadingHTTPServer(('127.0.0.1',4300),Handler).serve_forever()
        except KeyboardInterrupt:pass
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid,signal.SIGTERM)
                try:proc.wait(timeout=15)
                except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait()


if __name__=='__main__':main()
