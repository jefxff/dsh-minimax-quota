#!/usr/bin/env python3
"""Search the DSH asar for a notification/toast service seam."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
from asar import Asar

PATS = [b'Service(`notification', b'Service(`notify', b'Service(`toast',
        b'provide(`notification', b'provide(`notify', b'notification-service',
        b'ctx.notify(', b'ctx.notification']

a = Asar(sys.argv[1])
found = 0
for rel, node in a.entries():
    if 'offset' not in node or 'link' in node:
        continue
    if not rel.endswith('.js') or '/@deepseek-ai/' not in rel:
        continue
    if int(node['size']) > 6 * 1024 * 1024:
        continue
    data = a.read(rel)
    for p in PATS:
        i = data.find(p)
        if i >= 0:
            print('===', rel, p.decode(), i)
            print(data[max(0, i - 300):i + 500].decode('utf-8', 'replace'))
            print()
            found += 1
            break
    if found > 8:
        break
print('done, hits:', found)
