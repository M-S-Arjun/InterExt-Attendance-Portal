"""
Flask API wrapper for InsightFace Face Recognition Service
Provides HTTP endpoints for camera attendance integration
"""

import os
import json
import logging
import argparse
from flask import Flask, request, jsonify, Response
import cv2
import time
import numpy as np
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
CAMERA_CONFIGS_FILE = os.path.join(os.path.dirname(__file__), 'data', 'camera_configs.json')

def _save_camera_config(camera_id, config):
    """Persist camera config to disk so cameras survive Python API restarts."""
    try:
        configs = {}
        if os.path.exists(CAMERA_CONFIGS_FILE):
            with open(CAMERA_CONFIGS_FILE, 'r') as f:
                configs = json.load(f)
        configs[camera_id] = config
        with open(CAMERA_CONFIGS_FILE, 'w') as f:
            json.dump(configs, f, indent=2)
    except Exception as e:
        logger.warning(f"Could not save camera config: {e}")

def _remove_camera_config(camera_id):
    """Remove a camera config from persistent storage."""
    try:
        if not os.path.exists(CAMERA_CONFIGS_FILE):
            return
        with open(CAMERA_CONFIGS_FILE, 'r') as f:
            configs = json.load(f)
        configs.pop(camera_id, None)
        with open(CAMERA_CONFIGS_FILE, 'w') as f:
            json.dump(configs, f, indent=2)
    except Exception as e:
        logger.warning(f"Could not remove camera config: {e}")

def _restore_cameras():
    """Auto-restore all previously running cameras after startup."""
    import threading, cctv_processor
    def _do_restore():
        time.sleep(2)  # Wait for model to be fully ready
        if not os.path.exists(CAMERA_CONFIGS_FILE):
            return
        try:
            with open(CAMERA_CONFIGS_FILE, 'r') as f:
                configs = json.load(f)
            for camera_id, cfg in configs.items():
                try:
                    node_server = os.environ.get('NODE_SERVER_URL', 'http://localhost:3000')
                    cctv_processor.start_cctv_thread(
                        camera_id,
                        cfg['name'],
                        cfg['source'],
                        cfg.get('site_name', 'Office'),
                        cfg.get('event_type', 'auto'),
                        cfg.get('threshold', 0.52),
                        node_server,
                        cfg.get('invert_direction', False)
                    )
                    logger.info(f"[Auto-Restore] Restarted camera: {cfg['name']}")
                except Exception as ex:
                    logger.error(f"[Auto-Restore] Failed to restore {camera_id}: {ex}")
        except Exception as e:
            logger.error(f"[Auto-Restore] Failed to read camera configs: {e}")
    threading.Thread(target=_do_restore, daemon=True).start()

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
    - Optional: 'force' (boolean string, 'true' to force retrain all)
    """
    try:
        if not model:
            return jsonify({'error': 'Model not initialized'}), 500
        
        # Get images directory from request
        images_dir = request.form.get('images_dir')
        force_val = request.form.get('force', 'false').lower()
        force_retrain = force_val in ('true', '1', 'yes')
        employee_id = request.form.get('employee_id')
        
        if not images_dir:
            return jsonify({'error': 'images_dir parameter required'}), 400
        
        if not os.path.exists(images_dir):
            return jsonify({'error': f'Directory not found: {images_dir}'}), 404
        
        if employee_id:
            logger.info(f"Targeted training requested for employee: {employee_id}")
            if model.embeddings_db:
                model.embeddings_db.pop(employee_id, None)
            force_retrain = False
            
        logger.info(f"Training embeddings from {images_dir} (force: {force_retrain}, target: {employee_id})")
        
        # Callback to save intermediate embeddings dynamically
        def save_cb():
            os.makedirs(os.path.dirname(EMBEDDINGS_FILE), exist_ok=True)
            model.save_embeddings(EMBEDDINGS_FILE)
            
        # Train model with incremental resume capability
        embeddings = model.train_employee_embeddings(
            images_dir, 
            force_retrain=force_retrain, 
            save_callback=save_cb
        )
        
        # Final save
        save_cb()
        
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
    - {'threshold': 0.52}
    """
    try:
        if not model:
            return jsonify({'error': 'Model not initialized'}), 500
        
        if len(model.embeddings_db) == 0:
            return jsonify({'error': 'No employee embeddings trained yet'}), 400
        
        threshold = request.form.get('threshold', None, type=float)
        if threshold is None and request.is_json:
            body = request.get_json(silent=True) or {}
            threshold = float(body.get('threshold', 0.52))
        threshold = threshold if threshold is not None else 0.52
        
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
        
        # Recognize faces
        results = model.recognize_faces(image_data, threshold=threshold)
        
        if results:
            first_emp, first_conf = results[0]
            matches_list = [{'employee_id': emp_id, 'confidence': conf} for emp_id, conf in results]
            return jsonify({
                'success': True,
                'employee_id': first_emp,
                'confidence': first_conf,
                'matched': True,
                'matches': matches_list
            })
        else:
            return jsonify({
                'success': True,
                'matched': False,
                'message': 'No matching employee found',
                'matches': []
            })
    
    except ValueError as val_err:
        logger.warning(f"Validation error: {val_err}")
        return jsonify({
            'success': False,
            'matched': False,
            'error': str(val_err)
        }), 400
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


@app.route('/api/cctv/start', methods=['POST'])
def cctv_start():
    try:
        # Support both JSON and Form parameters
        data = request.get_json() if request.is_json else {}
        camera_id = data.get('camera_id') or request.form.get('camera_id')
        name = data.get('name') or request.form.get('name')
        source = data.get('source') or request.form.get('source')
        site_name = data.get('site_name') or request.form.get('site_name', 'Office')
        event_type = data.get('event_type') or request.form.get('event_type', 'auto')
        threshold = float(data.get('threshold') or request.form.get('threshold', 0.52))
        
        # invert_direction can be boolean or string 'true'/'false'
        invert_dir_val = data.get('invert_direction') or request.form.get('invert_direction', 'false')
        invert_direction = str(invert_dir_val).lower() == 'true'
        
        node_server = os.environ.get('NODE_SERVER_URL', 'http://localhost:3000')
        
        if not camera_id or not name or not source:
            return jsonify({'error': 'camera_id, name, and source are required'}), 400
        
        # Persist config so we can restore after restart
        _save_camera_config(camera_id, {
            'name': name, 'source': source, 'site_name': site_name,
            'event_type': event_type, 'threshold': threshold,
            'invert_direction': invert_direction
        })

        import cctv_processor
        success = cctv_processor.start_cctv_thread(
            camera_id, name, source, site_name, event_type, threshold, node_server, invert_direction
        )
        
        return jsonify({'success': success, 'message': f'CCTV thread started for camera {name}'})
    except Exception as e:
        logger.error(f"Error starting CCTV stream: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/cctv/stop', methods=['POST'])
def cctv_stop():
    try:
        data = request.get_json() if request.is_json else {}
        camera_id = data.get('camera_id') or request.form.get('camera_id')
        
        if not camera_id:
            return jsonify({'error': 'camera_id is required'}), 400
        
        # Remove from persistent config when explicitly stopped
        _remove_camera_config(camera_id)

        import cctv_processor
        success = cctv_processor.stop_cctv_thread(camera_id)
        
        return jsonify({'success': success, 'message': f'CCTV thread stopped for camera {camera_id}'})
    except Exception as e:
        logger.error(f"Error stopping CCTV stream: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/cctv/status', methods=['GET'])
def cctv_status():
    try:
        import cctv_processor
        status = cctv_processor.get_cctv_status()
        return jsonify({'success': True, 'cameras': status})
    except Exception as e:
        logger.error(f"Error getting CCTV status: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/cctv/stream/<camera_id>', methods=['GET'])
def cctv_stream(camera_id):
    try:
        import cctv_processor
        
        def generate_frames():
            while True:
                frame = None
                with cctv_processor.active_cameras_lock:
                    if camera_id in cctv_processor.active_cameras:
                        proc = cctv_processor.active_cameras[camera_id]
                        if proc.running and proc.latest_frame is not None:
                            frame = proc.latest_frame.copy()
                            h, w = frame.shape[:2]
                            is_entry = 'entrance' in proc.name.lower() or 'entry' in proc.name.lower() or proc.event_type == 'entry'
                            is_exit = 'exit' in proc.name.lower() or proc.event_type == 'exit'
                            if is_entry:
                                y_line = int(h * 0.6)
                                x_left = int(w * 0.35)
                                x_right = int(w * 0.70)
                                cv2.line(frame, (0, y_line), (w, y_line), (0, 0, 255), 2)
                                cv2.line(frame, (x_left, 0), (x_left, h), (0, 0, 255), 2)
                                cv2.line(frame, (x_right, 0), (x_right, h), (0, 0, 255), 2)
                                cv2.putText(frame, "VIRTUAL ATTENDANCE LINE (MID)", (10, y_line - 10), 
                                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
                                cv2.putText(frame, "VIRTUAL ATTENDANCE LINE (LEFT)", (x_left + 5, 25), 
                                            cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
                                cv2.putText(frame, "VIRTUAL ATTENDANCE LINE (RIGHT)", (x_right + 10, 25), 
                                            cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
                            elif is_exit:
                                x_left = int(w * 0.32)
                                x_right = int(w * 0.55)
                                cv2.line(frame, (x_left, 0), (x_left, h), (0, 0, 255), 2)
                                cv2.line(frame, (x_right, 0), (x_right, h), (0, 0, 255), 2)
                                cv2.putText(frame, "VIRTUAL ATTENDANCE LINE (LEFT)", (x_left + 5, 25), 
                                            cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
                                cv2.putText(frame, "VIRTUAL ATTENDANCE LINE (RIGHT)", (x_right + 10, 25), 
                                            cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
                
                if frame is not None:
                    ret, jpeg = cv2.imencode('.jpg', frame)
                    if ret:
                        yield (b'--frame\r\n'
                               b'Content-Type: image/jpeg\r\n\r\n' + jpeg.tobytes() + b'\r\n')
                else:
                    placeholder = np.zeros((240, 320, 3), dtype=np.uint8)
                    cv2.putText(placeholder, "No camera feed", (50, 120), 
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (128, 128, 128), 2)
                    ret, jpeg = cv2.imencode('.jpg', placeholder)
                    if ret:
                        yield (b'--frame\r\n'
                               b'Content-Type: image/jpeg\r\n\r\n' + jpeg.tobytes() + b'\r\n')
                
                time.sleep(0.1)

        return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')
    except Exception as e:
        logger.error(f"Error streaming CCTV camera {camera_id}: {e}")
        return jsonify({'error': str(e)}), 500



@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Endpoint not found'}), 404


@app.errorhandler(500)
def server_error(error):
    logger.error(f"Server error: {error}")
    return jsonify({'error': 'Internal server error'}), 500


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='InsightFace Face Recognition Service')
    parser.add_argument('--train', type=str, help='Train embeddings from directory')
    parser.add_argument('--force', action='store_true', help='Force retrain all employees')
    parser.add_argument('--save', type=str, default=EMBEDDINGS_FILE, help='Save embeddings to this file after training')
    parser.add_argument('--serve', action='store_true', help='Start the Flask server after initialization')
    args = parser.parse_args()

    logger.info("Initializing Face Recognition Service...")
    init_model()

    if args.train:
        if not os.path.exists(args.train):
            logger.error(f'Training directory not found: {args.train}')
            raise SystemExit(1)

        logger.info(f"Training embeddings from {args.train} (force={args.force})")

        def save_cb():
            os.makedirs(os.path.dirname(args.save), exist_ok=True)
            model.save_embeddings(args.save)

        embeddings = model.train_employee_embeddings(
            args.train,
            force_retrain=args.force,
            save_callback=save_cb
        )
        save_cb()
        logger.info(f"Training complete. Saved embeddings for {len(embeddings)} employees to {args.save}")

        if args.serve:
            logger.info("Starting Flask API server on http://localhost:5000")
            app.run(
                host='0.0.0.0',
                port=5000,
                debug=False,
                use_reloader=False,
                threaded=True  # Allow concurrent requests from multiple camera threads
            )
        else:
            logger.info("Exiting after training.")
        raise SystemExit(0)

    logger.info("Starting Flask API server on http://localhost:5000")
    # Auto-restore cameras that were running before any restart
    _restore_cameras()
    app.run(
        host='0.0.0.0',
        port=5000,
        debug=False,
        use_reloader=False,
        threaded=True  # Allow concurrent requests from multiple camera threads
    )
