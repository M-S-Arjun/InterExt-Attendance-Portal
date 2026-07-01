with open('server.js', 'r', encoding='utf-8', errors='ignore') as f:
    lines = f.readlines()
for idx, line in enumerate(lines):
    if 'app.get(\'/' in line or 'res.sendFile' in line:
        if len(line.strip()) < 150:
            print(f"{idx+1}: {line.strip()}")
