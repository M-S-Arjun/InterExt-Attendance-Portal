import re
import os

html_path = os.path.join("public", "index.html")
if os.path.exists(html_path):
    content = open(html_path, encoding="utf-8").read()
    icons = set(re.findall(r'data-lucide="([^"]+)"', content))
    print("Lucide icons:", sorted(list(icons)))
else:
    print("index.html not found")
