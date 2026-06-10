import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
data_file = root / 'data.json'

def update_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    changed = False

    def recurse(obj):
        nonlocal changed
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k in ('employeeName', 'name') and v == 'Akash':
                    obj[k] = 'Akash Rana'
                    changed = True
                else:
                    recurse(v)
        elif isinstance(obj, list):
            for item in obj:
                recurse(item)

    recurse(data)

    if changed:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f'Updated {path}')
    else:
        print(f'No changes in {path}')

if __name__ == '__main__':
    update_file(data_file)
