with open('public/index.html', 'r', encoding='utf-8', errors='ignore') as f:
    lines = f.readlines()
for idx, line in enumerate(lines):
    if 'id="tab-' in line or 'class="nav' in line or 'href="#' in line:
        if len(line.strip()) < 150:
            print(f"{idx+1}: {line.strip()}")
