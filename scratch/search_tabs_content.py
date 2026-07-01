with open('public/index.html', 'r', encoding='utf-8', errors='ignore') as f:
    lines = f.readlines()
for idx, line in enumerate(lines):
    if 'tab-punches' in line or 'tab-logs' in line or 'tab-settings' in line:
        if len(line.strip()) < 150:
            print(f"{idx+1}: {line.strip()}")
