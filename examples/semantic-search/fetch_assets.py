import hashlib
import json
from pathlib import Path
import sys
from urllib.request import urlopen

root = Path(__file__).resolve().parent
lock = json.loads((root / 'model-lock.json').read_text())
files = lock['model']['files']
if '--model-only' not in sys.argv:
    files += lock['wheels']
    files += lock['nativeLibraries']
for item in files:
    target = root / item['path']
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == item['sha256']:
        continue
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + '.part')
    digest = hashlib.sha256()
    size = 0
    try:
        with urlopen(item['url'], timeout=60) as response, temporary.open('wb') as output:
            while chunk := response.read(65536):
                size += len(chunk)
                if size > item['size']:
                    raise ValueError('asset_size_mismatch')
                digest.update(chunk)
                output.write(chunk)
        if size != item['size'] or digest.hexdigest() != item['sha256']:
            raise ValueError('asset_integrity_mismatch')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
print(json.dumps({'verified': len(files)}))
