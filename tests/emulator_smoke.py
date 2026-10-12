import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    for binary in ('node', 'npm', 'java'):
        if not shutil.which(binary):
            raise SystemExit(f'{binary} is required on PATH for emulator validation.')
    source = (Path(__file__).resolve().parents[1] / 'src/security.js').as_uri()
    with tempfile.TemporaryDirectory(prefix='firelab-emulator-') as folder:
        root = Path(folder)
        port = int(os.environ.get('FIRELAB_EMULATOR_PORT', '8080'))
        if not 1024 <= port <= 65535: raise ValueError('Invalid emulator port')
        for mode in ('deny', 'owner-read'):
            generated = subprocess.check_output([
                'node', '--input-type=module', '-e',
                'const {ruleTemplates}=await import(process.argv[1]); console.log(JSON.stringify(ruleTemplates(process.argv[2])));',
                source, mode
            ], text=True)
            for name, content in json.loads(generated).items():
                if name == 'firebase.json':
                    config = json.loads(content); config['emulators']['firestore']['port'] = port; content = json.dumps(config)
                elif name == 'firelab.rules.test.mjs':
                    content = content.replace('port: 8080', f'port: {port}')
                (root / name).write_text(content, encoding='utf-8')
            if mode == 'deny':
                subprocess.run(['npm', 'install', '--no-audit', '--no-fund'], cwd=root, check=True)
            print(f'Validating {mode} baseline in the local demo emulator', flush=True)
            subprocess.run(['npm', 'test'], cwd=root, check=True)
    print('PASS: both baseline bundles and 36 emulator assertions; no live project used.')


if __name__ == '__main__':
    main()
