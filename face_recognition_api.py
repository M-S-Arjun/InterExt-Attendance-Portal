"""
Flask API wrapper for InsightFace Face Recognition Service
Provides HTTP endpoints for camera attendance integration
"""

import os
import json
import logging
from flask import Flask, request, jsonify
from werkzeug.utils import secure_filename
import traceback
from face_recognition_service import initialize_model, FaceRecognitionModel

# Configure Flask app
app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB max
UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'uploads', 'face_training')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] [Flask] %(message)s'
)
logger = logging.getLogger(__name__)

# Initialize model
model = None
EMBEDDINGS_FILE = os.path.join(os.path.dirname(__file__), 'data', 'employee_embeddings.json')

def init_model():
    """Initialize face recognition model"""
    global model
    try:
        model = initialize_model(model_name='buffalo_l')
        
        # Try to load existing embeddings
        if os.path.exists(EMBEDDINGS_FILE):
            model.load_embeddings(EMBEDDINGS_FILE)
            logger.info(f"Loaded existing embeddings: {len(model.embeddings_db)} employees")
        
        return model
    except Exception as e:
        logger.error(f"Failed to initialize model: {e}")
        traceback.print_exc()
        return None


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({
        'status': 'ok',
        'model_loaded': model is not None,
        'embeddings_count': len(model.embeddings_db) if model else 0
    })


@app.route('/api/face/train', methods=['POST'])
def train_embeddings():
    """
    Train face recognition embeddings from employee images
    
    Expected request: 
    - Form data with 'images_dir' (path to employee images) or
    - Files uploaded in multipart form
    """
    try:
        if not model:
            return jsonify({'error': 'Model not initialized'}), 500
        
        # Get images directory from request
        images_dir = request.form.get('images_dir')
        
        if not images_dir:
            return jsonify({'error': 'images_dir parameter required'}), 400
        
        if not os.path.exists(images_dir):
            return jsonify({'error': f'Directory not found: {images_dir}'}), 404
        
        logger.info(f"Training embeddings from {images_dir}")
        
        # Train model
        embeddings = model.train_employee_embeddings(images_dir)
        
        # Save embeddings
        os.makedirs(os.path.dirname(EMBEDDINGS_FILE), exist_ok=True)
        model.save_embeddings(EMBEDDINGS_FILE)
        
        return jsonify({
            'success': True,
            'message': f'Trained embeddings for {len(embeddings)} employees',
            'employees': list(embeddings.keys()),
            'embeddings_saved': EMBEDDINGS_FILE
        })
    
    except Exception as e:
        logger.error(f"Training error: {e}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/face/recognize', methods=['POST'])
def recognize_face():
    """
    Recognize employee from camera image
    
    Expected request:
    - JSON: {'image': 'base64_image_data'} or
    - Files: {'image': file_object}
    Optional:
    - {'threshold': 0.6}
    """
    try:
        if not model:
            return jsonify({'error': 'Model not initialized'}), 500
        
        if len(model.embeddings_db) == 0:
            return jsonify({'error': 'No employee embeddings trained yet'}), 400
        
        threshold = request.form.get('threshold', 0.6, type=float)
        
        # Get image data
        image_data = None
        
        # Check for file upload
        if 'image' in request.files:
            file = request.files['image']
            # Save temporarily and process
            temp_path = os.path.join(app.config['UPLOAD_FOLDER'], 'temp_recognition.jpg')
            file.save(temp_path)
            image_data = temp_path
        
        # Check for base64 in form data
        elif 'image_base64' in request.form:
            image_data = request.form['image_base64']
        
        # Check for base64 in JSON
        elif request.is_json:
            data = request.get_json()
            if 'image' in data:
                image_data = data['image']
        
        if not image_data:
            return jsonify({'error': 'No image provided'}), 400
        
        logger.info(f"Recognizing face (threshold: {threshold})")
        
        # Recognize face
        result = model.recognize_face(image_data, threshold=threshold)
        
        if result:
            emp_id, confidence = result
            return jsonify({
                'success': True,
                'employee_id': emp_id,
                'confidence': confidence,
                'matched': True
            })
        else:
            return jsonify({
                'success': True,
                'matched': False,
                'message': 'No matching employee found'
            })
    
    except Exception as e:
        logger.error(f"Recognition error: {e}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/face/embeddings', methods=['GET'])
def get_embeddings_info():
    """Get information about loaded embeddings"""
    try:
        if not model:
            return jsonify({'error': 'Model not initialized'}), 500
        
        info = model.get_all_embeddings_info()
        return jsonify(info)
    
    except Exception as e:
        logger.error(f"Error getting embeddings info: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/face/save-embeddings', methods=['POST'])
def save_embeddings():
    """Manually save current embeddings to file"""
    try:
        if not model:
            return jsonify({'error': 'Model not initialized'}), 500
        
        os.makedirs(os.path.dirname(EMBEDDINGS_FILE), exist_ok=True)
        model.save_embeddings(EMBEDDINGS_FILE)
        
        return jsonify({
            'success': True,
            'message': 'Embeddings saved',
            'file': EMBEDDINGS_FILE
        })
    
    except Exception as e:
        logger.error(f"Error saving embeddings: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/face/load-embeddings', methods=['POST'])
def load_embeddings():
    """Load embeddings from file"""
    try:
        if not model:
            return jsonify({'error': 'Model not initialized'}), 500
        
        file_path = request.form.get('file_path', EMBEDDINGS_FILE)
        
        if not os.path.exists(file_path):
            return jsonify({'error': f'File not found: {file_path}'}), 404
        
        model.load_embeddings(file_path)
        
        return jsonify({
            'success': True,
            'message': f'Loaded embeddings for {len(model.embeddings_db)} employees',
            'employees': list(model.embeddings_db.keys())
        })
    
    except Exception as e:
        logger.error(f"Error loading embeddings: {e}")
        return jsonify({'error': str(e)}), 500


@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Endpoint not found'}), 404


@app.errorhandler(500)
def server_error(error):
    logger.error(f"Server error: {error}")
    return jsonify({'error': 'Internal server error'}), 500


if __name__ == '__main__':
    logger.info("Initializing Face Recognition Service...")
    init_model()
    
    logger.info("Starting Flask API server on http://localhost:5000")
    app.run(
        host='0.0.0.0',
        port=5000,
        debug=False,
        use_reloader=False  # Disable reloader to avoid model reloading
    )
