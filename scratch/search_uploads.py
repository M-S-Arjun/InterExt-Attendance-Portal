with open('server.js', 'r', encoding='utf-8', errors='ignore') as f:
    lines = f.readlines()
for idx, line in enumerate(lines):
    if 'upload' in line.lower() or 'multer' in line.lower() or 'body-parser' in line.lower() or 'payload' in line.lower():
        if len(line.strip()) < 150:
            print(f"{idx+1}: {line.strip()}")
