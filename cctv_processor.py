import os
import cv2
import time
import threading
import requests
import numpy as np
import base64
import logging
import traceback
try:
    from scipy.optimize import linear_sum_assignment
    _HAS_SCIPY = True
except ImportError:
    _HAS_SCIPY = False
    logger_bootstrap = logging.getLogger(__name__)
    logger_bootstrap.warning("scipy not available — falling back to greedy centroid matching")

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
    def __init__(self, camera_id, name, source, site_name, event_type, threshold=0.52, node_server="http://localhost:3000"):
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
        self.max_disappeared_seconds = 3.5   # Raised from 1.5s — people take 2-4s to walk through
        self.cooldowns = {}  # { employee_id: timestamp }
        self.cooldown_seconds = 8  # Reduced from 15s — allow natural re-entry/exit
        
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
        # Disable Dual-Camera Correlation Mode completely to prevent silent skips and drops.
        # Each camera is physically positioned for a specific direction (Entrance vs Exit)
        # and should operate independently.
        return False


    def run(self):
        self.running = True
        logger.info(f"[{self.name}] Starting professional sequence-state stream capture on: {self.source}")
        
        if isinstance(self.source, int):
            cap = cv2.VideoCapture(self.source)
        else:
            # Disable TLS certificate verification for self-signed certificates
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "tls_verify;0"
            cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG)
            
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
                # Adaptive sleep: 0.15s when idle, 0.05s when active tracks are present
                if len(self.tracks) > 0:
                    time.sleep(0.05)
                else:
                    time.sleep(0.15)
                
                frame = self.latest_frame
                if frame is None:
                    continue
                
                # We no longer downscale the frame in Python, as InsightFace's detector
                # internally handles resizing to 480x480 for detection speed, but crops the
                # face from the original high-resolution frame. This preserves high-quality
                # face crops for recognition, vastly increasing similarity matching scores.
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
                    
                    # ROI filter flag: Exclude left 35% of the frame (workspace area) for Entrance CCTV 1
                    is_roi_ignored = False
                    if "Entrance CCTV 1" in self.name and cx < w * 0.35:
                        is_roi_ignored = True
                    
                    # Vectorized face recognition: build employee matrix once per frame batch
                    # and compute all similarity scores in a single matmul (O(N) instead of O(N*M))
                    emp_id = None
                    confidence = 0.0
                    if face.embedding is not None and model.embeddings_db:
                        embedding = face.embedding / np.linalg.norm(face.embedding)

                        # Rebuild embedding matrix cache if DB changed
                        db_len = len(model.embeddings_db)
                        if getattr(self, "_emb_matrix_len", -1) != db_len:
                            emb_ids = list(model.embeddings_db.keys())
                            emb_mat = np.array(list(model.embeddings_db.values()), dtype=np.float32)  # shape: (N, D)
                            self._emb_ids = emb_ids
                            self._emb_mat = emb_mat
                            self._emb_matrix_len = db_len

                        # Single matrix multiply gives scores for ALL employees at once
                        scores = self._emb_mat @ embedding  # shape: (N,)
                        best_idx = int(np.argmax(scores))
                        best_score = float(scores[best_idx])
                        best_match = self._emb_ids[best_idx]

                        if best_score >= self.threshold:
                            emp_id = best_match
                            confidence = best_score
                            logger.info(f"[{self.name}] Face recognized: {emp_id} (score: {best_score:.3f}, threshold: {self.threshold})")
                        else:
                            logger.info(f"[{self.name}] Face unrecognized: best match {best_match} (score: {best_score:.3f}, threshold: {self.threshold})")
                    
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
                        "liveness": liveness,
                        "roi_ignored": is_roi_ignored
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
        
        # If no active tracks, register all detections as new tracks
        if len(self.tracks) == 0:
            for det in detections:
                self.register_track(det, now, frame)
            return

        track_ids = list(self.tracks.keys())
        track_centroids = [self.tracks[tid]["centroids"][-1] for tid in track_ids]

        matched_detections = set()
        matched_tracks = set()

        # ── Hungarian Algorithm: Optimal 1-to-1 assignment ─────────────────────
        # Builds a cost matrix of shape (num_detections × num_tracks) and finds
        # the globally optimal match so each detection → at most 1 track and
        # each track → at most 1 detection. Handles 3-5 simultaneous people.
        MATCH_THRESHOLD = 120.0  # pixels — tight to correctly isolate multiple people in the same frame

        if len(detections) > 0 and len(track_ids) > 0:
            cost_matrix = np.zeros((len(detections), len(track_ids)), dtype=np.float32)
            for d_idx, det in enumerate(detections):
                dc = np.array(det["centroid"], dtype=np.float32)
                det_emp = det.get("emp_id")
                for t_idx, tc in enumerate(track_centroids):
                    tid = track_ids[t_idx]
                    track_emp = self.tracks[tid].get("best_emp_id")
                    # Prevent matching different recognized employees
                    if det_emp and track_emp and det_emp != track_emp:
                        cost_matrix[d_idx, t_idx] = 999999.0
                    else:
                        cost_matrix[d_idx, t_idx] = np.linalg.norm(dc - np.array(tc, dtype=np.float32))

            if _HAS_SCIPY:
                # Optimal assignment via Hungarian algorithm
                row_ind, col_ind = linear_sum_assignment(cost_matrix)
                assignments = list(zip(row_ind, col_ind))
            else:
                # Greedy fallback (original behaviour)
                assignments = []
                used_tracks = set()
                for d_idx in range(len(detections)):
                    best_t = int(np.argmin(cost_matrix[d_idx]))
                    if best_t not in used_tracks:
                        assignments.append((d_idx, best_t))
                        used_tracks.add(best_t)

            for d_idx, t_idx in assignments:
                if cost_matrix[d_idx, t_idx] < MATCH_THRESHOLD:
                    tid = track_ids[t_idx]
                    self.update_track(tid, detections[d_idx], now, frame)
                    matched_detections.add(d_idx)
                    matched_tracks.add(tid)

        # Register every unmatched detection as a brand-new independent track
        # Guard: limit max concurrent tracks to 8 to prevent memory exhaustion
        MAX_CONCURRENT_TRACKS = 8
        for det_idx, det in enumerate(detections):
            if det_idx not in matched_detections:
                if det.get("roi_ignored", False):
                    logger.info(f"[{self.name}] Skipping registration of new track in ignored ROI area at centroid {det['centroid']}")
                    continue
                if len(self.tracks) >= MAX_CONCURRENT_TRACKS:
                    logger.warning(f"[{self.name}] Max concurrent tracks ({MAX_CONCURRENT_TRACKS}) reached. Dropping new detection.")
                    continue
                self.register_track(det, now, frame)

        # Expire or confirm unmatched tracks
        for tid in list(track_ids):
            if tid not in matched_tracks:
                if tid not in self.tracks:
                    continue  # Already deleted
                disappeared_duration = now - self.tracks[tid]["last_seen_time"]

                if not self.tracks[tid].get("crossed", False) and disappeared_duration >= self.max_disappeared_seconds:
                    # Final fallback trajectory check on expiration
                    self.check_fallback_trajectory(tid, frame)

                # Immediately confirm if they already crossed (even if just disappeared)
                if self.tracks[tid].get("crossed", False):
                    if not self.tracks[tid].get("confirmed", False):
                        self.tracks[tid]["confirmed"] = True
                        self.confirm_attendance_event(tid, self.tracks[tid].get("best_frame", frame))
                    # Prevent hijacking: do not delete the track until it has actually disappeared
                    if disappeared_duration >= self.max_disappeared_seconds:
                        del self.tracks[tid]
                elif disappeared_duration >= self.max_disappeared_seconds:
                    logger.info(f"[{self.name}] Expiring uncrossed track {tid} without marking attendance.")
                    del self.tracks[tid]


    def register_track(self, det, now, frame):
        tid = self.next_track_id
        self.next_track_id += 1
        bbox = det["bbox"]
        area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
        track_min_y = det["centroid"][1]  # Track persistent min/max for y-displacement check
        track_max_y = det["centroid"][1]
        track_min_x = det["centroid"][0]
        track_max_x = det["centroid"][0]
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
            "crossing_direction": "",
            
            # Best quality tracking variables
            "best_area": area,
            "best_frame": frame.copy() if frame is not None else None,
            "best_bbox": det["bbox"],
            "best_emp_id": det["emp_id"],
            "best_confidence": det["confidence"],
            "confirmed": False,

            # Persistent extremes (survive centroid buffer trimming)
            "track_min_y": track_min_y,
            "track_max_y": track_max_y,
            "track_min_x": track_min_x,
            "track_max_x": track_max_x,
            
            # Video frames buffer
            "frames_buffer": [frame.copy()] if frame is not None else [],
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

    def check_fallback_trajectory(self, tid, frame):
        """Check if track has crossed/moved in entry/exit direction using fallback trajectory/displacement metrics."""
        track = self.tracks[tid]
        if len(track["centroids"]) < 2:
            return
            
        h, w = frame.shape[:2] if frame is not None else (720, 1280)
        is_entry_cam = 'entrance' in self.name.lower() or 'entry' in self.name.lower() or self.event_type == 'entry'
        is_exit_cam = 'exit' in self.name.lower() or self.event_type == 'exit'
        
        x_start, y_start = track["centroids"][0]
        x_end, y_end = track["centroids"][-1]
        
        p_min_y = track.get("track_min_y", y_end)
        p_max_y = track.get("track_max_y", y_end)
        p_min_x = track.get("track_min_x", x_end)
        p_max_x = track.get("track_max_x", x_end)
        
        crossed = False
        crossing_point = None
        crossing_dir = ""
        
        if track["frames_active"] < 5:
            return

        if is_entry_cam:
            y_line = int(h * 0.6)
            x_left = int(w * 0.35)
            x_right = int(w * 0.70)
            
            # Entry: track ends below/near y_line and overall downward movement (y increases)
            if y_end > y_line - 50 and (y_end - y_start > 50 or y_end - p_min_y > 50):
                crossed = True
                crossing_point = (int(x_end), y_line)
                crossing_dir = "entry"
                logger.info(f"[{self.name}] [Fallback Path] Verified entry by downward motion vector: {y_start:.1f} -> {y_end:.1f}")
            # Exit: track ends above/near y_line and overall upward movement (y decreases)
            elif y_end < y_line + 50 and (y_start - y_end > 50 or p_max_y - y_end > 50):
                crossed = True
                crossing_point = (int(x_end), y_line)
                crossing_dir = "exit"
                logger.info(f"[{self.name}] [Fallback Path] Verified exit by upward motion vector: {y_start:.1f} -> {y_end:.1f}")
            else:
                # Check horizontal displacement based on start position relative to door posts
                if 0.35 * w <= x_start <= 0.70 * w:
                    if x_start - x_end > 50:
                        crossed = True
                        crossing_point = (x_left, int(y_end))
                        crossing_dir = "entry"
                        logger.info(f"[{self.name}] [Fallback Path] Verified entry by leftward turn: {x_start:.1f} -> {x_end:.1f}")
                    elif x_end - x_start > 50:
                        crossed = True
                        crossing_point = (x_right, int(y_end))
                        crossing_dir = "entry"
                        logger.info(f"[{self.name}] [Fallback Path] Verified entry by rightward turn: {x_start:.1f} -> {x_end:.1f}")
                elif x_start < 0.35 * w:
                    if x_end - x_start > 50:
                        crossed = True
                        crossing_point = (x_left, int(y_end))
                        crossing_dir = "exit"
                        logger.info(f"[{self.name}] [Fallback Path] Verified exit by rightward movement from left: {x_start:.1f} -> {x_end:.1f}")
                elif x_start > 0.70 * w:
                    if x_start - x_end > 50:
                        crossed = True
                        crossing_point = (x_right, int(y_end))
                        crossing_dir = "exit"
                        logger.info(f"[{self.name}] [Fallback Path] Verified exit by leftward movement from right: {x_start:.1f} -> {x_end:.1f}")
                
        elif is_exit_cam:
            x_left = int(w * 0.32)
            x_right = int(w * 0.55)
            
            # Start/passed near door center region (removed restrictive p_min_y constraint)
            started_near_center = (
                (p_min_x <= x_right + 150) and (p_max_x >= x_left - 150)
            )
            
            if started_near_center:
                y_start = track["centroids"][0][1]
                y_end = track["centroids"][-1][1]
                track_min_y = track.get("track_min_y", y_start)
                track_max_y = track.get("track_max_y", y_start)
                
                downward_dist = max(y_end - y_start, y_end - track_min_y)
                upward_dist = max(y_start - y_end, track_max_y - y_end)
                
                # Check if there is any substantial movement (vertical or horizontal)
                x_start = track["centroids"][0][0]
                x_end = track["centroids"][-1][0]
                moved_horizontally = abs(x_end - x_start) > 60 or x_end < x_left or x_end > x_right
                
                if downward_dist > 65 or upward_dist > 65 or moved_horizontally:
                    crossed = True
                    crossing_point = (int(x_end), int(y_end))
                    if downward_dist > upward_dist:
                        crossing_dir = "exit"
                    else:
                        crossing_dir = "entry"
                    logger.info(f"[{self.name}] [Fallback Path] Verified {crossing_dir} by vertical trajectory: down={downward_dist:.1f}, up={upward_dist:.1f}")
                    
        if crossed:
            track["crossed"] = True
            track["crossing_time"] = time.time()
            track["crossing_point"] = crossing_point
            track["crossing_direction"] = crossing_dir

    def update_track(self, tid, det, now, frame):
        track = self.tracks[tid]
        prev_centroid = track["centroids"][-1]
        curr_centroid = det["centroid"]

        track["centroids"].append(curr_centroid)
        track["bboxes"].append(det["bbox"])
        track["frames_active"] += 1
        track["last_seen_time"] = now

        # Calculate current bounding box area
        x1, y1, x2, y2 = det["bbox"]
        area = (x2 - x1) * (y2 - y1)
        
        # If this frame has a larger face area, update the best quality frame
        if frame is not None and area > track.get("best_area", 0):
            track["best_area"] = area
            track["best_frame"] = frame.copy()
            track["best_bbox"] = det["bbox"]

        # Update best matched identity during the entire track
        if det["emp_id"] is not None:
            if track.get("best_emp_id") is None or det["confidence"] > track.get("best_confidence", 0):
                track["best_emp_id"] = det["emp_id"]
                track["best_confidence"] = det["confidence"]
        
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

        # Update persistent extremes each frame (survives buffer trimming)
        track["track_min_y"] = min(track.get("track_min_y", curr_centroid[1]), curr_centroid[1])
        track["track_max_y"] = max(track.get("track_max_y", curr_centroid[1]), curr_centroid[1])
        track["track_min_x"] = min(track.get("track_min_x", curr_centroid[0]), curr_centroid[0])
        track["track_max_x"] = max(track.get("track_max_x", curr_centroid[0]), curr_centroid[0])

        # Buffer frames for video recording
        # Cap at 180 frames (~12s at 15fps) — memory safe with multiple concurrent tracks
        if frame is not None:
            if "frames_buffer" not in track:
                track["frames_buffer"] = []
            track["frames_buffer"].append(frame.copy())
            if len(track["frames_buffer"]) > 180:
                track["frames_buffer"].pop(0)

        # Path tracking and crossing checks
        h, w = frame.shape[:2] if frame is not None else (720, 1280)
        is_entry_cam = 'entrance' in self.name.lower() or 'entry' in self.name.lower() or self.event_type == 'entry'
        is_exit_cam = 'exit' in self.name.lower() or self.event_type == 'exit'

        x_start, y_start = track["centroids"][0]
        prev_x, prev_y = prev_centroid
        curr_x, curr_y = curr_centroid

        if not track.get("crossed", False):
            crossed = False
            crossing_point = None
            crossing_dir = ""

            if is_entry_cam:
                y_line = int(h * 0.6)
                x_left = int(w * 0.35)
                x_right = int(w * 0.70)
                
                # Check 1: Horizontal crossing downwards/upwards
                if prev_y <= y_line < curr_y:
                    crossed = True
                    dy = curr_y - prev_y
                    x_intersect = prev_x + (curr_x - prev_x) * (y_line - prev_y) / dy if dy > 0 else curr_x
                    crossing_point = (int(x_intersect), y_line)
                    crossing_dir = "entry"
                elif prev_y >= y_line > curr_y:
                    crossed = True
                    dy = prev_y - curr_y
                    x_intersect = prev_x + (curr_x - prev_x) * (prev_y - y_line) / dy if dy > 0 else curr_x
                    crossing_point = (int(x_intersect), y_line)
                    crossing_dir = "exit"
                
                # Check 2: Left door post crossing (x_left)
                # Right-to-left is entry, Left-to-right is exit
                elif prev_x >= x_left and curr_x < x_left:
                    crossed = True
                    dx = prev_x - curr_x
                    y_intersect = prev_y + (curr_y - prev_y) * (x_left - curr_x) / dx if dx > 0 else curr_y
                    crossing_point = (x_left, int(y_intersect))
                    crossing_dir = "entry"
                elif prev_x <= x_left and curr_x > x_left:
                    crossed = True
                    dx = curr_x - prev_x
                    y_intersect = prev_y + (curr_y - prev_y) * (x_left - prev_x) / dx if dx > 0 else curr_y
                    crossing_point = (x_left, int(y_intersect))
                    crossing_dir = "exit"
                
                # Check 3: Right door post crossing (x_right)
                # Left-to-right is entry, Right-to-left is exit
                elif prev_x <= x_right and curr_x > x_right:
                    crossed = True
                    dx = curr_x - prev_x
                    y_intersect = prev_y + (curr_y - prev_y) * (x_right - prev_x) / dx if dx > 0 else curr_y
                    crossing_point = (x_right, int(y_intersect))
                    crossing_dir = "entry"
                elif prev_x >= x_right and curr_x < x_right:
                    crossed = True
                    dx = prev_x - curr_x
                    y_intersect = prev_y + (curr_y - prev_y) * (x_right - curr_x) / dx if dx > 0 else curr_y
                    crossing_point = (x_right, int(y_intersect))
                    crossing_dir = "exit"
                
                # Check 4: Segment intersection
                elif not crossed:
                    mv_p1 = (prev_x, prev_y)
                    mv_p2 = (curr_x, curr_y)
                    left_line_top = (x_left, 0)
                    left_line_bot = (x_left, h)
                    right_line_top = (x_right, 0)
                    right_line_bot = (x_right, h)
                    if segments_intersect(mv_p1, mv_p2, left_line_top, left_line_bot):
                        crossed = True
                        crossing_point = (x_left, curr_y)
                        crossing_dir = "entry" if curr_x < prev_x else "exit"
                    elif segments_intersect(mv_p1, mv_p2, right_line_top, right_line_bot):
                        crossed = True
                        crossing_point = (x_right, curr_y)
                        crossing_dir = "entry" if curr_x > prev_x else "exit"
            
            elif is_exit_cam:
                x_left = int(w * 0.32)
                x_right = int(w * 0.55)

                # Use persistent extremes (survive buffer trimming)
                p_min_y = track.get("track_min_y", curr_y)
                p_min_x = track.get("track_min_x", curr_x)
                p_max_x = track.get("track_max_x", curr_x)

                # Person is relevant if their path overlapped the door zone
                started_in_center = (
                    (p_min_x <= x_right + 150) and (p_max_x >= x_left - 150)
                )

                if started_in_center:
                    has_crossed_boundary = False
                    crossing_point_candidate = None

                    # ── Left line crossing ──
                    if (prev_x >= x_left and curr_x < x_left) or (prev_x <= x_left and curr_x > x_left):
                        has_crossed_boundary = True
                        dx = abs(prev_x - curr_x)
                        y_intersect = prev_y + (curr_y - prev_y) * abs(x_left - prev_x) / dx if dx > 0 else curr_y
                        crossing_point_candidate = (x_left, int(y_intersect))
                    # ── Right line crossing ──
                    elif (prev_x >= x_right and curr_x < x_right) or (prev_x <= x_right and curr_x > x_right):
                        has_crossed_boundary = True
                        dx = abs(prev_x - curr_x)
                        y_intersect = prev_y + (curr_y - prev_y) * abs(x_right - prev_x) / dx if dx > 0 else curr_y
                        crossing_point_candidate = (x_right, int(y_intersect))
                    # ── Segment intersection ──
                    else:
                        mv_p1 = (prev_x, prev_y)
                        mv_p2 = (curr_x, curr_y)
                        left_line_top = (x_left, 0)
                        left_line_bot = (x_left, h)
                        right_line_top = (x_right, 0)
                        right_line_bot = (x_right, h)
                        if segments_intersect(mv_p1, mv_p2, left_line_top, left_line_bot):
                            has_crossed_boundary = True
                            crossing_point_candidate = (x_left, curr_y)
                        elif segments_intersect(mv_p1, mv_p2, right_line_top, right_line_bot):
                            has_crossed_boundary = True
                            crossing_point_candidate = (x_right, curr_y)

                    # ── Vertical threshold crossing ──
                    y_start = track["centroids"][0][1]
                    y_end = curr_y
                    track_min_y = track.get("track_min_y", y_start)
                    track_max_y = track.get("track_max_y", y_start)

                    downward_dist = max(y_end - y_start, y_end - track_min_y)
                    upward_dist = max(y_start - y_end, track_max_y - y_end)

                    if track["frames_active"] >= 5 and (downward_dist > 65 or upward_dist > 65):
                        has_crossed_boundary = True
                        if crossing_point_candidate is None:
                            crossing_point_candidate = (curr_x, curr_y)

                    if has_crossed_boundary:
                        crossed = True
                        crossing_point = crossing_point_candidate
                        if downward_dist > upward_dist:
                            crossing_dir = "exit"
                        elif upward_dist > downward_dist:
                            crossing_dir = "entry"
                        else:
                            crossing_dir = "exit"

            if crossed:
                track["crossed"] = True
                track["crossing_time"] = now
                track["crossing_point"] = crossing_point
                track["crossing_direction"] = crossing_dir
                logger.info(f"[{self.name}] [Path Track] Verified crossing at {crossing_point} for track {tid} with direction: {crossing_dir}")

                # ── Immediate multi-person confirmation ──────────────────────────────────
                # For recognized employees: confirm instantly at the moment of line crossing
                # so that multiple people crossing simultaneously are all logged without
                # waiting for their individual tracks to expire one-by-one.
                best_emp = track.get("best_emp_id")
                if best_emp and not track.get("confirmed", False):
                    track["confirmed"] = True
                    self.confirm_attendance_event(tid, track.get("best_frame", frame))
                # Unknown visitors still confirm at track expiry (so we capture the full exit video)

        # Run fallback trajectory analysis if standard checks did not trigger
        if not track.get("crossed", False):
            self.check_fallback_trajectory(tid, frame)


    def confirm_attendance_event(self, tid, frame):
        track = self.tracks[tid]
        emp_id = track.get("best_emp_id", track["emp_id"])
        confidence = track.get("best_confidence", track["confidence"])
        bbox = track.get("best_bbox", track["bboxes"][-1])
        direction = track.get("crossing_direction", "entry")

        # Reset crossing flags to prevent duplicate loops
        track["crossed"] = False
        track["approaching"] = False
        track["door_open_seen"] = False

        is_unknown = False
        if not emp_id:
            emp_id = "unknown"
            is_unknown = True

        # Cooldown check (only for recognized employees)
        if emp_id != 'unknown':
            now = time.time()
            last_seen = self.cooldowns.get(emp_id, 0)
            if now - last_seen < self.cooldown_seconds:
                logger.debug(f"[{self.name}] Cooldown active for {emp_id}. Skipping confirmation.")
                return
            self.cooldowns[emp_id] = now

        # Resolve event based on track crossing direction
        resolved_event = track.get("crossing_direction")
        if not resolved_event or resolved_event not in ["entry", "exit"]:
            resolved_event = self.event_type
            if resolved_event == 'auto':
                # Try to determine from camera name first as it is 100% reliable
                if 'entrance' in self.name.lower() or 'entry' in self.name.lower():
                    resolved_event = 'entry'
                elif 'exit' in self.name.lower():
                    resolved_event = 'exit'
                else:
                    resolved_event = direction

        logger.info(f"[{self.name}] [CONFIRMED] Employee {emp_id} attendance logged. Event: {resolved_event}")

        # Crop raw face from the clean frame before drawing audit markings
        raw_face_base64 = ""
        if frame is not None:
            try:
                h, w = frame.shape[:2]
                x1, y1, x2, y2 = map(int, bbox)
                # Add padding around face crop to ensure better training resolution
                pad_w = int((x2 - x1) * 0.15)
                pad_h = int((y2 - y1) * 0.15)
                crop_y1 = max(0, y1 - pad_h)
                crop_y2 = min(h, y2 + pad_h)
                crop_x1 = max(0, x1 - pad_w)
                crop_x2 = min(w, x2 + pad_w)
                face_crop = frame[crop_y1:crop_y2, crop_x1:crop_x2]
                
                if face_crop.size > 0:
                    _, crop_buf = cv2.imencode('.jpg', face_crop)
                    raw_face_base64 = base64.b64encode(crop_buf).decode('utf-8')
            except Exception as crop_err:
                logger.error(f"[{self.name}] Error cropping face: {crop_err}")

        # Render visual bounding boxes, vector lines, and trajectory history on the frame for auditing
        audit_frame = frame.copy() if frame is not None else np.zeros((720, 1280, 3), dtype=np.uint8)
        h, w = audit_frame.shape[:2]
        
        # Draw camera name and action overlay
        cv2.putText(audit_frame, f"{self.name} - {resolved_event.upper()}", (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)

        # Draw best face bounding box
        x1, y1, x2, y2 = map(int, bbox)
        if is_unknown:
            cv2.rectangle(audit_frame, (x1, y1), (x2, y2), (0, 0, 255), 2)
            cv2.putText(audit_frame, "Unknown Visitor", (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
        else:
            cv2.rectangle(audit_frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
            cv2.putText(audit_frame, f"{emp_id} ({confidence*100:.1f}%)", (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)

        # Draw visual boundary lines
        is_entry_cam = 'entrance' in self.name.lower() or 'entry' in self.name.lower() or self.event_type == 'entry'
        is_exit_cam = 'exit' in self.name.lower() or self.event_type == 'exit'

        if is_entry_cam:
            y_line = int(h * 0.6)
            x_left = int(w * 0.35)
            x_right = int(w * 0.70)
            cv2.line(audit_frame, (0, y_line), (w, y_line), (0, 0, 255), 2)
            cv2.line(audit_frame, (x_left, 0), (x_left, h), (0, 0, 255), 2)
            cv2.line(audit_frame, (x_right, 0), (x_right, h), (0, 0, 255), 2)
            cv2.putText(audit_frame, "VIRTUAL ATTENDANCE LINE (MID)", (10, y_line - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
            cv2.putText(audit_frame, "VIRTUAL ATTENDANCE LINE (LEFT)", (x_left + 5, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
            cv2.putText(audit_frame, "VIRTUAL ATTENDANCE LINE (RIGHT)", (x_right + 10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
        elif is_exit_cam:
            x_left = int(w * 0.32)
            x_right = int(w * 0.55)
            cv2.line(audit_frame, (x_left, 0), (x_left, h), (0, 0, 255), 2)
            cv2.line(audit_frame, (x_right, 0), (x_right, h), (0, 0, 255), 2)
            cv2.putText(audit_frame, "VIRTUAL ATTENDANCE LINE (LEFT)", (x_left + 5, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
            cv2.putText(audit_frame, "VIRTUAL ATTENDANCE LINE (RIGHT)", (x_right + 10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)

        # Draw trajectory history line (cyan)
        for i in range(1, len(track["centroids"])):
            c_prev = tuple(map(int, track["centroids"][i-1]))
            c_curr = tuple(map(int, track["centroids"][i]))
            cv2.line(audit_frame, c_prev, c_curr, (255, 255, 0), 2)
            cv2.circle(audit_frame, c_curr, 4, (0, 255, 255), -1)

        # Draw crossing point (yellow dot) if exists
        crossing_pt = track.get("crossing_point")
        if crossing_pt is not None:
            cv2.circle(audit_frame, tuple(map(int, crossing_pt)), 8, (0, 255, 255), -1)

        # Record short 10-second video of the track
        video_url = ""
        frames_buffer = track.get("frames_buffer", [])
        if len(frames_buffer) > 0:
            try:
                out_dir = r"D:\Whatsapp Attendance Tracking\public\uploads\camera_videos"
                os.makedirs(out_dir, exist_ok=True)
                video_filename = f"video_{int(time.time() * 1000)}_{emp_id}.webm"
                video_path = os.path.join(out_dir, video_filename)
                
                h_f, w_f = frames_buffer[0].shape[:2]
                fourcc = cv2.VideoWriter_fourcc(*'VP80')
                out = cv2.VideoWriter(video_path, fourcc, 15.0, (w_f, h_f))
                if not out.isOpened():
                    # Fallback to mp4v if VP80 fails
                    video_filename = f"video_{int(time.time() * 1000)}_{emp_id}.mp4"
                    video_path = os.path.join(out_dir, video_filename)
                    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
                    out = cv2.VideoWriter(video_path, fourcc, 15.0, (w_f, h_f))
                
                if out.isOpened():
                    for f in frames_buffer:
                        out.write(f)
                    out.release()
                    video_url = f"/uploads/camera_videos/{video_filename}"
                    logger.info(f"[{self.name}] Saved track video to {video_url}")
                else:
                    logger.error(f"[{self.name}] Failed to initialize VideoWriter for track video.")
            except Exception as vid_err:
                logger.error(f"[{self.name}] Error saving track video: {vid_err}")
            finally:
                track["frames_buffer"] = []

        # Encode frame to base64
        _, buffer = cv2.imencode('.jpg', audit_frame)
        jpg_as_text = base64.b64encode(buffer).decode('utf-8')

        # Report to Node server, passing clean raw face crop for mapping
        self.report_attendance(emp_id, confidence, jpg_as_text, resolved_event, raw_face_base64=raw_face_base64, video_url=video_url)

    def report_attendance(self, employee_id, confidence, image_base64_raw, event_type=None, status=None, raw_face_base64="", video_url=""):
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
                'image_base64': image_base64_raw,
                'raw_face_base64': raw_face_base64,
                'video_url': video_url
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


def start_cctv_thread(camera_id, name, source, site_name, event_type, threshold=0.52, node_server="http://localhost:3000"):
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
