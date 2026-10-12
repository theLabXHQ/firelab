import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent


def public_file(raw):
    path = unquote(urlsplit(raw).path)
    if path in ('/', '/index.html', '/icon.svg'):
        return True
    parts = path.split('/')
    return len(parts) == 3 and parts[1] == 'src' and not parts[2].startswith('.') and '\\' not in path and Path(parts[2]).suffix in ('.js', '.css')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def allowed(self):
        if not public_file(self.path):
            return False
        target = Path(self.translate_path(self.path))
        return not target.is_symlink() and target.resolve().is_relative_to(ROOT.resolve())

    def do_GET(self):
        if not self.allowed():
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.allowed():
            self.send_error(404)
            return
        super().do_HEAD()

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'")
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Serve only Firelab browser assets.')
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=4173)
    args = parser.parse_args()
    print(f'Firelab: http://{args.bind}:{args.port}', flush=True)
    ThreadingHTTPServer((args.bind, args.port), Handler).serve_forever()
