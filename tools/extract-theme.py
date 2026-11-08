#!/usr/bin/env python3
"""Extract the host's theme custom properties so a preview page can be faithful."""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
from asar import Asar

a = Asar(r'C:\Users\nkb\AppData\Local\Programs\DeepSeek Harness\resources\app.asar')
text = a.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js').decode('utf-8', 'replace')

def block_at(marker):
    """Return the balanced {...} block that starts at the marker."""
    i = text.find(marker)
    if i < 0:
        return None
    start = text.find('{', i)
    depth = 0
    for j in range(start, len(text)):
        if text[j] == '{':
            depth += 1
        elif text[j] == '}':
            depth -= 1
            if depth == 0:
                return text[start:j + 1]
    return None

static = block_at('body{--dsw-static-amber-100')
light = block_at('body{--dsw-alias-')
dark = block_at('body[data-ds-dark-theme]{')
if not static or not light or not dark:
    print('FAILED to locate the theme blocks')
    sys.exit(1)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'theme.css')
out = os.path.abspath(out)
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'w', encoding='utf-8') as f:
    f.write('body' + static + '\n')
    f.write('body' + light + '\n')
    f.write('body[data-ds-dark-theme]' + dark + '\n')
print('wrote', out)
print('static vars:', static.count('--dsw-static-'))
print('light vars:', light.count('--dsw-alias-'))
print('dark vars:', dark.count('--dsw-alias-'))
for name in ('--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
             '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
             '--dsw-alias-label-primary', '--dsw-alias-label-dimmed', '--dsw-alias-label-secondary',
             '--dsw-alias-bg-layer-2', '--dsw-alias-border-l1', '--dsw-alias-bg-base'):
    m = re.search(re.escape(name) + r':([^;}]*)', light)
    print(' light', name, '=>', m.group(1).strip() if m else 'MISSING')
