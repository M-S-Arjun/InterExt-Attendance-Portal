"""
InsightFace-based Face Recognition Service for Camera Attendance
Handles face detection, embedding extraction, and employee matching
"""

import os
import sys
import json
import base64
import traceback
from pathlib import Path
from typing import Dict, List, Tuple, Optional
import numpy as np
from datetime import datetime
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger(__name__)

# Optimize ONNX Runtime CPU execution settings globally to prevent thread oversubscription
try:
    import onnxruntime as ort
    
    # Save original InferenceSession __init__
    original_init = ort.InferenceSession.__init__
    
    def optimized_init(self_session, model_path, sess_options=None, *args, **kwargs):
        if sess_options is None:
            sess_options = ort.SessionOptions()
        
        # Optimize CPU threads to prevent thread context-switching thrashing on host
        sess_options.intra_op_num_threads = 4
        sess_options.inter_op_num_threads = 1
        sess_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        
        # Pass the optimized options to the original constructor
        original_init(self_session, model_path, sess_options, *args, **kwargs)
        
    ort.InferenceSession.__init__ = optimized_init
    logger.info("[ORT-Speedup] Successfully patched ONNX Runtime InferenceSession for low-latency CPU inference.")
except Exception as ort_err:
    logger.warning(f"[ORT-Speedup] Failed to patch ONNX Runtime settings: {ort_err}")

try:
    import insightface
    from insightface.app import FaceAnalysis
    import cv2
except ImportError:
    logger.error("InsightFace not installed. Install with: pip install insightface opencv-python")
    sys.exit(1)


class FaceRecognitionModel:
    """Wrapper for InsightFace face recognition"""
    
    def __init__(self, model_name: str = 'buffalo_l'):
        """
        Initialize InsightFace model
        
        Args:
            model_name: Model preset ('buffalo_l' for best accuracy, 'buffalo_m' for speed)
        """
        self.model_name = model_name
        self.app = None
        self.embeddings_db = {}  # {employee_id: embedding_vector}
        self.load_model()
    
    def load_model(self):
        """Load the InsightFace model with dual-resolution detectors.

        self.app      → high-res 640×640 detector (training & static recognition)
        self.fast_app → fast 320×320 detector (live CCTV hot loop — ~3× faster)
        """
        try:
            logger.info(f"Loading InsightFace model: {self.model_name} (dual-res)")
            providers = ['CUDAExecutionProvider', 'CPUExecutionProvider']

            # High-resolution model for accurate training / static recognition
            self.app = FaceAnalysis(
                name=self.model_name,
                allowed_modules=['detection', 'recognition'],
                providers=providers
            )
            self.app.prepare(ctx_id=0, det_size=(640, 640))

            # Fast model for real-time CCTV loop (shared ONNX weights, smaller input)
            self.fast_app = FaceAnalysis(
                name=self.model_name,
                allowed_modules=['detection', 'recognition'],
                providers=providers
            )
            self.fast_app.prepare(ctx_id=0, det_size=(320, 320))

            logger.info("InsightFace dual-res model loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            raise

    def warm_up(self):
        """Run a blank frame through both detectors to pre-JIT the ONNX graph.

        Eliminates the first-frame latency spike (often 500ms+) that occurs when
        ONNX Runtime lazily compiles the computation graph on first real inference.
        """
        try:
            dummy = np.zeros((480, 640, 3), dtype=np.uint8)
            self.app.get(dummy)
            self.fast_app.get(dummy)
            logger.info("[Warm-up] Both detectors pre-JITted successfully (zero first-frame latency).")
        except Exception as e:
            logger.warning(f"[Warm-up] Warm-up failed (non-fatal): {e}")

    def get_faces_fast(self, frame: np.ndarray):
        """Run face detection+embedding using the fast 320×320 detector.

        Use this in the live CCTV inference thread for maximum throughput.
        Falls back to the high-res detector if fast_app is unavailable.
        """
        detector = getattr(self, 'fast_app', None) or self.app
        return detector.get(frame)

    
    def _load_image_array(self, image_path_or_data) -> Optional[np.ndarray]:
        try:
            from PIL import Image, ImageOps
            import io
            
            image_array = None
            if isinstance(image_path_or_data, np.ndarray):
                # Input is already a BGR OpenCV numpy array
                image_array = image_path_or_data.copy()
            elif isinstance(image_path_or_data, str) and image_path_or_data.startswith('data:image'):
                # Handle base64 encoded image
                image_data = image_path_or_data.split(',')[1]
                image_bytes = base64.b64decode(image_data)
                image = Image.open(io.BytesIO(image_bytes))
                # Apply EXIF transpose to automatically rotate photos based on orientation metadata
                image = ImageOps.exif_transpose(image)
                image_array = cv2.cvtColor(np.array(image.convert('RGB')), cv2.COLOR_RGB2BGR)
            elif isinstance(image_path_or_data, str):
                # Load from file path
                if not os.path.exists(image_path_or_data):
                    logger.error(f"Image file does not exist: {image_path_or_data}")
                    return None
                image = Image.open(image_path_or_data)
                # Apply EXIF transpose to automatically rotate photos based on orientation metadata
                image = ImageOps.exif_transpose(image)
                image_array = cv2.cvtColor(np.array(image.convert('RGB')), cv2.COLOR_RGB2BGR)
            else:
                logger.error("Unsupported image input type")
                return None

            # Only downscale very large images (>1280px) to preserve face detail on RTSP streams.
            # Previously capped at 480px which crushed small faces on sub-streams.
            h, w = image_array.shape[:2]
            max_size = 1280
            if max(h, w) > max_size:
                scale = max_size / max(h, w)
                image_array = cv2.resize(image_array, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
                logger.info(f"Downscaled image from {w}x{h} to {int(w*scale)}x{int(h*scale)}")
            return image_array
        except Exception as e:
            logger.error(f"Error loading image array: {e}")
            traceback.print_exc()
            return None

    def extract_face_embedding(self, image_path_or_data, raise_errors: bool = False) -> Optional[np.ndarray]:
        """
        Extract face embedding from image
        
        Args:
            image_path_or_data: Path to image, base64 encoded image data, or numpy BGR image array
            raise_errors: If True, raise ValueError for validation failures
            
        Returns:
            Face embedding vector (512-dim) or None if no face detected
        """
        try:
            image_array = self._load_image_array(image_path_or_data)
            if image_array is None:
                return None
            
            # Detect faces and get embeddings
            faces = self.app.get(image_array)
            
            if len(faces) == 0:
                logger.warning("No face detected in image")
                if raise_errors:
                    raise ValueError("No face detected")
                return None
            
            if len(faces) > 1:
                logger.warning("Multiple faces detected in image")
                if raise_errors:
                    raise ValueError("Multiple faces detected")
            
            # Use the largest/most prominent face
            face = max(faces, key=lambda x: x.bbox[2] * x.bbox[3])  # Sort by area
            embedding = face.embedding
            
            logger.info(f"Successfully extracted face embedding from image")
            return embedding
            
        except Exception as e:
            if isinstance(e, ValueError) and raise_errors:
                raise e
            logger.error(f"Error extracting face embedding: {e}")
            traceback.print_exc()
            return None

    def recognize_faces(self, image_path_or_data, threshold: float = 0.51) -> List[Tuple[str, float]]:
        """
        Recognize multiple employees from image
        
        Args:
            image_path_or_data: Path to image, base64 data, or numpy BGR image array
            threshold: Cosine similarity threshold (0-1). Higher = stricter matching
            
        Returns:
            List of tuples of (employee_id, confidence) for all matched faces
        """
        if not self.embeddings_db:
            logger.warning("No embeddings database loaded")
            return []
        
        # Load image array
        image_array = self._load_image_array(image_path_or_data)
        if image_array is None:
            return []
        
        # Detect faces and get embeddings
        faces = self.app.get(image_array)
        
        if len(faces) == 0:
            logger.warning("No face detected in image")
            raise ValueError("No face detected")
            
        results = []
        for face in faces:
            embedding = face.embedding
            if embedding is None:
                continue
            
            # Normalize embedding
            embedding = embedding / np.linalg.norm(embedding)
            
            # Find best match using cosine similarity
            best_match = None
            best_score = 0
            
            for emp_id, emp_embedding in self.embeddings_db.items():
                similarity = np.dot(embedding, emp_embedding)
                
                if similarity > best_score:
                    best_score = similarity
                    best_match = emp_id
            
            if best_score >= threshold:
                logger.info(f"Face recognized: {best_match} (confidence: {best_score:.3f})")
                results.append((best_match, float(best_score)))
            else:
                logger.info(f"No match found for a detected face (best score: {best_score:.3f}, threshold: {threshold})")
        
        # Deduplicate matches (if two faces match the same employee, keep the higher confidence one)
        unique_matches = {}
        for emp_id, score in results:
            if emp_id not in unique_matches or score > unique_matches[emp_id]:
                unique_matches[emp_id] = score
                
        return list(unique_matches.items())
    
    def train_employee_embeddings(self, employee_images_dir: str, force_retrain: bool = False, save_callback=None) -> Dict[str, np.ndarray]:
        """
        Train/build embeddings database from employee images with image embeddings cache
        """
        embeddings_db = self.embeddings_db.copy()
        
        if not os.path.exists(employee_images_dir):
            logger.warning(f"Employee images directory not found: {employee_images_dir}")
            return embeddings_db
        
        employee_dirs = [d for d in os.listdir(employee_images_dir) 
                        if os.path.isdir(os.path.join(employee_images_dir, d))]
        
        logger.info(f"Training embeddings for {len(employee_dirs)} employees (force_retrain={force_retrain})")
        
        # Load image embedding cache
        cache_path = os.path.abspath(os.path.join(os.path.dirname(employee_images_dir), 'data', 'image_embeddings_cache.json')).replace('\\', '/')
        image_cache = {}
        cache_updated = False
        if os.path.exists(cache_path):
            try:
                with open(cache_path, 'r') as f:
                    image_cache = json.load(f)
                logger.info(f"Loaded {len(image_cache)} cached image embeddings.")
            except Exception as cache_err:
                logger.warning(f"Could not load image embeddings cache: {cache_err}")
        
        for employee_id in employee_dirs:
            # Skip if already trained and not forcing a retrain
            if employee_id in embeddings_db and not force_retrain:
                logger.info(f"Skipping already trained employee: {employee_id}")
                continue
                
            employee_path = os.path.join(employee_images_dir, employee_id)
            image_files = [f for f in os.listdir(employee_path) 
                          if f.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp'))]
            
            if not image_files:
                logger.warning(f"No images found for employee {employee_id}")
                continue
            
            employee_embeddings = []
            
            for image_file in image_files:
                cache_key = f"{employee_id}/{image_file}"
                embedding = None
                if cache_key in image_cache:
                    embedding = np.array(image_cache[cache_key], dtype=np.float32)
                else:
                    image_path = os.path.join(employee_path, image_file)
                    embedding = self.extract_face_embedding(image_path)
                    if embedding is not None:
                        image_cache[cache_key] = embedding.tolist()
                        cache_updated = True
                
                if embedding is not None:
                    employee_embeddings.append(embedding)
                else:
                    logger.warning(f"Failed to extract embedding from {employee_id}/{image_file}")
            
            # Average embeddings for the employee
            if employee_embeddings:
                avg_embedding = np.mean(employee_embeddings, axis=0)
                embeddings_db[employee_id] = avg_embedding / np.linalg.norm(avg_embedding)  # L2 normalize
                logger.info(f"Trained {len(employee_embeddings)} images for employee {employee_id}")
                
                # Save dynamically after each employee is trained to preserve progress
                self.embeddings_db = embeddings_db
                if save_callback:
                    try:
                        save_callback()
                    except Exception as callback_err:
                        logger.error(f"Error in save_callback: {callback_err}")
            else:
                logger.warning(f"No valid embeddings for employee {employee_id}")
        
        self.embeddings_db = embeddings_db
        
        # Save updated cache to disk
        if cache_updated:
            try:
                os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                with open(cache_path, 'w') as f:
                    json.dump(image_cache, f)
                logger.info(f"Saved {len(image_cache)} image embeddings to cache.")
            except Exception as cache_err:
                logger.warning(f"Could not save image embeddings cache: {cache_err}")
                
        logger.info(f"Training complete. {len(embeddings_db)} employees in database")
        return embeddings_db
    
    def save_embeddings(self, save_path: str):
        """Save embeddings database to file"""
        try:
            save_path = os.path.abspath(save_path).replace('\\', '/')
            # Convert numpy arrays to lists for JSON serialization
            embeddings_json = {
                emp_id: embedding.tolist() 
                for emp_id, embedding in self.embeddings_db.items()
            }
            
            with open(save_path, 'w') as f:
                json.dump(embeddings_json, f)
            
            logger.info(f"Embeddings saved to {save_path}")
        except Exception as e:
            logger.error(f"Failed to save embeddings: {e}")
    
    def load_embeddings(self, load_path: str):
        """Load embeddings database from file"""
        try:
            load_path = os.path.abspath(load_path).replace('\\', '/')
            with open(load_path, 'r') as f:
                embeddings_json = json.load(f)
            
            # Convert lists back to numpy arrays
            self.embeddings_db = {
                emp_id: np.array(embedding)
                for emp_id, embedding in embeddings_json.items()
            }
            
            logger.info(f"Loaded embeddings for {len(self.embeddings_db)} employees from {load_path}")
        except Exception as e:
            logger.error(f"Failed to load embeddings: {e}")
    
    def recognize_face(self, image_path_or_data, threshold: float = 0.51) -> Optional[Tuple[str, float]]:
        """
        Recognize employee from image
        
        Args:
            image_path_or_data: Path to image, base64 data, or numpy BGR image array
            threshold: Cosine similarity threshold (0-1). Higher = stricter matching
            
        Returns:
            Tuple of (employee_id, confidence) or None if no match found
        """
        if not self.embeddings_db:
            logger.warning("No embeddings database loaded")
            return None
        
        # Extract embedding from input image
        input_embedding = self.extract_face_embedding(image_path_or_data, raise_errors=True)
        if input_embedding is None:
            logger.warning("Could not extract embedding from input image")
            return None
        
        # Normalize embedding
        input_embedding = input_embedding / np.linalg.norm(input_embedding)
        
        # Find best match using cosine similarity
        best_match = None
        best_score = 0
        
        for emp_id, emp_embedding in self.embeddings_db.items():
            # Cosine similarity
            similarity = np.dot(input_embedding, emp_embedding)
            
            if similarity > best_score:
                best_score = similarity
                best_match = emp_id
        
        if best_score >= threshold:
            logger.info(f"Face recognized: {best_match} (confidence: {best_score:.3f})")
            return (best_match, float(best_score))
        else:
            logger.info(f"No match found (best score: {best_score:.3f}, threshold: {threshold})")
            return None
    
    def get_all_embeddings_info(self) -> Dict:
        """Get info about loaded embeddings database"""
        return {
            'model_name': self.model_name,
            'employees_count': len(self.embeddings_db),
            'employee_ids': list(self.embeddings_db.keys()),
            'timestamp': datetime.now().isoformat()
        }


# Global model instance
face_model = None


def initialize_model(model_name: str = 'buffalo_l') -> FaceRecognitionModel:
    """Initialize the face recognition model (singleton, with warm-up)."""
    global face_model
    if face_model is None:
        face_model = FaceRecognitionModel(model_name=model_name)
        face_model.warm_up()  # Pre-JIT both detectors to avoid first-frame spike
    return face_model


def main():
    """CLI for testing face recognition"""
    import argparse
    
    parser = argparse.ArgumentParser(description='InsightFace Face Recognition Service')
    parser.add_argument('--train', type=str, help='Train embeddings from directory')
    parser.add_argument('--recognize', type=str, help='Recognize face in image')
    parser.add_argument('--save', type=str, help='Save embeddings to file')
    parser.add_argument('--load', type=str, help='Load embeddings from file')
    parser.add_argument('--threshold', type=float, default=0.51, help='Recognition threshold')
    parser.add_argument('--model', type=str, default='buffalo_l', help='Model name')
    
    args = parser.parse_args()
    
    # Initialize model
    model = initialize_model(args.model)
    
    if args.train:
        logger.info(f"Training embeddings from {args.train}")
        embeddings = model.train_employee_embeddings(args.train)
        logger.info(f"Trained embeddings for {len(embeddings)} employees")
        
        if args.save:
            model.save_embeddings(args.save)
    
    if args.load:
        logger.info(f"Loading embeddings from {args.load}")
        model.load_embeddings(args.load)
    
    if args.recognize:
        logger.info(f"Recognizing face in {args.recognize}")
        result = model.recognize_face(args.recognize, threshold=args.threshold)
        if result:
            emp_id, confidence = result
            logger.info(f"Recognized: {emp_id} ({confidence:.3f})")
        else:
            logger.info("No match found")
    
    # Print model info
    logger.info(json.dumps(model.get_all_embeddings_info(), indent=2))


if __name__ == '__main__':
    main()
