with open('database.js', 'r', encoding='utf-8', errors='ignore') as f:
    lines = f.readlines()
for idx, line in enumerate(lines):
    if 'absent' in line.lower():
        print(f"{idx+1}: {line.strip()}")
