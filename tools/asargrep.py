#!/usr/bin/env python3
"""Grep inside an Electron .asar archive."""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
from asar import Asar

def main():
    pattern = sys.argv[1].encode('utf-8')
    archive = sys.argv[2]
    path_filter = sys.argv[3] if len(sys.argv) > 3 else ''
    ctx = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    a = Asar(archive)
    hits = 0
    for rel, node in a.entries():
        if 'offset' not in node or 'link' in node:
            continue
        if path_filter and path_filter not in rel:
            continue
        size = int(node['size'])
        if size > 8 * 1024 * 1024:
            continue
        data = a.read(rel)
        for m in re.finditer(re.escape(pattern), data):
            hits += 1
            s = max(0, m.start() - ctx)
            e = min(len(data), m.end() + ctx)
            snippet = data[s:e].decode('utf-8', 'replace').replace('\n', '\\n')
            print(f'--- {rel} @{m.start()}\n{snippet}')
            if hits > 200:
                print('... truncated')
                return
    if not hits:
        print('NO MATCH')

if __name__ == '__main__':
    main()
