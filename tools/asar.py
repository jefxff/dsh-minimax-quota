#!/usr/bin/env python3
"""Minimal read-only extractor for Electron .asar archives."""
import json, os, struct, sys

class Asar:
    def __init__(self, path):
        self.path = path
        with open(path, 'rb') as f:
            head = f.read(16)
            (self.header_pickle_size,) = struct.unpack('<I', head[0:4])
            (self.header_size,) = struct.unpack('<I', head[4:8])
            (self.header_str_size,) = struct.unpack('<I', head[8:12])
            self.base = 16
            self.data_offset = 8 + self.header_size
            # Locate the JSON header empirically: it starts at the first
            # '{"files"' marker and ends at the matching closing brace.
            f.seek(0)
            probe = f.read(1 << 24)
            start = probe.find(b'{"files"')
            if start == -1:
                raise RuntimeError('asar header not found')
            depth = 0
            end = -1
            in_str = False
            esc = False
            for i in range(start, len(probe)):
                ch = probe[i:i + 1]
                if in_str:
                    if esc:
                        esc = False
                    elif ch == b'\\':
                        esc = True
                    elif ch == b'"':
                        in_str = False
                    continue
                if ch == b'"':
                    in_str = True
                elif ch == b'{':
                    depth += 1
                elif ch == b'}':
                    depth -= 1
                    if depth == 0:
                        end = i + 1
                        break
            raw = probe[start:end]
        self.tree = json.loads(raw.decode('utf-8'))

    def _walk(self, node, prefix):
        if 'files' in node:
            for name, child in node['files'].items():
                yield from self._walk(child, prefix + '/' + name if prefix else name)
        else:
            yield prefix, node

    def entries(self):
        return list(self._walk(self.tree, ''))

    def read(self, rel):
        parts = rel.split('/')
        node = self.tree
        for p in parts:
            if 'files' not in node or p not in node['files']:
                raise KeyError(rel)
            node = node['files'][p]
        if 'link' in node:
            return self.read(node['link'])
        with open(self.path, 'rb') as f:
            f.seek(self.data_offset + int(node['offset']))
            return f.read(int(node['size']))

    def extract(self, rel, dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, 'wb') as f:
            f.write(self.read(rel))

if __name__ == '__main__':
    cmd = sys.argv[1]
    a = Asar(sys.argv[2])
    if cmd == 'ls':
        pat = sys.argv[3] if len(sys.argv) > 3 else ''
        for rel, node in a.entries():
            if pat in rel:
                print(f"{node.get('size','-'):>10}  {rel}")
    elif cmd == 'cat':
        sys.stdout.buffer.write(a.read(sys.argv[3]))
    elif cmd == 'x':
        a.extract(sys.argv[3], sys.argv[4])
        print('extracted', sys.argv[3], '->', sys.argv[4])
    elif cmd == 'extractall':
        out = sys.argv[3]
        n = 0
        for rel, node in a.entries():
            if 'link' in node or 'offset' not in node:
                continue
            a.extract(rel, os.path.join(out, rel))
            n += 1
        print('extracted', n, 'files to', out)
