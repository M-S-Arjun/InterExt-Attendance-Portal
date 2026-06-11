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

# Shared dictionary to store pending entry/exit events for correlation
# Key: employee_id, Value: { "type": "entry"|"exit", "timestamp": float, "camera_id": str, "employee_name": str, "confidence": float }
pending_correlations = {}
pending_correlations_lock = threading.Lock()

# ==========================================================================
# GEOMETRY HELPERS FOR LINE CROSSING DETECTION
# ==========================================================================

def on_segment(p, q, r):
    """Check if point q lies on line segment 'pr'"""
    if (q[0] <= max(p[0], r[0]) and q[0] >= min(p[0], r[0]) and
        q[1] <= max(p[1], r[1]) and q[1] >= min(p[1], r[1])):
        return True
    return False

def orientation(p, q, r):
    """
    Find orientation of ordered triplet (p, q, r).
    Returns:
        0 -> Collinear
        1 -> Clockwise
        2 -> Counterclockwise
    """
    val = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1])
    if val == 0:
        return 0
    return 1 if val > 0 else 2

def segments_intersect(p1, p2, q1, q2):
    """Check if line segment p1p2 and q1q2 intersect"""
    o1 = orientation(p1, p2, q1)
    o2 = orientation(p1, p2, q2)
    o3 = orientation(q1, q2, p1)
    o4 = orientation(q1, q2, p2)

    # General Case
    if o1 != o2 and o3 != o4:
        return True

    # Special Cases (Collinear segments)
    if o1 == 0 and on_segment(p1, q1, p2): return True
    if o2 == 0 and on_segment(p1, q2, p2): return True
    if o3 == 0 and on_segment(q1, p1, q2): return True
    if o4 == 0 and on_segment(q1, p2, q2): return True

    return False

def crossing_direction(l1, l2, t_prev, t_curr):
    """
    Determine crossing direction relative to vector L1 -> L2.
    Vector cross product defines side transitions.
    """
    v1 = (l2[0] - l1[0], l2[1] - l1[1])
    v2 = (t_curr[0] - t_prev[0], t_curr[1] - t_prev[1])
    cross_z = v1[0] * v2[1] - v1[1] * v2[0]
    return "entry" if cross_z > 0 else "exit"


# ==========================================================================
# CCTV STREAM PROCESSOR WITH ADVANCED SEQUENCE STATE MACHINE
# ==========================================================================

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
        
        # Centroid tracker details (Multi-target face tracking)
        self.tracks = {}  # { track_id: { "centroids": [], "bboxes": [], "emp_id": None, "confidence": 0.0, "frames_active": 0, "last_seen_time": float, "liveness_passed": bool, "motion_verified": bool, "approaching": bool, "door_open_seen": bool, "crossed": bool, "crossing_time": float, "crossing_direction": str } }
        self.next_track_id = 0
        self.max_disappeared_seconds = 1.5
        self.cooldowns = {}  # { employee_id: timestamp }
        self.cooldown_seconds = 15  # Cooldown to prevent double triggers
        
        # Door opening/closing detection state
        self.door_baseline = None
        self.door_state = "closed"  # "closed", "opening", "open", "closing"
        
        # Background subtractor for correlation motion tracking
        self.bg_subtractor = cv2.createBackgroundSubtractorMOG2(history=150, varThreshold=25, detectShadows=False)
        self.motion_tracks = {}
        self.next_motion_id = 0
        
        # Parse source if it's a webcam index (e.g. "0" -> 0)
        try:
            if str(source).isdigit():
                self.source = int(source)
        except Exception:
            pass

    def check_correlation_mode(self):
        with active_cameras_lock:
            for cam_id, proc in active_cameras.items():
                if cam_id != self.camera_id and proc.site_name == self.site_name:
                    if (self.event_type == 'entry' and proc.event_type == 'exit') or \
                       (self.event_type == 'exit' and proc.event_type == 'entry'):
                        return True
        return False

    def run(self):
        self.running = True
        logger.info(f"[{self.name}] Starting professional sequence-state stream capture on: {self.source}")
        
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
                    time.sleep(0.1)
                    continue
                self.latest_frame = frame

        self.grab_thread = threading.Thread(target=grab_loop, daemon=True)
        self.grab_thread.start()

        # Import face recognition model initialization
        from face_recognition_service import initialize_model
        model = initialize_model()

        while self.running:
            try:
                # Process frames every 0.15 seconds for continuous high-speed tracking
                time.sleep(0.15)
                
                frame = self.latest_frame
                if frame is None:
                    continue
                
                # Downscale for performance efficiency
                h, w = frame.shape[:2]
                max_size = 480
                if max(h, w) > max_size:
                    scale = max_size / max(h, w)
                    frame = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
                    h, w = frame.shape[:2]

                correlation_mode = self.check_correlation_mode()
                
                # 1. Update Door State Estimation using running averages of the central 40% region
                if not correlation_mode:
                    self.detect_door_state(frame)
                
                # 2. Detect all faces in current frame via InsightFace
                faces = model.app.get(frame)
                
                detections = []
                for face in faces:
                    bbox = face.bbox  # [x1, y1, x2, y2]
                    x1, y1, x2, y2 = map(int, bbox)
                    cx = int((x1 + x2) / 2)
                    cy = int((y1 + y2) / 2)
                    
                    # Face recognition comparison
                    emp_id = None
                    confidence = 0.0
                    if face.embedding is not None and model.embeddings_db:
                        embedding = face.embedding / np.linalg.norm(face.embedding)
                        best_match = None
                        best_score = 0
                        for e_id, e_embed in model.embeddings_db.items():
                            similarity = np.dot(embedding, e_embed)
                            if similarity > best_score:
                                best_score = similarity
                                best_match = e_id
                        
                        if best_score >= self.threshold:
                            emp_id = best_match
                            confidence = float(best_score)
                    
                    # Liveness Check: Texture variance analysis (Laplacian Var)
                    liveness = False
                    if x2 > x1 and y2 > y1:
                        face_crop = frame[max(0, y1):min(h, y2), max(0, x1):min(w, x2)]
                        if face_crop.size > 0:
                            gray_crop = cv2.cvtColor(face_crop, cv2.COLOR_BGR2GRAY)
                            lap_var = cv2.Laplacian(gray_crop, cv2.CV_64F).var()
                            if lap_var > 80.0:  # Real facial structure frequency threshold
                                liveness = True
                    
                    detections.append({
                        "bbox": bbox,
                        "centroid": (cx, cy),
                        "emp_id": emp_id,
                        "confidence": confidence,
                        "liveness": liveness
                    })
                
                # 3. Update tracker and sequence state machine with current detections
                self.update_tracker(detections, frame)
                
                # 4. If in correlation mode, track motion blobs
                if correlation_mode:
                    self.detect_motion_and_track(frame, time.time())
                
            except Exception as e:
                logger.error(f"[{self.name}] Error in processing loop: {e}")
                traceback.print_exc()

        # Cleanup
        logger.info(f"[{self.name}] Stopping stream capture")
        self.running = False
        cap.release()

    def detect_door_state(self, frame):
        """Estimate door state based on image diffs in the central ROI area"""
        h, w = frame.shape[:2]
        
        # Door region of interest (central 40% of the frame)
        door_y1, door_y2 = int(h * 0.3), int(h * 0.7)
        door_x1, door_x2 = int(w * 0.3), int(w * 0.7)
        door_roi = frame[door_y1:door_y2, door_x1:door_x2]
        
        gray_roi = cv2.cvtColor(door_roi, cv2.COLOR_BGR2GRAY)
        gray_roi = cv2.GaussianBlur(gray_roi, (21, 21), 0)
        
        if self.door_baseline is None:
            self.door_baseline = gray_roi
            self.door_state = "closed"
        else:
            # Calculate visual change compared to baseline
            frame_delta = cv2.absdiff(self.door_baseline, gray_roi)
            thresh = cv2.threshold(frame_delta, 25, 255, cv2.THRESH_BINARY)[1]
            change_pct = (np.sum(thresh == 255) / thresh.size) * 100.0
            
            # Slowly update running average baseline to absorb environmental light changes
            cv2.addWeighted(self.door_baseline, 0.98, gray_roi, 0.02, 0, self.door_baseline)
            
            # Estimate state transition
            if change_pct > 8.0:
                if self.door_state == "closed":
                    self.door_state = "opening"
                    logger.info(f"[{self.name}] [Sequence] Door state: closed -> opening (diff: {change_pct:.1f}%)")
                elif self.door_state == "opening" and change_pct > 15.0:
                    self.door_state = "open"
                    logger.info(f"[{self.name}] [Sequence] Door state: opening -> open (diff: {change_pct:.1f}%)")
            else:
                if self.door_state in ("opening", "open"):
                    self.door_state = "closing"
                    logger.info(f"[{self.name}] [Sequence] Door state: open -> closing (diff: {change_pct:.1f}%)")
                elif self.door_state == "closing":
                    self.door_state = "closed"
                    logger.info(f"[{self.name}] [Sequence] Door state: closing -> closed (stable baseline restored)")

    def update_tracker(self, detections, frame):
        now = time.time()
        
        # If no active tracks, register all detections
        if len(self.tracks) == 0:
            for det in detections:
                self.register_track(det, now)
            return

        track_ids = list(self.tracks.keys())
        track_centroids = [self.tracks[tid]["centroids"][-1] for tid in track_ids]

        matched_detections = set()
        matched_tracks = set()

        # Centroid distance mapping (ByteTrack-style tracking)
        for det_idx, det in enumerate(detections):
            det_centroid = det["centroid"]
            min_dist = float('inf')
            best_track_idx = -1
            
            for t_idx, t_centroid in enumerate(track_centroids):
                dist = np.linalg.norm(np.array(det_centroid) - np.array(t_centroid))
                if dist < min_dist:
                    min_dist = dist
                    best_track_idx = t_idx
            
            # Match if centroid distance is within 80 pixels
            if min_dist < 80.0 and best_track_idx != -1:
                tid = track_ids[best_track_idx]
                if tid not in matched_tracks:
                    self.update_track(tid, det, now, frame)
                    matched_detections.add(det_idx)
                    matched_tracks.add(tid)

        # Register unmatched detections as new tracks
        for det_idx, det in enumerate(detections):
            if det_idx not in matched_detections:
                self.register_track(det, now)

        # Delete expired tracks or evaluate fallback logs for crossed targets
        for tid in track_ids:
            if tid not in matched_tracks:
                disappeared_duration = now - self.tracks[tid]["last_seen_time"]
                
                # Fallback: if they crossed but disappeared before door close, confirm event anyway (fail-safe)
                if self.tracks[tid]["crossed"]:
                    self.confirm_attendance_event(tid, frame)
                    del self.tracks[tid]
                elif disappeared_duration >= self.max_disappeared_seconds:
                    logger.debug(f"[{self.name}] Expiring track {tid}")
                    del self.tracks[tid]

    def register_track(self, det, now):
        tid = self.next_track_id
        self.next_track_id += 1
        self.tracks[tid] = {
            "centroids": [det["centroid"]],
            "bboxes": [det["bbox"]],
            "emp_id": det["emp_id"],
            "confidence": det["confidence"],
            "frames_active": 1,
            "last_seen_time": now,
            "liveness_passed": det["liveness"],
            "motion_verified": False,
            
            # Sequence state tracker variables
            "approaching": False,
            "door_open_seen": False,
            "crossed": False,
            "crossing_time": 0.0,
            "crossing_direction": ""
        }
        logger.debug(f"[{self.name}] Registered new face track {tid}")

    def is_approaching_line(self, centroids, h):
        """Check if centroid coordinates are moving towards the middle line"""
        if len(centroids) < 2:
            return False
        line_y = h * 0.5
        prev_dist = abs(centroids[-2][1] - line_y)
        curr_dist = abs(centroids[-1][1] - line_y)
        return curr_dist < prev_dist and curr_dist < 80.0

    def update_track(self, tid, det, now, frame):
        track = self.tracks[tid]
        prev_centroid = track["centroids"][-1]
        curr_centroid = det["centroid"]

        # Virtual line settings (Horizontal line across the exact center of frame)
        h, w = frame.shape[:2]
        p1 = (0, int(h * 0.5))
        p2 = (w, int(h * 0.5))

        track["centroids"].append(curr_centroid)
        track["bboxes"].append(det["bbox"])
        track["frames_active"] += 1
        track["last_seen_time"] = now

        # Update identity if matched in this frame
        if det["emp_id"] is not None:
            track["emp_id"] = det["emp_id"]
            track["confidence"] = det["confidence"]
        
        if det["liveness"]:
            track["liveness_passed"] = True

        # Anti-Spoofing: Motion Verification
        if len(track["centroids"]) >= 3:
            xs = [c[0] for c in track["centroids"]]
            ys = [c[1] for c in track["centroids"]]
            std_x = np.std(xs)
            std_y = np.std(ys)
            if std_x > 0.4 or std_y > 0.4:
                track["motion_verified"] = True

        if len(track["centroids"]) > 15:
            track["centroids"].pop(0)
            track["bboxes"].pop(0)

        # ==========================================================================
        # MULTI-STAGE STATE MACHINE SEQUENCE LOGIC
        # ==========================================================================
        
        # 1. Detect Approaching State
        if self.is_approaching_line(track["centroids"], h):
            if not track["approaching"]:
                track["approaching"] = True
                logger.info(f"[{self.name}] [Sequence] Step 1/4: Employee {track['emp_id'] or 'unknown'} approaching door.")

        # 2. Detect Door Opening State
        if track["approaching"] and (self.door_state in ("opening", "open")):
            if not track["door_open_seen"]:
                track["door_open_seen"] = True
                logger.info(f"[{self.name}] [Sequence] Step 2/4: Door opening observed for approaching employee {track['emp_id'] or 'unknown'}.")

        correlation_mode = self.check_correlation_mode()

        # 3. Detect Line Crossing State
        if segments_intersect(p1, p2, prev_centroid, curr_centroid):
            direction = crossing_direction(p1, p2, prev_centroid, curr_centroid)
            track["crossed"] = True
            track["crossing_direction"] = direction
            track["crossing_time"] = now
            logger.info(f"[{self.name}] [Sequence] Step 3/4: Bbox crossed virtual line. Direction: {direction}")
            
            if correlation_mode:
                emp_id = track["emp_id"]
                if emp_id:
                    liveness_passed = track["liveness_passed"]
                    motion_verified = track.get("motion_verified", False)
                    
                    if not liveness_passed:
                        logger.warning(f"[{self.name}] [Correlation Rejected] {emp_id} failed texture liveness check.")
                        track["crossed"] = False
                    elif not motion_verified:
                        logger.warning(f"[{self.name}] [Correlation Rejected] {emp_id} coordinates are static (no micro-movement).")
                        track["crossed"] = False
                    else:
                        target_type = None
                        if self.event_type == 'entry' and direction == 'entry':
                            target_type = 'entry'
                        elif self.event_type == 'exit' and direction == 'exit':
                            target_type = 'exit'
                            
                        if target_type:
                            with pending_correlations_lock:
                                pending_correlations[emp_id] = {
                                    "type": target_type,
                                    "timestamp": now,
                                    "camera_id": self.camera_id,
                                    "employee_name": emp_id,
                                    "confidence": track["confidence"]
                                }
                            logger.info(f"[{self.name}] [CORRELATION REGISTERED] Registered pending {target_type} for {emp_id}")
                            track["crossed"] = False  # Reset to prevent double registering
                            track["approaching"] = False
                            track["door_open_seen"] = False
                else:
                    logger.warning(f"[{self.name}] Line crossed but face not recognized yet.")

        # 4. Detect Door Closing & Confirm Event (Step 4/4)
        if not correlation_mode and track["crossed"]:
            time_since_crossing = now - track["crossing_time"]
            
            # Transition triggers on door close, OR automatically after 5s as a fail-safe
            if self.door_state == "closed":
                logger.info(f"[{self.name}] [Sequence] Step 4/4: Door closed. Event confirmed.")
                self.confirm_attendance_event(tid, frame)
            elif time_since_crossing >= 5.0:
                logger.info(f"[{self.name}] [Sequence] Step 4/4: Door close timeout (5s). Event confirmed via fallback.")
                self.confirm_attendance_event(tid, frame)

    def confirm_attendance_event(self, tid, frame):
        track = self.tracks[tid]
        emp_id = track["emp_id"]
        confidence = track["confidence"]
        direction = track["crossing_direction"]

        # Reset crossing flags to prevent duplicate loops
        track["crossed"] = False
        track["approaching"] = False
        track["door_open_seen"] = False

        if not emp_id:
            logger.info(f"[{self.name}] [Sequence Rejected] Target crossed but could not be mapped to employee database.")
            return

        # Anti-spoofing validation (Liveness + Motion checks)
        if not track["liveness_passed"]:
            logger.warning(f"[{self.name}] [Sequence Rejected] Blocked spoofing attempt: {emp_id} failed texture liveness check.")
            return
        
        if not track.get("motion_verified", False):
            logger.warning(f"[{self.name}] [Sequence Rejected] Blocked spoofing attempt: {emp_id} coordinates are static (no micro-movement).")
            return

        # Cooldown check
        now = time.time()
        last_seen = self.cooldowns.get(emp_id, 0)
        if now - last_seen < self.cooldown_seconds:
            logger.debug(f"[{self.name}] Cooldown active for {emp_id}. Skipping confirmation.")
            return
        
        self.cooldowns[emp_id] = now

        # Map direction based on camera config
        resolved_event = self.event_type
        if resolved_event == 'auto':
            resolved_event = direction

        logger.info(f"[{self.name}] [SEQUENCE VERIFIED & CONFIRMED] Employee {emp_id} attendance logged. Event: {resolved_event}")

        # Render visual bounding boxes, vector lines, and trajectory history on the frame for auditing
        audit_frame = frame.copy()
        h, w = frame.shape[:2]
        p1 = (0, int(h * 0.5))
        p2 = (w, int(h * 0.5))
        
        # Draw virtual line (Red)
        cv2.line(audit_frame, p1, p2, (0, 0, 255), 3)
        cv2.putText(audit_frame, "VIRTUAL ATTENDANCE LINE", (10, p1[1] - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)

        # Draw current face bounding box
        bbox = track["bboxes"][-1]
        x1, y1, x2, y2 = map(int, bbox)
        cv2.rectangle(audit_frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.putText(audit_frame, f"{emp_id} ({confidence*100:.1f}%)", (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)

        # Draw trajectory history line
        for i in range(1, len(track["centroids"])):
            c_prev = tuple(map(int, track["centroids"][i-1]))
            c_curr = tuple(map(int, track["centroids"][i]))
            cv2.line(audit_frame, c_prev, c_curr, (255, 255, 0), 2)
            cv2.circle(audit_frame, c_curr, 4, (0, 255, 255), -1)

        # Encode frame to base64
        _, buffer = cv2.imencode('.jpg', audit_frame)
        jpg_as_text = base64.b64encode(buffer).decode('utf-8')

        # Report to Node server
        self.report_attendance(emp_id, confidence, jpg_as_text, resolved_event)

    def report_attendance(self, employee_id, confidence, image_base64_raw, event_type=None, status=None):
        try:
            url = f"{self.node_server}/api/face/cctv-event"
            payload = {
                'employee_id': employee_id,
                'confidence': confidence,
                'camera_id': self.camera_id,
                'camera_name': self.name,
                'site_name': self.site_name,
                'event_type': event_type or self.event_type,
                'status': status,
                'image_base64': image_base64_raw
            }
            resp = requests.post(url, json=payload, timeout=5)
            if resp.status_code == 200:
                logger.info(f"[{self.name}] Successfully logged event for {employee_id} ({event_type or self.event_type}) on Node server")
            else:
                logger.error(f"[{self.name}] Node server rejected event ({resp.status_code}): {resp.text}")
        except Exception as e:
            logger.error(f"[{self.name}] Failed to report attendance to Node server: {e}")

    def detect_motion_and_track(self, frame, now):
        # 1. Apply background subtraction
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (21, 21), 0)
        fg_mask = self.bg_subtractor.apply(gray)
        _, fg_mask = cv2.threshold(fg_mask, 25, 255, cv2.THRESH_BINARY)
        fg_mask = cv2.dilate(fg_mask, None, iterations=2)
        
        contours, _ = cv2.findContours(fg_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        detections = []
        for c in contours:
            area = cv2.contourArea(c)
            if area > 2000:  # Minimum size for a person
                (x, y, w, h) = cv2.boundingRect(c)
                cx = int(x + w / 2)
                cy = int(y + h / 2)
                detections.append({
                    "bbox": [x, y, x + w, y + h],
                    "centroid": (cx, cy)
                })
        
        # 2. Update motion tracks
        self.update_motion_tracks(detections, now, frame)

    def register_motion_track(self, det, now):
        tid = self.next_motion_id
        self.next_motion_id += 1
        self.motion_tracks[tid] = {
            "centroids": [det["centroid"]],
            "bboxes": [det["bbox"]],
            "last_seen_time": now,
            "crossed": False
        }

    def update_single_motion_track(self, tid, det, now, frame):
        track = self.motion_tracks[tid]
        prev_centroid = track["centroids"][-1]
        curr_centroid = det["centroid"]
        
        track["centroids"].append(curr_centroid)
        track["bboxes"].append(det["bbox"])
        track["last_seen_time"] = now
        
        if len(track["centroids"]) > 15:
            track["centroids"].pop(0)
            track["bboxes"].pop(0)

        h, w = frame.shape[:2]
        p1 = (0, int(h * 0.5))
        p2 = (w, int(h * 0.5))

        # Check line crossing
        if not track["crossed"] and segments_intersect(p1, p2, prev_centroid, curr_centroid):
            direction = crossing_direction(p1, p2, prev_centroid, curr_centroid)
            track["crossed"] = True
            
            # Correlation Logic!
            self.correlate_motion_crossing(tid, direction, frame, now)

    def update_motion_tracks(self, detections, now, frame):
        if len(self.motion_tracks) == 0:
            for det in detections:
                self.register_motion_track(det, now)
            return

        track_ids = list(self.motion_tracks.keys())
        track_centroids = [self.motion_tracks[tid]["centroids"][-1] for tid in track_ids]

        matched_detections = set()
        matched_tracks = set()

        for det_idx, det in enumerate(detections):
            det_centroid = det["centroid"]
            min_dist = float('inf')
            best_track_idx = -1
            
            for t_idx, t_centroid in enumerate(track_centroids):
                dist = np.linalg.norm(np.array(det_centroid) - np.array(t_centroid))
                if dist < min_dist:
                    min_dist = dist
                    best_track_idx = t_idx
            
            if min_dist < 100.0 and best_track_idx != -1:
                tid = track_ids[best_track_idx]
                if tid not in matched_tracks:
                    self.update_single_motion_track(tid, det, now, frame)
                    matched_detections.add(det_idx)
                    matched_tracks.add(tid)

        for det_idx, det in enumerate(detections):
            if det_idx not in matched_detections:
                self.register_motion_track(det, now)

        for tid in track_ids:
            if tid not in matched_tracks:
                disappeared_duration = now - self.motion_tracks[tid]["last_seen_time"]
                if disappeared_duration >= self.max_disappeared_seconds:
                    del self.motion_tracks[tid]

    def correlate_motion_crossing(self, tid, direction, frame, now):
        camera_role = self.event_type  # 'entry' = Outside, 'exit' = Inside
        
        target_direction = None
        correlation_type = None
        if camera_role == 'entry' and direction == 'exit':
            target_direction = 'exit'
            correlation_type = 'exit'
        elif camera_role == 'exit' and direction == 'entry':
            target_direction = 'entry'
            correlation_type = 'entry'
            
        if not target_direction:
            return
            
        matched_emp_id = None
        matched_event = None
        
        with pending_correlations_lock:
            expired_keys = []
            for emp_id, event in pending_correlations.items():
                if now - event["timestamp"] > 5.0:
                    expired_keys.append(emp_id)
                    continue
                    
                if event["type"] == correlation_type:
                    matched_emp_id = emp_id
                    matched_event = event
                    break
                    
            for k in expired_keys:
                del pending_correlations[k]
                
            if matched_emp_id:
                del pending_correlations[matched_emp_id]

        if matched_emp_id:
            logger.info(f"[{self.name}] [CORRELATION SUCCESS] Matched motion crossing with pending {correlation_type} for {matched_emp_id}")
            self.confirm_correlated_attendance(matched_emp_id, matched_event["employee_name"], matched_event["confidence"], correlation_type, frame)
        else:
            logger.warning(f"[{self.name}] [CORRELATION FAILED] Motion crossing detected in {direction} direction, but no pending {correlation_type} event found within 5 seconds.")

    def confirm_correlated_attendance(self, emp_id, employee_name, confidence, event_type, frame):
        audit_frame = frame.copy()
        h, w = frame.shape[:2]
        p1 = (0, int(h * 0.5))
        p2 = (w, int(h * 0.5))
        
        cv2.line(audit_frame, p1, p2, (0, 0, 255), 3)
        cv2.putText(audit_frame, "CORRELATION VIRTUAL LINE", (10, p1[1] - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)

        # Draw a semi-transparent correlation verification box
        overlay = audit_frame.copy()
        cv2.rectangle(overlay, (10, 10), (320, 115), (0, 0, 0), -1)
        cv2.addWeighted(overlay, 0.6, audit_frame, 0.4, 0, audit_frame)
        
        cv2.rectangle(audit_frame, (10, 10), (320, 115), (0, 255, 255), 1)
        
        cv2.putText(audit_frame, f"DUAL-CAMERA CORRELATION ({event_type.upper()})", (15, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1, cv2.LINE_AA)
        
        cv2.putText(audit_frame, f"[OK] 1. Face Recognized on opposite Cam", (20, 48), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1, cv2.LINE_AA)
        cv2.putText(audit_frame, f"     Employee: {emp_id}", (20, 64), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (200, 200, 200), 1, cv2.LINE_AA)
        cv2.putText(audit_frame, f"[OK] 2. Motion Confirmed on this Cam", (20, 84), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1, cv2.LINE_AA)
        cv2.putText(audit_frame, f"[OK] 3. Time Correlated (Match < 5s)", (20, 104), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1, cv2.LINE_AA)

        # Encode frame to base64
        _, buffer = cv2.imencode('.jpg', audit_frame)
        jpg_as_text = base64.b64encode(buffer).decode('utf-8')

        status_text = f"Verified Correlated {event_type.capitalize()}"

        self.report_attendance(emp_id, confidence, jpg_as_text, event_type, status_text)

    def stop_capture(self):
        self.running = False


def start_cctv_thread(camera_id, name, source, site_name, event_type, threshold=0.62, node_server="http://localhost:3000"):
    with active_cameras_lock:
        if camera_id in active_cameras:
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
