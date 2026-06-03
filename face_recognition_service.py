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
        """Load the InsightFace model"""
        try:
            logger.info(f"Loading InsightFace model: {self.model_name}")
            # Enable GPU execution provider if available, with CPU fallback
            providers = ['CUDAExecutionProvider', 'CPUExecutionProvider']
            self.app = FaceAnalysis(
                name=self.model_name, 
                allowed_modules=['detection', 'recognition'], 
                providers=providers
            )
            self.app.prepare(ctx_id=0, det_size=(480, 480))
            logger.info("InsightFace model loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            raise

    
    def extract_face_embedding(self, image_path_or_data: str, raise_errors: bool = False) -> Optional[np.ndarray]:
        """
        Extract face embedding from image
        
        Args:
            image_path_or_data: Path to image or base64 encoded image data
            raise_errors: If True, raise ValueError for validation failures
            
        Returns:
            Face embedding vector (512-dim) or None if no face detected
        """
        try:
            from PIL import Image, ImageOps
            import io
            
            # Load image
            if image_path_or_data.startswith('data:image'):
                # Handle base64 encoded image
                image_data = image_path_or_data.split(',')[1]
                image_bytes = base64.b64decode(image_data)
                image = Image.open(io.BytesIO(image_bytes))
            else:
                # Load from file path
                if not os.path.exists(image_path_or_data):
                    logger.error(f"Image file does not exist: {image_path_or_data}")
                    return None
                image = Image.open(image_path_or_data)
            
            # Apply EXIF transpose to automatically rotate photos based on orientation metadata
            image = ImageOps.exif_transpose(image)
            
            # Convert RGB PIL Image to BGR OpenCV array
            image_array = cv2.cvtColor(np.array(image.convert('RGB')), cv2.COLOR_RGB2BGR)

            # Downscale large images for faster face detection and embedding extraction
            h, w = image_array.shape[:2]
            max_size = 480
            if max(h, w) > max_size:
                scale = max_size / max(h, w)
                image_array = cv2.resize(image_array, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
                logger.info(f"Downscaled image from {w}x{h} to {int(w*scale)}x{int(h*scale)}")

            
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
    
    def train_employee_embeddings(self, employee_images_dir: str, force_retrain: bool = False, save_callback=None) -> Dict[str, np.ndarray]:
        """
        Train/build embeddings database from employee images
        
        Directory structure expected:
        employee_images_dir/
        employee_id_1/
        photo1.jpg
        photo2.jpg
        employee_id_2/
        photo1.jpg
        
        Args:
        employee_images_dir: Directory containing employee image folders
        force_retrain: If True, retrain all employees; otherwise skip existing ones
        save_callback: Function to call to save intermediate progress
        
        Returns:
        Dictionary mapping employee_id to average embedding vector
        """
        # Maintain existing loaded database, only adding new ones or overwriting if forced
        embeddings_db = self.embeddings_db.copy()
        
        if not os.path.exists(employee_images_dir):
            logger.warning(f"Employee images directory not found: {employee_images_dir}")
            return embeddings_db
        
        employee_dirs = [d for d in os.listdir(employee_images_dir) 
                        if os.path.isdir(os.path.join(employee_images_dir, d))]
        
        logger.info(f"Training embeddings for {len(employee_dirs)} employees (force_retrain={force_retrain})")
        
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
                image_path = os.path.join(employee_path, image_file)
                embedding = self.extract_face_embedding(image_path)
                
                if embedding is not None:
                    employee_embeddings.append(embedding)
                else:
                    logger.warning(f"Failed to extract embedding from {image_path}")
            
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
        logger.info(f"Training complete. {len(embeddings_db)} employees in database")
        return embeddings_db
    
    def save_embeddings(self, save_path: str):
        """Save embeddings database to file"""
        try:
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
    
    def recognize_face(self, image_path_or_data: str, threshold: float = 0.6) -> Optional[Tuple[str, float]]:
        """
        Recognize employee from image
        
        Args:
            image_path_or_data: Path to image or base64 data
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
    """Initialize the face recognition model"""
    global face_model
    if face_model is None:
        face_model = FaceRecognitionModel(model_name=model_name)
    return face_model


def main():
    """CLI for testing face recognition"""
    import argparse
    
    parser = argparse.ArgumentParser(description='InsightFace Face Recognition Service')
    parser.add_argument('--train', type=str, help='Train embeddings from directory')
    parser.add_argument('--recognize', type=str, help='Recognize face in image')
    parser.add_argument('--save', type=str, help='Save embeddings to file')
    parser.add_argument('--load', type=str, help='Load embeddings from file')
    parser.add_argument('--threshold', type=float, default=0.6, help='Recognition threshold')
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
