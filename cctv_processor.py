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
    def __init__(self, camera_id, name, source, site_name, event_type, threshold=0.62, node_server="http://localhost:3000"):
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
        self.consecutive_detections = {}  # { employee_id: count }
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
                # Process every 0.3 seconds to match fast-passing employees
                time.sleep(0.3)
                
                frame = self.latest_frame
                if frame is None:
                    continue
                
                # Downscale the frame to a max dimension of 480px for faster processing
                h, w = frame.shape[:2]
                max_size = 480
                if max(h, w) > max_size:
                    scale = max_size / max(h, w)
                    frame = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
                
                # Perform face recognition directly using the raw numpy BGR frame array
                results = model.recognize_faces(frame, threshold=self.threshold)
                
                detected_employee_ids = set()
                
                if results:
                    jpg_as_text = None
                    for employee_id, confidence in results:
                        detected_employee_ids.add(employee_id)
                        
                        # Check cool-down per employee
                        now = time.time()
                        last_seen = self.cooldowns.get(employee_id, 0)
                        if now - last_seen < self.cooldown_seconds:
                            logger.debug(f"[{self.name}] Matched {employee_id} but cool-down is active")
                            continue
                        
                        # Increment consecutive frames count
                        current_count = self.consecutive_detections.get(employee_id, 0) + 1
                        self.consecutive_detections[employee_id] = current_count
                        logger.info(f"[{self.name}] Face detected: {employee_id} (confidence: {confidence:.3f}), consecutive frames: {current_count}/3")
                        
                        if current_count >= 3:
                            # Reset consecutive count after reporting
                            self.consecutive_detections[employee_id] = 0
                            
                            # Update cool-down
                            self.cooldowns[employee_id] = now
                            logger.info(f"[{self.name}] Face recognized (3 consecutive frames): {employee_id} (confidence: {confidence:.3f})")
                            
                            # Convert the matching frame to base64 ONLY when reporting
                            if jpg_as_text is None:
                                _, buffer = cv2.imencode('.jpg', frame)
                                jpg_as_text = base64.b64encode(buffer).decode('utf-8')
                            
                            # Post recognized CCTV event to the Node.js server
                            self.report_attendance(employee_id, confidence, jpg_as_text)

                # Reset consecutive count for any employee not detected in this frame
                for emp_id in list(self.consecutive_detections.keys()):
                    if emp_id not in detected_employee_ids:
                        self.consecutive_detections[emp_id] = 0
                        
            except ValueError:
                # Silence common "No face detected" errors
                pass
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


def start_cctv_thread(camera_id, name, source, site_name, event_type, threshold=0.62, node_server="http://localhost:3000"):
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
