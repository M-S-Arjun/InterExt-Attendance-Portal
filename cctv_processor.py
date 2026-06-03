import os
import cv2
import time
import threading
import requests
import numpy as np
import base64
import logging
import traceback

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] [CCTV] %(message)s'
)
logger = logging.getLogger(__name__)

# Registry of active CCTV processors
active_cameras = {}
active_cameras_lock = threading.Lock()

class CCTVStreamProcessor(threading.Thread):
    def __init__(self, camera_id, name, source, site_name, event_type, threshold=0.55, node_server="http://localhost:3000"):
        super().__init__()
        self.camera_id = camera_id
        self.name = name
        self.source = source  # Can be RTSP URL, file path, or webcam index (int)
        self.site_name = site_name
        self.event_type = event_type  # 'entry', 'exit', or 'auto'
        self.threshold = threshold
        self.node_server = node_server
        
        self.running = False
        self.latest_frame = None
        self.grab_thread = None
        self.cooldowns = {}  # { employee_id: timestamp }
        self.cooldown_seconds = 300  # 5 minutes
        
        # Parse source if it's a webcam index (e.g. "0" -> 0)
        try:
            if str(source).isdigit():
                self.source = int(source)
        except Exception:
            pass

    def run(self):
        self.running = True
        logger.info(f"[{self.name}] Starting stream capture on: {self.source}")
        
        cap = cv2.VideoCapture(self.source)
        if not cap.isOpened():
            logger.error(f"[{self.name}] Failed to open video source: {self.source}")
            self.running = False
            return

        # Frame grabbing thread to prevent buffer lag
        def grab_loop():
            while self.running:
                ret, frame = cap.read()
                if not ret:
                    # End of stream or connection drop, wait and retry
                    time.sleep(0.1)
                    continue
                self.latest_frame = frame

        self.grab_thread = threading.Thread(target=grab_loop, daemon=True)
        self.grab_thread.start()

        # Import model initialization
        from face_recognition_service import initialize_model
        model = initialize_model()

        while self.running:
            try:
                # Process every 1.5 seconds to conserve CPU
                time.sleep(1.5)
                
                frame = self.latest_frame
                if frame is None:
                    continue
                
                # Convert the cv2 frame to base64 for the recognition method
                _, buffer = cv2.imencode('.jpg', frame)
                jpg_as_text = base64.b64encode(buffer).decode('utf-8')
                image_base64 = f"data:image/jpeg;base64,{jpg_as_text}"
                
                # Perform face recognition directly via the local model instance
                result = model.recognize_face(image_base64, threshold=self.threshold)
                
                if result:
                    employee_id, confidence = result
                    
                    # Check cool-down per employee
                    now = time.time()
                    last_seen = self.cooldowns.get(employee_id, 0)
                    if now - last_seen < self.cooldown_seconds:
                        logger.debug(f"[{self.name}] Matched {employee_id} but cool-down is active")
                        continue
                    
                    # Update cool-down
                    self.cooldowns[employee_id] = now
                    logger.info(f"[{self.name}] Face recognized: {employee_id} (confidence: {confidence:.3f})")
                    
                    # Post recognized CCTV event to the Node.js server
                    self.report_attendance(employee_id, confidence, jpg_as_text)
                    
            except Exception as e:
                logger.error(f"[{self.name}] Error in processing loop: {e}")
                traceback.print_exc()

        # Cleanup
        logger.info(f"[{self.name}] Stopping stream capture")
        self.running = False
        cap.release()

    def report_attendance(self, employee_id, confidence, image_base64_raw):
        try:
            url = f"{self.node_server}/api/face/cctv-event"
            payload = {
                'employee_id': employee_id,
                'confidence': confidence,
                'camera_id': self.camera_id,
                'camera_name': self.name,
                'site_name': self.site_name,
                'event_type': self.event_type,
                'image_base64': image_base64_raw
            }
            resp = requests.post(url, json=payload, timeout=5)
            if resp.status_code == 200:
                logger.info(f"[{self.name}] Successfully logged event for {employee_id} on Node server")
            else:
                logger.error(f"[{self.name}] Node server rejected event ({resp.status_code}): {resp.text}")
        except Exception as e:
            logger.error(f"[{self.name}] Failed to report attendance to Node server: {e}")

    def stop_capture(self):
        self.running = False


def start_cctv_thread(camera_id, name, source, site_name, event_type, threshold=0.55, node_server="http://localhost:3000"):
    with active_cameras_lock:
        if camera_id in active_cameras:
            # If already running, stop it first
            logger.info(f"Camera thread {camera_id} is already running. Stopping it...")
            active_cameras[camera_id].stop_capture()
            active_cameras[camera_id].join(timeout=2.0)
            del active_cameras[camera_id]
            
        processor = CCTVStreamProcessor(camera_id, name, source, site_name, event_type, threshold, node_server)
        processor.daemon = True
        processor.start()
        active_cameras[camera_id] = processor
        logger.info(f"Started CCTV background thread for camera {camera_id}")
        return True

def stop_cctv_thread(camera_id):
    with active_cameras_lock:
        if camera_id in active_cameras:
            processor = active_cameras[camera_id]
            processor.stop_capture()
            processor.join(timeout=2.0)
            del active_cameras[camera_id]
            logger.info(f"Stopped CCTV thread for camera {camera_id}")
            return True
        return False

def get_cctv_status():
    with active_cameras_lock:
        status = {}
        for cam_id, proc in active_cameras.items():
            status[cam_id] = {
                'camera_id': cam_id,
                'name': proc.name,
                'source': proc.source,
                'running': proc.running and proc.is_alive()
            }
        return status
