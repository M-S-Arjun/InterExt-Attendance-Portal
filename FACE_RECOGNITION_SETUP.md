# Face Recognition Integration Guide

This document explains how to set up and use the InsightFace-based face recognition system for camera attendance tracking.

## Overview

The system uses **InsightFace** (buffalo_l model) to:
- Automatically detect faces in uploaded employee photos
- Extract high-dimensional face embeddings (512D vectors)
- Match faces against a trained employee database
- Auto-populate attendance forms when employees are recognized

## Architecture

```
┌─────────────────┐
│   Node.js       │
│   (Express)     │◄─────────HTTP requests─────────┐
└────────┬────────┘                                 │
         │                                          │
    ┌────▼─────────────────────┐                   │
    │  REST API Endpoints      │                   │
    │  (Face Recognition)      │                   │
    └────┬─────────────────────┘                   │
         │                                          │
         ├──► /api/face/recognize                  │
         ├──► /api/face/train                      │
         ├──► /api/face/embeddings-info            │
         └──► /api/face/health                     │
                      │
                      │ (HTTP calls)
                      │
         ┌────────────▼─────────────┐
         │  Flask API Server        │
         │  (face_recognition_api)  │◄───────────
         └────────────┬─────────────┘
                      │
         ┌────────────▼──────────────────────┐
         │  Python Face Recognition Service  │
         │  (face_recognition_service.py)    │
         │                                    │
         │  - FaceRecognitionModel class    │
         │  - InsightFace (buffalo_l)       │
         │  - Embedding extraction          │
         │  - Employee database matching    │
         └─────────────────────────────────┘
```

## Installation

### 1. Install Python Dependencies

```bash
pip install -r requirements.txt
```

Required packages:
- `insightface==0.7.3` - Face recognition framework
- `onnxruntime>=1.17.0` - Model inference engine
- `opencv-python>=4.8.0` - Image processing
- `numpy>=1.24.0` - Numerical operations
- `flask>=3.0.0` - REST API server
- `pillow>=10.0.0` - Image handling

### 2. Start the Face Recognition Service

In a separate terminal/process, start the Flask API server:

```bash
python face_recognition_api.py
```

Output:
```
[2024-01-15 10:30:45] [INFO] [Flask] Initializing Face Recognition Service...
[2024-01-15 10:30:50] [INFO] [Flask] Model loaded successfully
[2024-01-15 10:30:50] [INFO] [Flask] Starting Flask API server on http://localhost:5000
```

### 3. Verify Installation

Check the service is running:

```bash
curl http://localhost:5000/health
```

Expected response:
```json
{
  "status": "ok",
  "model_loaded": true,
  "embeddings_count": 0
}
```

### 4. Start Main Node.js Server

In your main terminal:

```bash
npm start
```

## Workflow

### Step 1: Organize Employee Training Images

Create a directory structure like this:

```
training_data/
├── EMP001/
│   ├── photo1.jpg
│   ├── photo2.jpg
│   └── photo3.jpg
├── EMP002/
│   ├── front.jpg
│   ├── side.jpg
│   └── office.jpg
└── EMP003/
    └── employee.jpg
```

**Requirements:**
- Each folder name = Employee ID (must match your database)
- Include 2-5 photos per employee for best accuracy
- Clear face visibility (good lighting, frontal/profile angles)
- JPEG, PNG, or BMP format
- Minimum 48x48 pixels per face

### Step 2: Train the Face Recognition Model

**Via UI:**

1. Navigate to "Camera Attendance" tab
2. Click "🧪 Train Model" button
3. Enter path: `C:\path\to\training_data` (or your training directory)
4. Wait for training to complete

**Via CLI:**

```bash
python face_recognition_service.py --train "/path/to/training_data" --save "data/employee_embeddings.json"
```

After training, embeddings are saved to `data/employee_embeddings.json` (~512 bytes per employee).

### Step 3: Use Face Recognition for Attendance

#### Automatic Recognition:

1. Go to "Camera Attendance" tab
2. Upload/select employee photo
3. Click "🔍 Recognize Face"
4. System auto-populates employee name and event type
5. Confirm and submit

#### Manual Recording with Face Recognition:

1. Select employee from dropdown
2. Upload photo
3. Click "Recognize Face" to verify
4. Record event normally

#### With Camera Integration:

If you have a camera stream:
1. Capture frame from camera
2. Send to `/api/face/recognize` endpoint
3. Get `{employee_id, confidence}` response
4. Auto-create attendance record

### Step 4: Check Model Status

Click "ℹ️ Model Status" to see:
- Number of trained employees
- Model name (buffalo_l)
- List of recognized employees

## API Endpoints

### Face Recognition Endpoints

#### 1. Health Check
```
GET /api/face/health
```

Response:
```json
{
  "status": "ok",
  "model_loaded": true,
  "embeddings_count": 15
}
```

#### 2. Recognize Face
```
POST /api/face/recognize
Content-Type: application/json

{
  "imageBase64": "data:image/jpeg;base64,...",
  "threshold": 0.6
}
```

Response (Recognized):
```json
{
  "success": true,
  "recognized": true,
  "employee": {
    "id": "EMP001",
    "name": "John Doe"
  },
  "confidence": 0.95,
  "attendance": {...},
  "eventType": "entry"
}
```

Response (Not Recognized):
```json
{
  "success": true,
  "recognized": false,
  "matched": false,
  "message": "No matching employee found"
}
```

#### 3. Train Model
```
POST /api/face/train
Content-Type: application/json

{
  "imagesDir": "/path/to/training_data"
}
```

Response:
```json
{
  "success": true,
  "message": "Trained embeddings for 15 employees",
  "employees": ["EMP001", "EMP002", ...],
  "embeddings_saved": "data/employee_embeddings.json"
}
```

#### 4. Get Embeddings Info
```
GET /api/face/embeddings-info
```

Response:
```json
{
  "model_name": "buffalo_l",
  "employees_count": 15,
  "employee_ids": ["EMP001", "EMP002", ...],
  "timestamp": "2024-01-15T10:30:00"
}
```

#### 5. Load Embeddings
```
POST /api/face/load-embeddings
Content-Type: application/json

{
  "filePath": "data/employee_embeddings.json"
}
```

## Configuration

### Environment Variables

Edit `.env` or set:

```env
# Python service URL (default: http://localhost:5000)
FACE_RECOGNITION_URL=http://localhost:5000

# Optional: Model choice (buffalo_l or buffalo_m)
# buffalo_l = Best accuracy (default)
# buffalo_m = Faster inference
FACE_MODEL=buffalo_l
```

### Similarity Threshold

Default: `0.6` (0 = no match, 1 = perfect match)

- `0.4` - Very loose matching (high false positives)
- `0.6` - Balanced (recommended)
- `0.7` - Strict matching (may miss legitimate matches)
- `0.8` - Very strict (only perfect matches)

Adjust in `/api/face/recognize` call:

```javascript
recognizeFace(imageBase64, threshold=0.65)
```

## Troubleshooting

### Issue: "Face recognition service unavailable"

**Solution:**
1. Verify Flask server is running: `http://localhost:5000/health`
2. Check firewall allows localhost:5000
3. Restart Flask server if needed
4. Verify `FACE_RECOGNITION_URL` in `.env`

### Issue: "No matching employee found"

**Solutions:**
- Training data quality: Ensure clear face photos
- More training photos needed: Add 3-5 photos per employee
- Increase threshold tolerance in UI
- Check employee IDs match database
- Verify image file paths are correct

### Issue: Model takes long to load on startup

**This is normal** for first run:
- buffalo_l model downloads (~500MB)
- Initial face detection setup takes 10-20 seconds
- Subsequent requests are fast (cached)

### Issue: Memory usage growing over time

**Solution:**
- Model uses reasonable memory (~800MB base + embeddings)
- Clear browser cache if UI seems slow
- Restart Flask server periodically
- Check for memory leaks in Node.js: `node --inspect server.js`

### Issue: Face recognition accuracy is low

**Improvements:**
1. Add more training images (5+ per employee)
2. Vary angles: frontal, 45°, profile
3. Vary lighting conditions
4. Ensure good image quality
5. Lower similarity threshold slightly
6. Retrain model with new images: `python face_recognition_service.py --train data/new_images --save data/employee_embeddings.json`

## Advanced Usage

### Train from Command Line

```bash
python face_recognition_service.py \
  --model buffalo_l \
  --train /path/to/training_data \
  --save data/embeddings.json
```

### Recognize from CLI

```bash
python face_recognition_service.py \
  --load data/embeddings.json \
  --recognize /path/to/test_image.jpg \
  --threshold 0.65
```

### Batch Processing

Example Python script:

```python
from face_recognition_service import initialize_model

# Initialize and load trained model
model = initialize_model()
model.load_embeddings('data/employee_embeddings.json')

# Recognize multiple images
image_paths = ['photo1.jpg', 'photo2.jpg', 'photo3.jpg']
for img_path in image_paths:
    result = model.recognize_face(img_path, threshold=0.6)
    if result:
        emp_id, confidence = result
        print(f"✓ {img_path}: {emp_id} ({confidence:.2%})")
    else:
        print(f"✗ {img_path}: No match")
```

## Performance Notes

| Operation | Time | Notes |
|-----------|------|-------|
| Model load | 10-20s | One-time on startup, cached after |
| Face extraction | 50-200ms | Per image, depends on image size |
| Face matching | 1-5ms | Very fast, just dot products |
| Training | 1-10s | Depends on number of images |
| Model size | ~500MB | Downloaded on first use |
| Inference memory | ~800MB | Base model + cache |

## Security Considerations

1. **Face Data**: Embeddings are 512D numeric vectors, NOT images
2. **Privacy**: Original images can be deleted after training
3. **Encryption**: Store embeddings in secure location
4. **Access Control**: Restrict `/api/face/*` endpoints to authenticated users
5. **Rate Limiting**: Consider adding rate limits for recognize endpoint

## Model Details

**InsightFace - ArcFace Algorithm:**
- Pre-trained on massive face datasets
- 512-dimensional face embeddings
- Cosine similarity matching
- State-of-the-art accuracy (99.8%+ on LFW benchmark)
- Supports millions of identities

**buffalo_l Model:**
- High accuracy for recognition
- Recommended for production
- ~500MB download
- Best for high-security scenarios

**buffalo_m Model** (faster alternative):
- Trade-off: slightly less accuracy
- Faster inference
- Smaller model
- Good for mobile/edge scenarios

## Next Steps

1. **Collection**: Gather employee photos
2. **Organization**: Structure in `training_data/` directory
3. **Training**: Use "Train Model" button or CLI
4. **Testing**: Try "Recognize Face" with test images
5. **Deployment**: Use in production workflow
6. **Monitoring**: Check "Model Status" regularly
7. **Optimization**: Adjust threshold based on results

## Support & Debugging

Enable detailed logging:

```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

Or check logs in Flask console output for troubleshooting.

## References

- InsightFace GitHub: https://github.com/deepinsight/insightface
- ArcFace Paper: https://arxiv.org/abs/1801.07698
- Model Zoo: https://github.com/deepinsight/insightface/tree/master/model_zoo
