# Quick Start Guide - Face Recognition Camera Attendance

## What You're Getting

Your WhatsApp Attendance Tracking system now includes **automatic face recognition** for camera attendance. This means:

✓ Upload a photo → System recognizes the employee automatically  
✓ No need to manually select employee names  
✓ Faster, more accurate attendance recording  
✓ Works with your existing attendance system  

## 5-Minute Setup

### Step 1: Install Dependencies (2 min)

```bash
pip install -r requirements.txt
```

Wait for installation to complete. You'll see a lot of text - this is normal.

### Step 2: Prepare Employee Photos (2 min)

Create this folder structure with employee photos:

```
training_data/
├── EMP001/
│   ├── photo1.jpg
│   └── photo2.jpg
├── EMP002/
│   └── employee.jpg
```

**Quick tips:**
- Folder names must match your employee IDs in the system
- 2-5 photos per employee is good
- Clear face photos, decent lighting

### Step 3: Start Everything

**Windows:**
```bash
START_ALL.bat
```

**Mac/Linux:**
```bash
bash start_all.sh
```

You'll see two windows open:
1. Face Recognition API (Python)
2. WebUI + Server (Node.js)

### Step 4: Train the Model (1 min)

1. Open http://localhost:3000
2. Go to "Camera Attendance" tab
3. Click "🧪 Train Model"
4. Enter path to training_data folder
5. Wait for completion message

Done! ✓

## Using Face Recognition

### Auto-Recognize Employee

1. Go to "Camera Attendance" tab
2. Click "Choose File" and select employee photo
3. Click "🔍 Recognize Face"
4. System auto-fills employee name
5. Click "Record Camera Event"

### Manual Entry (Still Works)

- Select employee from dropdown manually if needed
- System works both ways

### Check Model Status

Click "ℹ️ Model Status" to see:
- How many employees are trained
- System is ready to use

## Troubleshooting

**"Face recognition service unavailable"**
- Make sure both windows are open
- Face Recognition API window must be running
- Check http://localhost:5000 (should show green status)

**"No matching employee found"**
- Check employee ID in training_data folder matches database
- Add more photos of that employee
- Ensure face is clearly visible in photos

**Slow startup (first time)**
- Normal - downloading face model (~500MB)
- Only happens once
- Don't close the window

## Next: Live Camera Integration

Want to use a real camera? In future updates:
- Live camera feed detection
- Real-time face recognition
- Automatic attendance without clicking

## Performance

| Action | Time |
|--------|------|
| Recognize face | <1 second |
| Train 20 employees | ~10 seconds |
| Load trained model | ~5 seconds |

## Files Created

| File | Purpose |
|------|---------|
| `face_recognition_service.py` | Core face detection & matching |
| `face_recognition_api.py` | REST API for Node.js integration |
| `requirements.txt` | Python dependencies |
| `START_ALL.bat` | Windows startup script |
| `start_all.sh` | Mac/Linux startup script |
| `FACE_RECOGNITION_SETUP.md` | Full technical documentation |

## Support

See `FACE_RECOGNITION_SETUP.md` for:
- Advanced configuration
- API endpoints documentation
- Troubleshooting guide
- Performance tuning
- Security best practices

## What's Happening Behind the Scenes

1. **Photo uploaded** → Sent to Python service
2. **Face detected** → Face recognized as 512D embedding
3. **Matched to database** → Compared with trained employees
4. **Employee found** → Auto-filled in form with confidence score
5. **Attendance recorded** → Saved to system with face recognition flag

## Architecture

```
Your Browser
    ↓
Node.js Server (localhost:3000)
    ↓
Python Face Recognition API (localhost:5000)
    ↓
InsightFace Model (buffalo_l - highest accuracy)
    ↓
Results → Auto-populate form → Attendance saved
```

## Next Step

Ready? Run this:

**Windows:**
```bash
START_ALL.bat
```

**Mac/Linux:**
```bash
bash start_all.sh
```

Then open http://localhost:3000 and try the Camera Attendance tab!

---

Questions? Check `FACE_RECOGNITION_SETUP.md` for full documentation.
