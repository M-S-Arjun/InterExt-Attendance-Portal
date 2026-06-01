from PIL import Image
import sys

img_path = r"C:\Users\arjun\.gemini\antigravity\brain\b18e81c6-a1fd-4b12-ad66-62d01d4fe27f\media__1780290789623.png"
img = Image.open(img_path)
img_rgb = img.convert('RGB')
width, height = img.size

print(f"Image size: {width}x{height}")
print("Rendering the first 150 rows in ASCII:")

for y in range(min(150, height)):
    row_chars = []
    for x in range(width):
        r, g, b = img_rgb.getpixel((x, y))
        # Calculate brightness
        brightness = (r + g + b) / 3
        if brightness < 120:
            # Check if it has color (e.g. red or blue)
            if r > g + 40 and r > b + 40:
                row_chars.append("R")  # Red pixel
            elif b > r + 40 and b > g + 40:
                row_chars.append("B")  # Blue pixel
            else:
                row_chars.append("#")  # Black/dark pixel
        else:
            if r > 230 and g < 220 and b < 220:
                row_chars.append(".")  # Light pink background pixel
            else:
                row_chars.append(" ")  # White background pixel
    print("".join(row_chars))
