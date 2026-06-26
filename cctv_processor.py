import os
import cv2
import time
import queue
import threading
import requests
import numpy as np
import base64
import logging
import traceback
from collections import OrderedDict
try:
    from scipy.optimize import linear_sum_assignment
    _HAS_SCIPY = True
except ImportError:
    _HAS_SCIPY = False
    logger_bootstrap = logging.getLogger(__name__)
    logger_bootstrap.warning("scipy not available - falling back to greedy centroid matching")

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
    def __init__(self, camera_id, name, source, site_name, event_type, threshold=0.38, node_server="http://localhost:3000", invert_direction=False):
        super().__init__()
        self.camera_id = camera_id
        self.name = name
        self.source = source  # Can be RTSP URL, file path, or webcam index (int)
        self.site_name = site_name
        self.event_type = event_type  # 'entry', 'exit', or 'auto'
        self.threshold = threshold
        self.node_server = node_server
        self.invert_direction = invert_direction
        
        self.running = False
        self.latest_frame = None
        self.latest_frame_time = 0
        self.grab_thread = None

        # ── Producer-consumer inference pipeline ───────────────────────────────
        # maxsize=6: larger buffer supports 5 people in frame (each detection batch is heavier)
        # without dropping frames when the tracker briefly falls behind.
        self._detection_queue = queue.Queue(maxsize=6)
        self._inference_thread = None

        # Shared frame ring-buffer: avoids copying the full frame into every track.
        # Size=64 covers ~4 seconds at 15 FPS; supports 5 simultaneous tracks safely.
        self._frame_ring = []          # list of np.ndarray (no copy on insert)
        self._frame_ring_idx = 0       # next write position
        self._frame_ring_size = 64
        self._frame_ring_lock = threading.Lock()

        # LRU identity cache: reuse last resolved identity and skip full matrix multiply.
        # Capacity=20 covers full 30-person rush hour crowds.
        self._id_cache = OrderedDict()  # key: track_id → (best_emp_id, best_conf, votes)
        self._id_cache_max = 20

        # Centroid tracker details (Multi-target face tracking)
        self.tracks = {}  # { track_id: { ... } }
        self.next_track_id = 0
        self.max_disappeared_seconds = 5.0   # for RECOGNIZED tracks (longer for group scenarios)
        self.max_disappeared_unknown = 3.0   # for UNRECOGNIZED tracks (was 2.0)
        self.cooldowns = {}  # { "employee_id_eventtype": timestamp }
        self.cooldown_seconds = 10  # Reduced from 20s to 10s for rapid group entries
        
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
        logger.info(f"[{self.name}] Starting multi-person stream capture on: {self.source}")
        
        if isinstance(self.source, int):
            cap = cv2.VideoCapture(self.source)
        else:
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "tls_verify;0;stimeout;5000000;rtsp_transport;tcp"
            cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG)
            
        if not cap.isOpened():
            logger.error(f"[{self.name}] Failed to open video source: {self.source}")
            self.running = False
            return

        # ── Frame-grab thread ─────────────────────────────────────────────────
        def grab_loop():
            nonlocal cap
            last_frame_time = time.time()
            while self.running:
                try:
                    ret, frame = cap.read()
                    if ret:
                        self.latest_frame = frame
                        self.latest_frame_time = time.time()
                        last_frame_time = time.time()
                    else:
                        if time.time() - last_frame_time > 5.0:
                            logger.warning(f"[{self.name}] RTSP stream inactive for 5s. Reconnecting...")
                            cap.release()
                            time.sleep(1.0)
                            if isinstance(self.source, int):
                                cap = cv2.VideoCapture(self.source)
                            else:
                                os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "tls_verify;0;stimeout;5000000;rtsp_transport;tcp"
                                cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG)
                            last_frame_time = time.time()
                        else:
                            time.sleep(0.05)
                except Exception as e:
                    logger.error(f"[{self.name}] Error in grab loop: {e}")
                    time.sleep(1.0)

        self.grab_thread = threading.Thread(target=grab_loop, daemon=True)
        self.grab_thread.start()

        # ── Model init (dedicated per camera thread for lock-free parallel execution) ──
        from face_recognition_service import FaceRecognitionModel
        self.model = FaceRecognitionModel(model_name='buffalo_l')
        self.model.warm_up()
        
        # Load initial embeddings
        embeddings_file = os.path.join(os.path.dirname(__file__), 'data', 'employee_embeddings.json')
        if os.path.exists(embeddings_file):
            self.model.load_embeddings(embeddings_file)
            try:
                self.last_embeddings_mtime = os.path.getmtime(embeddings_file)
            except Exception:
                self.last_embeddings_mtime = 0
        else:
            self.last_embeddings_mtime = 0

        # ── Inference thread (producer) ───────────────────────────────────────
        # Runs model.detect_faces() in its own thread so the tracking loop
        # (consumer) is never blocked waiting for InsightFace.
        def inference_loop():
            frame_counter = 0
            while self.running:
                try:
                    # Dynamically reload embeddings if database is updated on disk
                    if os.path.exists(embeddings_file):
                        try:
                            mtime = os.path.getmtime(embeddings_file)
                            if getattr(self, "last_embeddings_mtime", 0) != mtime:
                                logger.info(f"[{self.name}] Detected updated embeddings file on disk. Reloading...")
                                self.model.load_embeddings(embeddings_file)
                                self.last_embeddings_mtime = mtime
                                self._emb_matrix_len = -1
                        except Exception as reload_err:
                            logger.error(f"[{self.name}] Failed to reload embeddings: {reload_err}")

                    frame = self.latest_frame
                    if frame is None or (time.time() - self.latest_frame_time > 5.0):
                        time.sleep(0.05)
                        continue

                    # Adaptive frame skip:
                    #   0 active tracks  → process every 2nd frame  (save CPU when idle)
                    #   1+ active tracks → process every frame      (max accuracy when busy)
                    n_tracks = len(self.tracks)
                    skip = 2 if n_tracks == 0 else 1
                    frame_counter += 1
                    if frame_counter % skip != 0:
                        time.sleep(0.02)
                        continue

                    # Store frame in shared ring buffer (no copy — ring holds references)
                    with self._frame_ring_lock:
                        idx = self._frame_ring_idx % self._frame_ring_size
                        if len(self._frame_ring) < self._frame_ring_size:
                            self._frame_ring.append(frame)
                        else:
                            self._frame_ring[idx] = frame
                        self._frame_ring_idx += 1
                        ring_ref_idx = idx  # tracker will use this index

                    # Detect all faces via fast detector
                    h, w = frame.shape[:2]
                    raw_faces, enhanced = self.model.detect_faces(frame)

                    target_h = 540
                    target_w = int(w * (target_h / h))
                    scale_x = w / target_w
                    scale_y = h / target_h

                    detections = []
                    for face in raw_faces:
                        bbox = face.bbox
                        x1, y1, x2, y2 = map(int, bbox)
                        
                        # Scale coordinates back to original size for tracking
                        x1_scaled = int(x1 * scale_x)
                        y1_scaled = int(y1 * scale_y)
                        x2_scaled = int(x2 * scale_x)
                        y2_scaled = int(y2 * scale_y)
                        cx_scaled = int((x1_scaled + x2_scaled) / 2)
                        cy_scaled = int((y1_scaled + y2_scaled) / 2)
                        bbox_scaled = np.array([x1_scaled, y1_scaled, x2_scaled, y2_scaled], dtype=np.float32)

                        # ── Liveness (Laplacian variance) ────────────────────────
                        # Top-angle cameras (Gate 1, Gate 3) see slightly blurry faces
                        # from above; lower the threshold to 80 for top-down angles.
                        liveness = False
                        is_topdown = any(n in self.name.lower() for n in ['gate 1', 'gate 3'])
                        liveness_thresh = 80.0 if is_topdown else 150.0
                        if x2_scaled > x1_scaled and y2_scaled > y1_scaled:
                            face_crop = frame[max(0, y1_scaled):min(h, y2_scaled), max(0, x1_scaled):min(w, x2_scaled)]
                            if face_crop.size > 0:
                                gray_crop = cv2.cvtColor(face_crop, cv2.COLOR_BGR2GRAY)
                                lap_var = cv2.Laplacian(gray_crop, cv2.CV_64F).var()
                                if lap_var > liveness_thresh:
                                    liveness = True

                        detections.append({
                            "bbox": bbox_scaled,
                            "centroid": (cx_scaled, cy_scaled),
                            "emp_id": None,
                            "confidence": 0.0,
                            "best_match": None,
                            "best_score": 0.0,
                            "liveness": liveness,
                            "roi_ignored": False,
                            "ring_idx": ring_ref_idx,
                            "face_obj": face,
                            "enhanced_frame": enhanced,
                        })

                    # Push to queue (non-blocking: drop if tracker hasn't consumed yet)
                    try:
                        self._detection_queue.put_nowait((detections, ring_ref_idx, frame))
                    except queue.Full:
                        pass  # Tracker is behind; drop this batch — next frame will be fresher

                except Exception as e:
                    logger.error(f"[{self.name}] Error in inference loop: {e}")
                    traceback.print_exc()
                    time.sleep(0.1)

        self._inference_thread = threading.Thread(target=inference_loop, daemon=True, name=f"infer-{self.camera_id}")
        self._inference_thread.start()
        logger.info(f"[{self.name}] Inference thread started (fast detection-only + adaptive frame skip)")

        # ── Tracking thread (consumer / main loop) ────────────────────────────
        while self.running:
            try:
                # Block up to 0.5s waiting for the next detection batch
                try:
                    detections, ring_ref_idx, frame = self._detection_queue.get(timeout=0.5)
                except queue.Empty:
                    continue

                correlation_mode = self.check_correlation_mode()

                if not correlation_mode:
                    self.detect_door_state(frame)

                self.update_tracker(detections, frame)

                if correlation_mode:
                    self.detect_motion_and_track(frame, time.time())

            except Exception as e:
                logger.error(f"[{self.name}] Error in tracking loop: {e}")
                traceback.print_exc()

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

        # Hungarian Algorithm: Optimal 1-to-1 assignment
        # Builds a cost matrix and finds the globally optimal match so each detection
        # gets at most 1 track and each track gets at most 1 detection.
        MATCH_THRESHOLD = 75.0  # reduced from 160 to prevent track hijacking by close-by targets

        if len(detections) > 0 and len(track_ids) > 0:
            # Scale match threshold to face size: larger faces (closer to camera) move
            # more pixels per frame, so we allow a proportionally wider search radius.
            if detections:
                diags = []
                for det in detections:
                    bb = det["bbox"]
                    diag = ((bb[2] - bb[0]) ** 2 + (bb[3] - bb[1]) ** 2) ** 0.5
                    diags.append(diag)
                avg_diag = float(np.mean(diags))
                # 0.55 factor (was 0.45) gives more slack for fast-walkers in groups
                MATCH_THRESHOLD = max(75.0, avg_diag * 0.55)

            cost_matrix = np.zeros((len(detections), len(track_ids)), dtype=np.float32)
            for d_idx, det in enumerate(detections):
                dc = np.array(det["centroid"], dtype=np.float32)
                det_emp = det.get("emp_id")
                for t_idx, tc in enumerate(track_centroids):
                    tid = track_ids[t_idx]
                    track_emp = self.tracks[tid].get("best_emp_id")
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
                tid = track_ids[t_idx]
                dt = now - self.tracks[tid]["last_seen_time"]
                # Dynamically expand search radius based on time gap to prevent tracker fragmentation during detection drops
                # Cap dt at 1.5 seconds to prevent track ID switching / merging across different targets
                dt_capped = min(dt, 1.5)
                track_threshold = MATCH_THRESHOLD + 120.0 * dt_capped
                if cost_matrix[d_idx, t_idx] < track_threshold:
                    self.update_track(tid, detections[d_idx], now, frame)
                    matched_detections.add(d_idx)
                    matched_tracks.add(tid)

        # ── Register every unmatched detection as a new independent track ──────
        # MAX_CONCURRENT_TRACKS=30 supports 5 people per camera across 6 cameras
        # simultaneously, plus some slack for background noise tracks.
        MAX_CONCURRENT_TRACKS = 30
        for det_idx, det in enumerate(detections):
            if det_idx not in matched_detections:
                if det.get("roi_ignored", False):
                    logger.info(f"[{self.name}] Skipping registration of new track in ignored ROI area at centroid {det['centroid']}")
                    continue
                if len(self.tracks) >= MAX_CONCURRENT_TRACKS:
                    logger.warning(f"[{self.name}] Max concurrent tracks ({MAX_CONCURRENT_TRACKS}) reached. Dropping new detection.")
                    continue
                self.register_track(det, now, frame)

        # ── Expire or confirm unmatched tracks ────────────────────────────────
        for tid in list(track_ids):
            if tid not in matched_tracks:
                if tid not in self.tracks:
                    continue
                disappeared_duration = now - self.tracks[tid]["last_seen_time"]

                # Use faster expiry for unrecognized junk tracks to free slots quickly
                has_emp = bool(self.tracks[tid].get("best_emp_id"))
                max_disappear = self.max_disappeared_seconds if has_emp else self.max_disappeared_unknown

                if not self.tracks[tid].get("crossed", False) and disappeared_duration >= max_disappear:
                    self.check_fallback_trajectory(tid, frame)

                if self.tracks[tid].get("crossed", False):
                    if not self.tracks[tid].get("confirmed", False) and disappeared_duration >= max_disappear:
                        self.tracks[tid]["confirmed"] = True
                        crossing_dir_val = self.tracks[tid].get("crossing_direction")
                        curr_y_val = self.tracks[tid]["centroids"][-1][1]
                        logger.info(f"[{self.name}] [Path Track] Confirming expired track {tid} (direction: {crossing_dir_val}, final position: {curr_y_val})")
                        self.confirm_attendance_event(tid, self.tracks[tid].get("best_frame", frame))

                    if disappeared_duration >= max_disappear:
                        # Evict LRU identity cache entry when track is deleted
                        self._id_cache.pop(tid, None)
                        del self.tracks[tid]
                elif disappeared_duration >= max_disappear:
                    best_emp = self.tracks[tid].get("best_emp_id")
                    frames_active = self.tracks[tid].get("frames_active", 0)
                    logger.info(f"[{self.name}] Expiring uncrossed track {tid} (emp={best_emp}, frames={frames_active}) -- no line crossing confirmed.")
                    self._id_cache.pop(tid, None)
                    del self.tracks[tid]


    def register_track(self, det, now, frame):
        tid = self.next_track_id
        self.next_track_id += 1
        bbox = det["bbox"]
        area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
        track_min_y = det["centroid"][1]
        track_max_y = det["centroid"][1]
        track_min_x = det["centroid"][0]
        track_max_x = det["centroid"][0]
        
        # Run selective recognition on the new track
        best_match = None
        best_score = 0.0
        face_obj = det.get("face_obj")
        
        w_box = bbox[2] - bbox[0]
        h_box = bbox[3] - bbox[1]
        
        logger.info(f"[{self.name}] [Register Track] Attempting track {tid} registration. bbox size: {w_box}x{h_box}, face_obj exists: {face_obj is not None}")
        
        if face_obj is not None and w_box >= 40 and h_box >= 40:
            face_obj = self.model.extract_embedding_for_face(det["enhanced_frame"], face_obj)
            if face_obj.embedding is not None and self.model.embeddings_db:
                embedding = face_obj.embedding / np.linalg.norm(face_obj.embedding)
                
                # Rebuild embedding matrix cache only when DB changes
                db_len = len(self.model.embeddings_db)
                if getattr(self, "_emb_matrix_len", -1) != db_len:
                    self._emb_ids = list(self.model.embeddings_db.keys())
                    self._emb_mat = np.array(list(self.model.embeddings_db.values()), dtype=np.float32)
                    self._emb_matrix_len = db_len
                    
                scores = self._emb_mat @ embedding
                best_idx = int(np.argmax(scores))
                best_score = float(scores[best_idx])
                best_match = self._emb_ids[best_idx]
                logger.info(f"[{self.name}] [Register Track] Track {tid} recognition outcome: best_match={best_match}, score={best_score:.3f} (thresh={self.threshold})")
            else:
                logger.warning(f"[{self.name}] [Register Track] Track {tid} embedding extraction failed or DB is empty.")
        
        face_matches = {}
        emp_confidences = {}
        if best_match and best_score >= self.threshold:
            face_matches[best_match] = 1
            emp_confidences[best_match] = best_score
            det["emp_id"] = best_match
            det["confidence"] = best_score
            det["best_match"] = best_match
            det["best_score"] = best_score
        else:
            det["emp_id"] = None
            det["confidence"] = 0.0
            det["best_match"] = None
            det["best_score"] = 0.0

        # Store only a lightweight reference index into the shared ring buffer
        # instead of copying the full frame into each track dictionary.
        ring_ref = det.get("ring_idx", None)

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
            "y_start_original": det["centroid"][1],
            "x_start_original": det["centroid"][0],
            
            # Best quality tracking variables
            "best_area": area,
            # best_frame stored as reference into ring buffer; only snapshot-copied at confirm time
            "best_frame": frame,
            "best_ring_ref": ring_ref,
            "best_bbox": det["bbox"],
            "best_emp_id": best_match if best_score >= self.threshold else None,
            "best_confidence": best_score if best_score >= self.threshold else 0.0,
            "confirmed": False,
            "face_matches": face_matches,
            "emp_confidences": emp_confidences,
            
            # Persistent extremes
            "track_min_y": track_min_y,
            "track_max_y": track_max_y,
            "track_min_x": track_min_x,
            "track_max_x": track_max_x,
            
            # Video frames buffer (lightweight ring references instead of copies)
            "frames_buffer": [],
            "rec_attempts": 1 if (face_obj is not None and w_box >= 40 and h_box >= 40) else 0,
        }
        logger.debug(f"[{self.name}] Registered new face track {tid}")

    def get_y_line(self, h):
        """Return the virtual attendance line Y-position calibrated to each camera's field of view.
        
        Entry cameras (Entrance CCTV): door appears in lower portion of frame.
            -> y_line at 65% of height by default.
        Exit cameras (Exit CCTV): door appears in upper portion of frame.
            -> y_line at 32% of height by default.
        Override per-camera via camera_configs.json: "y_line_percent": 0.55
        """
        # Per-camera y_line_percent override (set in camera_configs.json "y_line_percent": 0.55).
        # Lets you calibrate the virtual line to the real door position without code changes.
        if hasattr(self, '_y_line_percent') and self._y_line_percent is not None:
            return int(h * self._y_line_percent)
        is_gate1_entry = self.name.lower() == 'gate 1 entry'
        is_gate1_exit = self.name.lower() == 'gate 1 exit'
        is_gate3_entry = self.name.lower() == 'gate 3 entry'
        is_gate3_exit = self.name.lower() == 'gate 3 exit'
        if is_gate1_entry or is_gate1_exit or is_gate3_entry or is_gate3_exit:
            return False

        is_entry_cam = 'entrance' in self.name.lower() or 'entry' in self.name.lower() or self.event_type == 'entry'
        if is_entry_cam:
            return int(h * 0.65)
        else:
            return int(h * 0.32)

    def check_track_confirmation(self, crossing_dir, curr_y, y_line):
        """Check if the track ended up on the correct destination side of y_line.
        
        Entrance CCTV 1:
          - Entry: Walks from door (top) to office (bottom). So Y increases, ends at Y >= y_line + 40.
          - Exit: Walks from office (bottom) to door (top). So Y decreases, ends at Y <= y_line - 40.
        Exit CCTV 1:
          - Exit: Walks from office (top) to door/outside (bottom). So Y increases, ends at Y >= y_line + 40.
          - Entry: Walks from door/outside (bottom) to office (top). So Y decreases, ends at Y <= y_line - 40.
        """
        is_entry_cam = 'entrance' in self.name.lower() or 'entry' in self.name.lower() or self.event_type == 'entry'
        if is_entry_cam:
            if crossing_dir == "entry" and curr_y >= y_line + 40:
                return True
            elif crossing_dir == "exit" and curr_y <= y_line - 40:
                return True
        else:
            if crossing_dir == "exit" and curr_y >= y_line + 40:
                return True
            elif crossing_dir == "entry" and curr_y <= y_line - 40:
                return True
        return False

    def check_hysteresis_reset(self, crossing_dir, curr_y, y_start):
        """Check if the person returned back in the opposite direction of their initial crossing trajectory.
        
        Entrance CCTV 1:
          - Entry: Walks downwards (Y increases). Cancel if they walk back up (Y < y_start - 40).
          - Exit: Walks upwards (Y decreases). Cancel if they walk back down (Y > y_start + 40).
        Exit CCTV 1:
          - Exit: Walks downwards (Y increases). Cancel if they walk back up (Y < y_start - 40).
          - Entry: Walks upwards (Y decreases). Cancel if they walk back down (Y > y_start + 40).
        """
        is_entry_cam = 'entrance' in self.name.lower() or 'entry' in self.name.lower() or self.event_type == 'entry'
        if is_entry_cam:
            if crossing_dir == "entry" and curr_y < y_start - 40:
                return True
            elif crossing_dir == "exit" and curr_y > y_start + 40:
                return True
        else:
            if crossing_dir == "exit" and curr_y < y_start - 40:
                return True
            elif crossing_dir == "entry" and curr_y > y_start + 40:
                return True
        return False

    def is_approaching_line(self, centroids, h):
        """Check if centroid coordinates are moving towards the middle line"""
        if len(centroids) < 2:
            return False
        line_y = self.get_y_line(h)
        prev_dist = abs(centroids[-2][1] - line_y)
        curr_dist = abs(centroids[-1][1] - line_y)

        return curr_dist < prev_dist and curr_dist < 80.0

    def check_fallback_trajectory(self, tid, frame):
        """Fallback: confirm a crossing if the person showed clear directional movement
        within the door zone, using their original start coordinate to support partial tracks."""
        track = self.tracks[tid]
        if len(track["centroids"]) < 2:
            return

        h, w = frame.shape[:2] if frame is not None else (720, 1280)
        is_gate1_entry = self.name.lower() == 'gate 1 entry'
        is_gate1_exit = self.name.lower() == 'gate 1 exit'
        is_gate3_entry = self.name.lower() == 'gate 3 entry'
        is_entry_cam = 'entrance' in self.name.lower() or 'entry' in self.name.lower() or self.event_type == 'entry'
        is_exit_cam = 'exit' in self.name.lower() or self.event_type == 'exit'

        # Gate 1 Entry / Gate 3 Entry custom trajectory fallbacks
        if is_gate1_entry or is_gate3_entry:
            best_emp = track.get("best_emp_id")
            y_start = track.get("y_start_original", track["centroids"][0][1])
            y_end = track["centroids"][-1][1]
            x_end = track["centroids"][-1][0]
            x_start = track["centroids"][0][0]
            net_displacement = y_end - y_start  # Entry is downward (y increases)
            
            if best_emp and net_displacement >= 20:
                if is_gate1_entry:
                    x_left = int(w * 0.35)
                    x_right = int(w * 0.58)
                    door_y_limit = int(h * 0.44)
                    
                    started_in_col = (x_left - 15 <= x_start <= x_right + 15)
                    started_above = (y_start <= door_y_limit + 50)
                    in_door_zone = started_in_col and started_above and (x_left - 60 <= x_end <= x_right + 60)
                else:  # is_gate3_entry
                    x_left = int(w * 0.39)
                    x_right = int(w * 0.87)
                    in_door_zone = (x_left - 60 <= x_end <= x_right + 60)
                    
                if in_door_zone:
                    track["crossed"] = True
                    track["crossing_direction"] = "entry"
                    logger.info(f"[{self.name}] [Fallback Path] Confirmed motion via trajectory fallback: entry (y_start={y_start:.0f} -> y_end={y_end:.0f})")
            return

        if track["frames_active"] < 4:  # Relax from 5 to 4 frames to capture quick crossings
            return

        # Gate 1 Exit uses its own crossing line and x bounds (different from other exit cameras)
        if is_gate1_exit:
            y_line = int(h * 0.55)
            x_left = int(w * 0.18)
            x_right = int(w * 0.38)
            
            x_start = track["centroids"][0][0]
            # Enforce that the track started inside the actual door width (with 10px padding)
            # to exclude people standing or hanging out near the side windows.
            if not (x_left - 10 <= x_start <= x_right + 10):
                return
        elif is_entry_cam:
            y_line = self.get_y_line(h)
            x_left = int(w * 0.35)
            x_right = int(w * 0.70)
        elif is_exit_cam:
            y_line = self.get_y_line(h)
            x_left = int(w * 0.32)
            x_right = int(w * 0.55)
        else:
            return

        if not y_line:
            return

        y_start = track.get("y_start_original", track["centroids"][0][1])
        y_end = track["centroids"][-1][1]
        x_end = track["centroids"][-1][0]

        in_door_zone = x_left - 40 <= x_end <= x_right + 40
        net_displacement = abs(y_end - y_start)
        
        # If the track is verified to belong to a registered employee, we can be slightly more relaxed 
        # on the door zone bounds check (using 60px padding) to prevent missing diagonal walks while avoiding office workers.
        best_emp = track.get("best_emp_id")
        if best_emp:
            in_door_zone = x_left - 60 <= x_end <= x_right + 60

        crossed = False
        crossing_point = (int(x_end), y_line)
        crossing_dir = ""

        if in_door_zone and net_displacement >= 50:  # Relax from 60 to 50 for quick frames
            if is_entry_cam:
                crossing_dir = "entry" if y_end > y_start else "exit"
            else:
                crossing_dir = "exit" if y_end > y_start else "entry"
            
            crossed = True
            logger.info(f"[{self.name}] [Fallback Path] Confirmed motion: {crossing_dir} (y_start={y_start:.0f} -> y_end={y_end:.0f}, y_line={y_line})")
        else:
            if best_emp:
                logger.info(f"[{self.name}] [Fallback Path] Skipped recognized emp {best_emp}: in_door_zone={in_door_zone} (x_end={x_end:.0f}, bounds=[{x_left-150}, {x_right+150}]), net_displacement={net_displacement:.0f} (y_start={y_start:.0f} -> y_end={y_end:.0f})")
            else:
                logger.debug(f"[{self.name}] [Fallback Path] Skipped: in_door_zone={in_door_zone}, net_displacement={net_displacement:.0f}")

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
        
        # If this frame has a larger face area, update the best quality frame reference
        if frame is not None and area > track.get("best_area", 0):
            track["best_area"] = area
            track["best_frame"] = frame  # keep reference; copy only at confirm time
            track["best_ring_ref"] = det.get("ring_idx")
            track["best_bbox"] = det["bbox"]

        # Run selective recognition on the active track
        best_match = None
        best_score = 0.0
        face_obj = det.get("face_obj")
        
        if face_obj is not None:
            track["rec_attempts"] = track.get("rec_attempts", 0)
            votes_count = sum(track.get("face_matches", {}).values())
            
            w_box = x2 - x1
            h_box = y2 - y1
            
            if votes_count < 5 and track["rec_attempts"] < 8 and w_box >= 40 and h_box >= 40:
                track["rec_attempts"] += 1
                logger.info(f"[{self.name}] [Update Track] Track {tid} (frame {track['frames_active']}): Running recognition attempt {track['rec_attempts']}. bbox size: {w_box}x{h_box}")
                face_obj = self.model.extract_embedding_for_face(det["enhanced_frame"], face_obj)
                
                if face_obj.embedding is not None and self.model.embeddings_db:
                    embedding = face_obj.embedding / np.linalg.norm(face_obj.embedding)
                    
                    # Rebuild embedding matrix cache only when DB changes
                    db_len = len(self.model.embeddings_db)
                    if getattr(self, "_emb_matrix_len", -1) != db_len:
                        self._emb_ids = list(self.model.embeddings_db.keys())
                        self._emb_mat = np.array(list(self.model.embeddings_db.values()), dtype=np.float32)
                        self._emb_matrix_len = db_len
                        
                    scores = self._emb_mat @ embedding
                    best_idx = int(np.argmax(scores))
                    best_score = float(scores[best_idx])
                    best_match = self._emb_ids[best_idx]
                    logger.info(f"[{self.name}] [Update Track] Track {tid} recognition outcome: best_match={best_match}, score={best_score:.3f} (thresh={self.threshold})")
                    
                    det["best_match"] = best_match
                    det["best_score"] = best_score
                    if best_score >= self.threshold:
                        det["emp_id"] = best_match
                        det["confidence"] = best_score
                    else:
                        det["emp_id"] = None
                        det["confidence"] = 0.0
                else:
                    det["best_match"] = None
                    det["best_score"] = 0.0
                    det["emp_id"] = None
                    det["confidence"] = 0.0
            else:
                det["best_match"] = None
                det["best_score"] = 0.0
                det["emp_id"] = None
                det["confidence"] = 0.0
        else:
            det["best_match"] = None
            det["best_score"] = 0.0
            det["emp_id"] = None
            det["confidence"] = 0.0

        # Update face matches frequency mapping for majority voting identity resolution
        best_match_resolved = det.get("best_match")
        best_score_resolved = det.get("best_score", 0.0)
        if best_match_resolved and best_score_resolved >= self.threshold:
            current_best = track.get("best_emp_id")
            if current_best and best_match_resolved != current_best:
                # Target switch detected! Split track to log the first person and switch to the new identity
                logger.info(f"[{self.name}] Target switch detected in track {tid}: {current_best} -> {best_match_resolved}")
                
                # 1. If the previous person has already crossed, confirm their attendance immediately!
                if track.get("crossed") and not track.get("confirmed"):
                    track["confirmed"] = True
                    crossing_dir_val = track.get("crossing_direction")
                    curr_y_val = track["centroids"][-1][1]
                    logger.info(f"[{self.name}] [Path Track] Confirming expired/switched track {tid} for {current_best} (direction: {crossing_dir_val}, final position: {curr_y_val})")
                    self.confirm_attendance_event(tid, track.get("best_frame", frame))
                
                # 2. Reset the track history and parameters for the new person
                track["face_matches"] = {}
                track["emp_confidences"] = {}
                track["best_emp_id"] = None
                track["best_confidence"] = 0.0
                track["rec_attempts"] = 0 # Reset attempts so it will run 8 new attempts for the new person
                track["centroids"] = [curr_centroid] # Keep only the current centroid
                track["bboxes"] = [det["bbox"]] # Keep only the current bbox
                track["track_min_y"] = curr_centroid[1]
                track["track_max_y"] = curr_centroid[1]
                track["track_min_x"] = curr_centroid[0]
                track["track_max_x"] = curr_centroid[0]
                track["crossed"] = False
                track["confirmed"] = False

            if "face_matches" not in track:
                track["face_matches"] = {}
            if "emp_confidences" not in track:
                track["emp_confidences"] = {}
                
            track["face_matches"][best_match_resolved] = track["face_matches"].get(best_match_resolved, 0) + 1
            track["emp_confidences"][best_match_resolved] = max(track["emp_confidences"].get(best_match_resolved, 0.0), best_score_resolved)
            
            # Resolve best matched employee ID by majority vote (tie-breaker: highest confidence)
            best_emp = None
            max_votes = -1
            best_conf = 0.0
            
            for emp, votes in track["face_matches"].items():
                conf = track["emp_confidences"].get(emp, 0.0)
                if votes > max_votes:
                    max_votes = votes
                    best_emp = emp
                    best_conf = conf
                elif votes == max_votes:
                    if conf > best_conf:
                        best_emp = emp
                        best_conf = conf
            
            track["best_emp_id"] = best_emp
            track["best_confidence"] = best_conf
        
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

        # Keep up to 25 centroids (was 15): longer history is critical for
        # slow-moving group members who take many frames to cross the line.
        if len(track["centroids"]) > 25:
            track["centroids"].pop(0)
            track["bboxes"].pop(0)

        # Update persistent extremes each frame (survives buffer trimming)
        track["track_min_y"] = min(track.get("track_min_y", curr_centroid[1]), curr_centroid[1])
        track["track_max_y"] = max(track.get("track_max_y", curr_centroid[1]), curr_centroid[1])
        track["track_min_x"] = min(track.get("track_min_x", curr_centroid[0]), curr_centroid[0])
        track["track_max_x"] = max(track.get("track_max_x", curr_centroid[0]), curr_centroid[0])

        # Buffer frames for video recording — store the live frame reference
        # (not a copy). At confirm time we snapshot the full buffer in one go.
        if frame is not None:
            if "frames_buffer" not in track:
                track["frames_buffer"] = []
            track["frames_buffer"].append(frame)  # reference, not copy
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

            is_gate1_entry = self.name.lower() == 'gate 1 entry'
            is_gate1_exit = self.name.lower() == 'gate 1 exit'
            is_gate3_entry = self.name.lower() == 'gate 3 entry'
            is_gate3_exit = self.name.lower() == 'gate 3 exit'

            if is_gate1_entry:
                # Trajectory-based checking robust against diagonal paths and frame skips
                door_y_limit = int(h * 0.44)
                x_left = int(w * 0.35)
                x_right = int(w * 0.58)

                track_min_y = track.get("track_min_y", curr_y)
                track_max_y = track.get("track_max_y", curr_y)
                y_traj_start = track.get("y_start_original", track["centroids"][0][1])
                x_traj_start = track["centroids"][0][0]

                started_in_door_col = x_left - 15 <= x_traj_start <= x_right + 15

                if track["frames_active"] >= 3:
                    if is_entry_cam:
                        # Entry: started near/above door, moved down into office (no final x restriction)
                        if started_in_door_col and y_traj_start <= door_y_limit + 120 and curr_y > door_y_limit + 30 and (track_max_y > y_traj_start + 25):
                            crossed = True
                            crossing_dir = "entry"
                            crossing_point = (int(curr_x), door_y_limit)
                        # Exit: started deep inside office, moved up to door, ended in/near door col
                        elif y_traj_start > door_y_limit + 100 and track_min_y <= door_y_limit + 80 and (x_left - 15 <= curr_x <= x_right + 15):
                            crossed = True
                            crossing_dir = "exit"
                            crossing_point = (int(curr_x), door_y_limit)

            elif is_gate1_exit:
                # Gate 1 Exit: person walks through glass door from office side.
                # EXIT: starts at/above door, walks down onto porch (can exit diagonally left/right or stop to wear shoes)
                # ENTRY: starts below door, walks up into door column
                crossing_line_y = int(h * 0.55)
                x_door_left  = int(w * 0.18)
                x_door_right = int(w * 0.38)

                track_min_y = track.get("track_min_y", curr_y)
                track_max_y = track.get("track_max_y", curr_y)
                y_traj_start = track.get("y_start_original", track["centroids"][0][1])
                x_traj_start = track["centroids"][0][0]

                started_in_door_col = x_door_left - 10 <= x_traj_start <= x_door_right + 10

                if track["frames_active"] >= 3:
                    # Exit: started at/above door, moved down onto porch/stairs (no final x restriction)
                    if started_in_door_col and y_traj_start <= crossing_line_y + 80 and curr_y >= crossing_line_y + 20 and (track_max_y > y_traj_start + 25):
                        crossed = True
                        crossing_dir = "exit"
                        crossing_point = (int(curr_x), crossing_line_y)
                    # Entry: started below door, moved up into door column
                    elif y_traj_start > crossing_line_y + 50 and track_min_y <= crossing_line_y + 50 and (x_door_left - 10 <= curr_x <= x_door_right + 10):
                        crossed = True
                        crossing_dir = "entry"
                        crossing_point = (int(curr_x), crossing_line_y)

            elif is_gate3_entry:
                # Gate 3 Entry sloped threshold crossing
                x1, y1 = int(w * 0.39), int(h * 0.72)
                x2, y2 = int(w * 0.87), int(h * 0.99)
                
                # Check if previous centroid was above the sloped line and current is below
                def get_sloped_y(x):
                    if x <= x1: return y1
                    if x >= x2: return y2
                    return y1 + (y2 - y1) * (x - x1) / (x2 - x1)
                
                prev_line_y = get_sloped_y(prev_x)
                curr_line_y = get_sloped_y(curr_x)
                
                if x1 - 30 <= curr_x <= x2 + 30:
                    if prev_y <= prev_line_y and curr_y > curr_line_y:
                        crossed = True
                        crossing_dir = "entry"
                        crossing_point = (int(curr_x), int(curr_line_y))
                    elif prev_y >= prev_line_y and curr_y < curr_line_y:
                        crossed = True
                        crossing_dir = "exit"
                        crossing_point = (int(curr_x), int(curr_line_y))
            elif is_gate3_exit:
                # Gate 3 Exit sloped threshold crossing
                x1, y1 = int(w * 0.24), int(h * 0.77)
                x2, y2 = int(w * 0.58), int(h * 0.63)
                
                def get_sloped_y(x):
                    if x <= x1: return y1
                    if x >= x2: return y2
                    return y1 + (y2 - y1) * (x - x1) / (x2 - x1)
                
                prev_line_y = get_sloped_y(prev_x)
                curr_line_y = get_sloped_y(curr_x)
                
                y_start = track.get("y_start_original", track["centroids"][0][1])
                x_start = track["centroids"][0][0]
                line_y_start = get_sloped_y(x_start)
                
                started_inside_gate = (y_start <= line_y_start + 250) and (int(w * 0.20) - 30 <= x_start <= int(w * 0.58) + 30)
                
                if started_inside_gate:
                    if prev_y <= prev_line_y and curr_y > curr_line_y:
                        crossed = True
                        crossing_dir = "exit"
                        crossing_point = (int(curr_x), int(curr_line_y))
            else:
                # Gate 2 (original strict line-crossing)
                if is_entry_cam:
                    y_line = self.get_y_line(h)
                    x_left = int(w * 0.35)
                    x_right = int(w * 0.70)
                else:
                    y_line = self.get_y_line(h)
                    x_left = int(w * 0.32)
                    x_right = int(w * 0.55)

                # Check horizontal segment crossing
                if prev_y <= y_line < curr_y:
                    dy = curr_y - prev_y
                    x_intersect = prev_x + (curr_x - prev_x) * (y_line - prev_y) / dy if dy > 0 else curr_x
                    if x_left - 30 <= x_intersect <= x_right + 30:
                        crossed = True
                        crossing_point = (int(x_intersect), y_line)
                        crossing_dir = "entry" if is_entry_cam else "exit"
                elif prev_y >= y_line > curr_y:
                    dy = prev_y - curr_y
                    x_intersect = prev_x + (curr_x - prev_x) * (prev_y - y_line) / dy if dy > 0 else curr_x
                    if x_left - 30 <= x_intersect <= x_right + 30:
                        crossed = True
                        crossing_point = (int(x_intersect), y_line)
                        crossing_dir = "exit" if is_entry_cam else "entry"

            if crossed:
                track["crossed"] = True
                track["crossing_time"] = now
                track["crossing_point"] = crossing_point
                if self.invert_direction and crossing_dir in ["entry", "exit"]:
                    crossing_dir = "exit" if crossing_dir == "entry" else "entry"
                track["crossing_direction"] = crossing_dir
                logger.info(f"[{self.name}] [Path Track] Verified crossing at {crossing_point} for track {tid} with direction: {crossing_dir}")

        # Deferred/Hysteresis Crossing Confirmation
        if track.get("crossed", False) and not track.get("confirmed", False):
            y_line = self.get_y_line(h)
            crossing_dir = track.get("crossing_direction")
            best_emp = track.get("best_emp_id")
            
            # Check if they returned back (hysteresis reset)
            y_start_val = track.get("y_start_original", track["centroids"][0][1])
            if self.check_hysteresis_reset(crossing_dir, curr_centroid[1], y_start_val):
                track["crossed"] = False
                track["crossing_point"] = None
                track["crossing_direction"] = ""
                logger.info(f"[{self.name}] [Path Track] Cancelled {crossing_dir} crossing for track {tid} -- returned to wrong side (y={curr_centroid[1]} relative to start y={y_start_val:.0f})")

        # Run fallback trajectory analysis if standard checks did not trigger
        if not track.get("crossed", False):
            self.check_fallback_trajectory(tid, frame)


    def confirm_attendance_event(self, tid, frame):
        track = self.tracks[tid]
        emp_id = track.get("best_emp_id")
        confidence = track.get("best_confidence", 0.0)
        bbox = track.get("best_bbox", track["bboxes"][-1])
        direction = track.get("crossing_direction", "entry")

        # Reset crossing flags to prevent duplicate loops
        track["crossed"] = False
        track["approaching"] = False
        track["door_open_seen"] = False

        is_unknown = False
        if not emp_id or confidence < self.threshold:
            emp_id = "unknown"
            is_unknown = True

        # Resolve event direction
        resolved_event = track.get("crossing_direction")
        if not resolved_event or resolved_event not in ["entry", "exit"]:
            resolved_event = direction

        # If camera has a strict event type filter (entry or exit), ignore mismatching directions
        if self.event_type in ["entry", "exit"]:
            if resolved_event != self.event_type:
                logger.info(f"[{self.name}] Ignoring detected {resolved_event} event because camera is configured strictly for {self.event_type}")
                return

        # Cooldown check (only for recognized employees).
        # Key is per (employee, event_type) so entry cooldown does not block exit and vice versa.
        if emp_id != 'unknown':
            now = time.time()
            cooldown_key = f"{emp_id}_{resolved_event}"
            last_seen = self.cooldowns.get(cooldown_key, 0)
            if now - last_seen < self.cooldown_seconds:
                logger.debug(f"[{self.name}] Cooldown active for {emp_id} ({resolved_event}). Skipping.")
                return
            self.cooldowns[cooldown_key] = now

        logger.info(f"[{self.name}] [CONFIRMED] Employee {emp_id} attendance logged. Event: {resolved_event}")

        # Crop raw face from the clean frame before drawing audit markings
        raw_face_base64 = ""
        if frame is not None:
            try:
                h, w = frame.shape[:2]
                x1, y1, x2, y2 = map(int, bbox)
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
        
        cv2.putText(audit_frame, f"{self.name} - {resolved_event.upper()}", (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)

        x1, y1, x2, y2 = map(int, bbox)
        if is_unknown:
            cv2.rectangle(audit_frame, (x1, y1), (x2, y2), (0, 0, 255), 2)
            cv2.putText(audit_frame, "Unknown Visitor", (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
        else:
            cv2.rectangle(audit_frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
            cv2.putText(audit_frame, f"{emp_id} ({confidence*100:.1f}%)", (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)

        is_entry_cam = 'entrance' in self.name.lower() or 'entry' in self.name.lower() or self.event_type == 'entry'
        is_exit_cam = 'exit' in self.name.lower() or self.event_type == 'exit'
        is_gate1_entry = self.name.lower() == 'gate 1 entry'
        is_gate1_exit = self.name.lower() == 'gate 1 exit'
        is_gate3_entry = self.name.lower() == 'gate 3 entry'
        is_gate3_exit = self.name.lower() == 'gate 3 exit'

        if is_gate1_entry:
            y_door = int(h * 0.44)
            x_left = int(w * 0.35)
            x_right = int(w * 0.58)
            cv2.line(audit_frame, (x_left, y_door), (x_right, y_door), (0, 0, 255), 2)
            cv2.line(audit_frame, (x_left, 0), (x_left, y_door), (0, 0, 255), 2)
            cv2.line(audit_frame, (x_right, 0), (x_right, y_door), (0, 0, 255), 2)
            mode_label = "ENTRY" if is_entry_cam else "EXIT"
            cv2.putText(audit_frame, f"GLASS DOOR {mode_label} ZONE", (x_left + 10, y_door - 10), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 2)
        elif is_gate1_exit:
            crossing_line_y = int(h * 0.55)
            x_door_left  = int(w * 0.18)
            x_door_right = int(w * 0.38)
            cv2.line(audit_frame, (x_door_left, crossing_line_y), (x_door_right, crossing_line_y), (0, 255, 255), 2)
            cv2.line(audit_frame, (x_door_left, 0), (x_door_left, crossing_line_y), (0, 255, 255), 1)
            cv2.line(audit_frame, (x_door_right, 0), (x_door_right, crossing_line_y), (0, 255, 255), 1)
            cv2.putText(audit_frame, "GATE 1 EXIT LINE", (x_door_left + 5, crossing_line_y - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 2)
        elif is_gate3_entry:
            x_left = int(w * 0.39)
            x_right_top = int(w * 0.96)
            x_right_mid = int(w * 0.87)
            y_left_bottom = int(h * 0.72)
            y_right_bottom = int(h * 0.99)
            cv2.line(audit_frame, (x_left, 0), (x_left, y_left_bottom), (0, 0, 255), 2)
            cv2.line(audit_frame, (x_right_top, 0), (x_right_mid, y_right_bottom), (0, 0, 255), 2)
            cv2.line(audit_frame, (x_left, y_left_bottom), (x_right_mid, y_right_bottom), (0, 0, 255), 2)
            cv2.putText(audit_frame, "GATE 3 ENTRY CORRIDOR", (x_left + 15, y_left_bottom - 15), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
        elif is_gate3_exit:
            x_left = int(w * 0.20)
            x_left_bottom = int(w * 0.24)
            x_right_top = int(w * 0.56)
            x_right_bottom = int(w * 0.58)
            y_left_bottom = int(h * 0.77)
            y_right_bottom = int(h * 0.63)
            cv2.line(audit_frame, (x_left, 0), (x_left_bottom, y_left_bottom), (0, 0, 255), 2)
            cv2.line(audit_frame, (x_right_top, 0), (x_right_bottom, y_right_bottom), (0, 0, 255), 2)
            cv2.line(audit_frame, (x_left_bottom, y_left_bottom), (x_right_bottom, y_right_bottom), (0, 0, 255), 2)
            cv2.putText(audit_frame, "GATE 3 EXIT CORRIDOR", (x_left_bottom + 15, y_left_bottom - 15), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
        else:
            if is_entry_cam:
                y_line = self.get_y_line(h)
                x_left = int(w * 0.35)
                x_right = int(w * 0.70)
                cv2.line(audit_frame, (0, y_line), (w, y_line), (0, 0, 255), 2)
                cv2.line(audit_frame, (x_left, 0), (x_left, h), (0, 0, 255), 2)
                cv2.line(audit_frame, (x_right, 0), (x_right, h), (0, 0, 255), 2)
                cv2.putText(audit_frame, "VIRTUAL ATTENDANCE LINE (MID)", (10, y_line - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
                cv2.putText(audit_frame, "VIRTUAL ATTENDANCE LINE (LEFT)", (x_left + 5, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
                cv2.putText(audit_frame, "VIRTUAL ATTENDANCE LINE (RIGHT)", (x_right + 10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
            elif is_exit_cam:
                y_line = self.get_y_line(h)
                x_left = int(w * 0.32)
                x_right = int(w * 0.55)
                cv2.line(audit_frame, (0, y_line), (w, y_line), (0, 0, 255), 2)
                cv2.line(audit_frame, (x_left, 0), (x_left, h), (0, 0, 255), 2)
                cv2.line(audit_frame, (x_right, 0), (x_right, h), (0, 0, 255), 2)
                cv2.putText(audit_frame, "VIRTUAL ATTENDANCE LINE (MID)", (10, y_line - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
                cv2.putText(audit_frame, "VIRTUAL ATTENDANCE LINE (LEFT)", (x_left + 5, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
                cv2.putText(audit_frame, "VIRTUAL ATTENDANCE LINE (RIGHT)", (x_right + 10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)

        for i in range(1, len(track["centroids"])):
            c_prev = tuple(map(int, track["centroids"][i-1]))
            c_curr = tuple(map(int, track["centroids"][i]))
            cv2.line(audit_frame, c_prev, c_curr, (255, 255, 0), 2)
            cv2.circle(audit_frame, c_curr, 4, (0, 255, 255), -1)

        crossing_pt = track.get("crossing_point")
        if crossing_pt is not None:
            cv2.circle(audit_frame, tuple(map(int, crossing_pt)), 8, (0, 255, 255), -1)

        video_url = ""
        frames_buffer = track.get("frames_buffer", [])
        if len(frames_buffer) > 0:
            try:
                out_dir = r"D:\Whatsapp Attendance Tracking\public\uploads\camera_videos"
                os.makedirs(out_dir, exist_ok=True)
                video_filename = f"video_{int(time.time() * 1000)}_{emp_id}.mp4"
                video_path = os.path.join(out_dir, video_filename)
                
                h_f, w_f = frames_buffer[0].shape[:2]
                # Try H.264 avc1 codec first (supported via openh264 DLL)
                fourcc = cv2.VideoWriter_fourcc(*'avc1')
                out = cv2.VideoWriter(video_path, fourcc, 15.0, (w_f, h_f))
                
                # Fallback 1: MPEG-4 Part 2
                if not out.isOpened():
                    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
                    out = cv2.VideoWriter(video_path, fourcc, 15.0, (w_f, h_f))
                
                # Fallback 2: WebM VP8
                if not out.isOpened():
                    video_filename = f"video_{int(time.time() * 1000)}_{emp_id}.webm"
                    video_path = os.path.join(out_dir, video_filename)
                    fourcc = cv2.VideoWriter_fourcc(*'VP80')
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

        _, buffer = cv2.imencode('.jpg', audit_frame)
        jpg_as_text = base64.b64encode(buffer).decode('utf-8')

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
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (21, 21), 0)
        fg_mask = self.bg_subtractor.apply(gray)
        _, fg_mask = cv2.threshold(fg_mask, 25, 255, cv2.THRESH_BINARY)
        fg_mask = cv2.dilate(fg_mask, None, iterations=2)
        
        contours, _ = cv2.findContours(fg_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        detections = []
        for c in contours:
            area = cv2.contourArea(c)
            if area > 2000:
                (x, y, w, h) = cv2.boundingRect(c)
                cx = int(x + w / 2)
                cy = int(y + h / 2)
                detections.append({
                    "bbox": [x, y, x + w, y + h],
                    "centroid": (cx, cy)
                })
        
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

        if not track["crossed"] and segments_intersect(p1, p2, prev_centroid, curr_centroid):
            direction = crossing_direction(p1, p2, prev_centroid, curr_centroid)
            if self.invert_direction:
                direction = "exit" if direction == "entry" else "entry"
            track["crossed"] = True
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
        camera_role = self.event_type
        
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

        overlay = audit_frame.copy()
        cv2.rectangle(overlay, (10, 10), (320, 115), (0, 0, 0), -1)
        cv2.addWeighted(overlay, 0.6, audit_frame, 0.4, 0, audit_frame)
        cv2.rectangle(audit_frame, (10, 10), (320, 115), (0, 255, 255), 1)
        cv2.putText(audit_frame, f"DUAL-CAMERA CORRELATION ({event_type.upper()})", (15, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(audit_frame, f"[OK] 1. Face Recognized on opposite Cam", (20, 48), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1, cv2.LINE_AA)
        cv2.putText(audit_frame, f"     Employee: {emp_id}", (20, 64), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (200, 200, 200), 1, cv2.LINE_AA)
        cv2.putText(audit_frame, f"[OK] 2. Motion Confirmed on this Cam", (20, 84), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1, cv2.LINE_AA)
        cv2.putText(audit_frame, f"[OK] 3. Time Correlated (Match < 5s)", (20, 104), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1, cv2.LINE_AA)

        _, buffer = cv2.imencode('.jpg', audit_frame)
        jpg_as_text = base64.b64encode(buffer).decode('utf-8')
        status_text = f"Verified Correlated {event_type.capitalize()}"
        self.report_attendance(emp_id, confidence, jpg_as_text, event_type, status_text)

    def stop_capture(self):
        self.running = False


def start_cctv_thread(camera_id, name, source, site_name, event_type, threshold=0.38, node_server="http://localhost:3000", invert_direction=False, y_line_percent=None):
    with active_cameras_lock:
        if camera_id in active_cameras:
            existing = active_cameras[camera_id]
            # Check if camera is alive and configuration parameters match
            if (existing.running and existing.is_alive() and
                existing.source == source and
                existing.name == name and
                existing.threshold == threshold and
                existing.invert_direction == invert_direction and
                getattr(existing, '_y_line_percent', None) == y_line_percent):
                logger.info(f"Camera thread {camera_id} is already running with identical configuration. Skipping restart.")
                return True
                
            logger.info(f"Camera thread {camera_id} is already running. Stopping it...")
            existing.stop_capture()
            existing.join(timeout=5.0)
            if existing.is_alive():
                logger.warning(f"Old camera thread {camera_id} did not stop within 5 seconds. Forcing removal from active cache.")
            del active_cameras[camera_id]
            
        processor = CCTVStreamProcessor(camera_id, name, source, site_name, event_type, threshold, node_server, invert_direction)
        processor._y_line_percent = y_line_percent  # None = use default; float = override
        processor.daemon = True
        processor.start()
        active_cameras[camera_id] = processor
        logger.info(f"Started CCTV background thread for camera {camera_id} (y_line_percent={y_line_percent})")
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
