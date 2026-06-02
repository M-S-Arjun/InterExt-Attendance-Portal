"""
Setup script to create training data structure for face recognition
"""
import os
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Create training directories
base_dir = Path("e:/Whatsapp Attendance Tracking/training_data")
employees = {
    "emp_2050": "Maya Sunil",
    "emp_2046": "Sunil. C. M",
    "emp_2045": "Stephin Pious",
    "emp_2054": "Mahin KJ",
    "emp_2084": "Rahul Das"
}

print("Creating training data structure...")
print()

for emp_id, emp_name in employees.items():
    emp_dir = base_dir / emp_id
    emp_dir.mkdir(parents=True, exist_ok=True)
    
    # Create sample synthetic face images (placeholder)
    # In real scenario, you'd upload actual photos
    for i in range(1, 4):  # 3 images per employee
        img_path = emp_dir / f"sample_{i}.jpg"
        
        # Create a simple colored image with text (placeholder)
        # Real implementation would use actual face photos
        img = Image.new('RGB', (200, 200), color=(73, 109, 137))
        draw = ImageDraw.Draw(img)
        
        # Draw some rectangles to simulate faces (basic placeholder)
        draw.ellipse([50, 40, 150, 140], fill=(200, 150, 100), outline=(0, 0, 0), width=2)
        draw.text((20, 160), f"{emp_id}\n{emp_name[:15]}", fill=(255, 255, 255))
        
        img.save(str(img_path))
        print(f"  ✓ Created {img_path.name} in {emp_id}/")

print()
print("✓✓✓ Training data structure created successfully!")
print()
print("NOTE: These are PLACEHOLDER images for directory structure testing.")
print("For real face recognition, replace these with actual employee photos:")
print()
for emp_id in employees.keys():
    print(f"  - training_data/{emp_id}/photo1.jpg")
    print(f"  - training_data/{emp_id}/photo2.jpg")
    print(f"  - training_data/{emp_id}/photo3.jpg")
print()
print("Ready to train model! Use the UI button: 🧪 Train Model")
