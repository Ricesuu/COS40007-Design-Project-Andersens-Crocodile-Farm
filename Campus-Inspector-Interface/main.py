"""
Campus Infrastructure AI Inspector — FastAPI Backend
=====================================================
Production-grade REST API for multi-model YOLO inference
with engineering telemetry (ACI) and triage classification.
"""

from __future__ import annotations

import base64
import io
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from sahi import AutoDetectionModel
from sahi.predict import get_sliced_prediction
from ultralytics import YOLO

# ---------------------------------------------------------------------------
# Application factory & Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup check
    device = _resolve_device()
    print(f"[startup] Device selected: {device}")
    print(f"[startup] Available models: {list(_MODEL_PATHS.keys())}")
    yield
    # Shutdown cleanup
    if _MEDIA_DIR.exists():
        shutil.rmtree(_MEDIA_DIR, ignore_errors=True)
        print("[shutdown] Cleaned up media directory")


app = FastAPI(
    title="Campus Infrastructure AI Inspector",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# Global model cache with lazy-loading & thread-safety
# ---------------------------------------------------------------------------

_MODEL_PATHS: Dict[str, str] = {
    "3cls-s":  "3cls_s.pt",
    "3cls-m":  "3cls_m.pt",
    "3cls-v5": "yolov5su.pt",
    "6cls-s":  "yolov8s.pt",
    "6cls-m":  "yolov8m.pt",
}

_model_cache: Dict[str, YOLO] = {}
_model_lock = threading.Lock()

# Colour palette per defect class (BGR for OpenCV); fallback gray for unknowns
_CLASS_COLOURS: Dict[str, Tuple[int, int, int]] = {
    "crack":                 (0, 0, 255),
    "delamination":          (0, 255, 0),
    "stain":                 (0, 165, 255),
    "exposed_reinforcement": (0, 140, 255),
    "rust_stain":            (0, 200, 255),
    "spalling":              (255, 0, 180),
    "efflorescence":         (0, 255, 200),
}

# Temporary directory for processed video output
_MEDIA_DIR = Path("./media_tmp") if Path("./media_tmp").exists() else Path(tempfile.gettempdir()) / "campus_inspector_media"
_MEDIA_DIR.mkdir(parents=True, exist_ok=True)


def _resolve_device() -> str:
    """Return the best available torch device."""
    return "cuda" if torch.cuda.is_available() else "cpu"


def _format_class_name(name: str) -> str:
    """Normalize and format class names (e.g. 'exposed_reinforcement' -> 'Exposed Reinforcement')."""
    return name.replace("_", " ").title()


def _get_model(model_name: str) -> YOLO:
    """Lazily load and cache a YOLO model.  Thread-safe."""
    if model_name not in _MODEL_PATHS:
        raise ValueError(
            f"Unknown model '{model_name}'. "
            f"Available: {list(_MODEL_PATHS.keys())}"
        )

    if model_name not in _model_cache:
        with _model_lock:
            # Double-checked locking
            if model_name not in _model_cache:
                device = _resolve_device()
                path = _MODEL_PATHS[model_name]
                _model_cache[model_name] = YOLO(path).to(device)

    return _model_cache[model_name]


# ---------------------------------------------------------------------------
# Engineering telemetry — Asset Condition Index (ACI) & Triage
# ---------------------------------------------------------------------------

def _compute_aci(
    boxes: List[Tuple[float, float, float, float]],
    image_width: int,
    image_height: int,
) -> float:
    """Return the Defect Ratio (0-1)."""
    if not boxes:
        return 0.0
    total_image_area = float(image_width * image_height)
    if total_image_area == 0:
        return 0.0
    total_box_area = sum(
        (x2 - x1) * (y2 - y1) for x1, y1, x2, y2 in boxes
    )
    return total_box_area / total_image_area


def _classify_triage(
    defects: List[Dict[str, Any]],
    defect_ratio: float,
) -> Tuple[str, str]:
    """
    Apply the engineering triage matrix.

    Returns (level, advisory_text).
    """
    class_names = {d["class"].lower() for d in defects}

    # --- Critical (Red) ---
    if "delamination" in class_names or defect_ratio > 0.15:
        return (
            "critical",
            "Structural anomaly detected. "
            "Immediate engineering inspection required. "
            "Evacuate area if delamination is confirmed and cordon "
            "off zone pending physical assessment.",
        )

    # Count cracks above 0.5 confidence
    crack_count = sum(
        1 for d in defects
        if d["class"].lower() == "crack" and d["confidence"] >= 0.5
    )
    stain_high_conf = any(
        d["class"].lower() == "stain" and d["confidence"] >= 0.7
        for d in defects
    )

    # --- Attention (Amber) ---
    if crack_count > 1 or stain_high_conf:
        return (
            "attention",
            "ATTENTION: Multiple surface cracks or high-confidence "
            "staining detected. Schedule a detailed inspection within "
            "the next maintenance cycle. Monitor for propagation.",
        )

    # --- Monitor (Green) ---
    return (
        "monitor",
        "MONITOR: Asset condition within acceptable parameters. "
        "Continue routine inspection schedule. No immediate "
        "action required.",
    )


# ---------------------------------------------------------------------------
# Reusable defect extraction from YOLO results
# ---------------------------------------------------------------------------

def _extract_defects(
    results_result: Any,
    start_id: int = 1,
) -> Tuple[List[Dict[str, Any]], List[Tuple[float, float, float, float]]]:
    """
    Pull defect metadata and raw bounding-box coords from a single
    ultralytics Results object.
    """
    defects: List[Dict[str, Any]] = []
    boxes_raw: List[Tuple[float, float, float, float]] = []

    if results_result.boxes is None:
        return defects, boxes_raw

    boxes_xyxy = results_result.boxes.xyxy.cpu().numpy()
    confs = results_result.boxes.conf.cpu().numpy()
    cls_ids = results_result.boxes.cls.cpu().numpy().astype(int)
    names = results_result.names if hasattr(results_result, "names") else {}

    for idx, (box, conf, cls_id) in enumerate(
        zip(boxes_xyxy, confs, cls_ids), start=start_id
    ):
        x1, y1, x2, y2 = float(box[0]), float(box[1]), float(box[2]), float(box[3])
        area = round((x2 - x1) * (y2 - y1), 2)
        cls_name = names.get(cls_id, f"class_{cls_id}")
        formatted_name = _format_class_name(cls_name)

        defects.append({
            "id": idx,
            "class": formatted_name,
            "confidence": round(float(conf), 4),
            "area_px": area,
            "x1": round(x1, 2),
            "y1": round(y1, 2),
            "x2": round(x2, 2),
            "y2": round(y2, 2),
        })
        boxes_raw.append((x1, y1, x2, y2))

    return defects, boxes_raw
# Helpers
# ---------------------------------------------------------------------------

def _pil_to_cv2(pil_image: Image.Image) -> np.ndarray:
    """Convert PIL RGB → OpenCV BGR numpy array."""
    return cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)


def _cv2_to_base64_uri(cv2_image: np.ndarray) -> str:
    """Encode an OpenCV BGR image as a base64 data URI (JPEG)."""
    success, buffer = cv2.imencode(".jpg", cv2_image)
    if not success:
        raise RuntimeError("Failed to encode annotated image to JPEG")
    b64_str = base64.b64encode(buffer).decode("utf-8")
    return f"data:image/jpeg;base64,{b64_str}"


def _draw_annotations(
    cv2_image: np.ndarray,
    defects: List[Dict[str, Any]],
) -> np.ndarray:
    """Draw bounding boxes and labels on a copy of the image."""
    annotated = cv2_image.copy()
    for defect in defects:
        x1 = int(defect["x1"])
        y1 = int(defect["y1"])
        x2 = int(defect["x2"])
        y2 = int(defect["y2"])
        cls_name = defect["class"].lower().replace(" ", "_")
        conf = defect["confidence"]
        
        # FIX 1: Safely fallback to a generic gray (180, 180, 180) without causing a KeyError
        colour = _CLASS_COLOURS.get(cls_name, (180, 180, 180))

        # Draw the structural bounding box border
        cv2.rectangle(annotated, (x1, y1), (x2, y2), colour, 2)
        
        # Setup Text
        label_text = f"{defect['class']} {conf:.2f}"
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.75
        thickness = 2
        
        # Calculate the physical pixel size of the text block
        (text_width, text_height), baseline = cv2.getTextSize(label_text, font, font_scale, thickness)
        
        # FIX 2: Smart Label Placement (Prevents clipping at the top edge of the image)
        if y1 < text_height + 15:
            text_y = y1 + text_height + 6
            bg_y1 = y1
            bg_y2 = y1 + text_height + 12
        else:
            text_y = y1 - 6
            bg_y1 = y1 - text_height - 12
            bg_y2 = y1
            
        bg_x2 = x1 + text_width + 10
        
        # Draw a solid background rectangle behind the text
        cv2.rectangle(annotated, (x1, bg_y1), (bg_x2, bg_y2), colour, -1)
        
        # Render the crisp white text over the solid background
        cv2.putText(annotated, label_text, (x1 + 5, text_y), font, font_scale, (255, 255, 255), thickness)
        
    return annotated


# ---------------------------------------------------------------------------
# Video processing
# ---------------------------------------------------------------------------

_VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
_VIDEO_CONTENT_TYPES = {"video/mp4", "video/quicktime", "video/x-msvideo",
                         "video/webm", "video/x-matroska"}
_MAX_VIDEO_SECONDS = 5.0


def _process_video(
    file_bytes: bytes,
    model_name: str,
    conf_threshold: float,
    iou_threshold: float,
) -> Dict[str, Any]:
    """
    Process a short video clip frame-by-frame with YOLO inference.

    Limits processing to _MAX_VIDEO_SECONDS of video, aggregates the
    highest defect ratio and all unique defects across frames, and
    writes an annotated .mp4 to _MEDIA_DIR.

    Returns the standard JSON-serialisable dict.
    """
    tmp_in = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    try:
        tmp_in.write(file_bytes)
        tmp_in.close()

        cap = cv2.VideoCapture(tmp_in.name)
        if not cap.isOpened():
            raise RuntimeError("OpenCV could not open the uploaded video file")

        fps = cap.get(cv2.CAP_PROP_FPS)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        if fps <= 0:
            fps = 30.0
        max_frames = int(_MAX_VIDEO_SECONDS * fps)

        out_filename = f"{uuid.uuid4().hex}.mp4"
        out_path = str(_MEDIA_DIR / out_filename)

        # Try avc1 (H.264 web-compatible), fall back to mp4v
        fourcc = cv2.VideoWriter_fourcc(*"avc1")
        writer = cv2.VideoWriter(out_path, fourcc, fps, (width, height))
        if not writer.isOpened():
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            writer = cv2.VideoWriter(out_path, fourcc, fps, (width, height))
        if not writer.isOpened():
            raise RuntimeError("No suitable video codec available (avc1 / mp4v)")

        model = _get_model(model_name)
        t_start = time.perf_counter()

        highest_defect_ratio = 0.0
        all_defects: List[Dict[str, Any]] = []
        seen_defect_keys: set = set()
        frame_idx = 0

        while frame_idx < max_frames:
            ret, frame = cap.read()
            if not ret:
                break

            results = model(frame, conf=conf_threshold, iou=iou_threshold)
            fdefects, fboxes = _extract_defects(results[0], start_id=1)

            if height > 0 and width > 0:
                fdr = _compute_aci(fboxes, width, height)
                if fdr > highest_defect_ratio:
                    highest_defect_ratio = fdr

            for d in fdefects:
                key = f"{d['class']}_{d['x1']:.0f}_{d['y1']:.0f}_{d['x2']:.0f}_{d['y2']:.0f}"
                if key not in seen_defect_keys:
                    seen_defect_keys.add(key)
                    all_defects.append(d)

            annotated = _draw_annotations(frame, fdefects)
            writer.write(annotated)
            frame_idx += 1

        t_end = time.perf_counter()
        latency_ms = round((t_end - t_start) * 1000, 1)

        writer.release()
        cap.release()

        # Re-encode to H.264 so browsers can play it (mp4v fallback is not browser-compatible)
        h264_filename = f"{uuid.uuid4().hex}.mp4"
        h264_path = str(_MEDIA_DIR / h264_filename)
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", out_path,
                 "-vcodec", "libx264", "-pix_fmt", "yuv420p",
                 "-movflags", "+faststart", h264_path],
                check=True, capture_output=True,
            )
            os.unlink(out_path)
            out_filename = h264_filename
            out_path = h264_path
        except (subprocess.CalledProcessError, FileNotFoundError):
            pass  # ffmpeg unavailable — keep mp4v (works locally on Windows)

        for i, d in enumerate(all_defects, start=1):
            d["id"] = i

        triage_level, advisory_text = _classify_triage(
            all_defects, highest_defect_ratio
        )

        return {
            "media_url": f"/api/media/{out_filename}",
            "is_video": True,
            "latency_ms": latency_ms,
            "triage_level": triage_level,
            "advisory_text": advisory_text,
            "defect_ratio": round(highest_defect_ratio, 6),
            "defect_count": len(all_defects),
            "defects": all_defects,
        }

    finally:
        if os.path.exists(tmp_in.name):
            os.unlink(tmp_in.name)


# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------

@app.post("/api/detect")
async def api_detect(
    file: UploadFile = File(...),
    model_name: str = Form("yolov8s"),
    conf_threshold: float = Form(0.25),
    iou_threshold: float = Form(0.45),
    sahi_enabled: bool = Form(False),
    sahi_slice_size: int = Form(704),
    allowed_classes: str = Form(""),
) -> JSONResponse:
    """
    Run YOLO inference on the uploaded image or video.

    Returns JSON with annotated image (base64) or video URL, latency,
    triage classification, advisory text, and per-defect metadata.
    """
    # --- Validate inputs ---------------------------------------------------
    ct = file.content_type or ""
    is_video = (
        ct in _VIDEO_CONTENT_TYPES
        or ct.startswith("video/")
    )
    is_image = ct.startswith("image/")

    if not (is_image or is_video):
        raise HTTPException(
            400,
            "Uploaded file must be an image or video "
            "(JPG, PNG, MP4, MOV, AVI, WEBM).",
        )

    if model_name not in _MODEL_PATHS:
        raise HTTPException(
            400,
            f"Unknown model '{model_name}'. "
            f"Choose from: {list(_MODEL_PATHS.keys())}",
        )

    # Load model early so we can use model.names as the class default
    model = _get_model(model_name)

    # --- Parse allowed class IDs ------------------------------------------
    try:
        class_ids = [int(c.strip()) for c in allowed_classes.split(",") if c.strip()]
        if not class_ids:
            class_ids = list(model.names.keys())
    except ValueError:
        class_ids = list(model.names.keys())

    # Clamp thresholds
    conf_threshold = max(0.01, min(0.99, conf_threshold))
    iou_threshold = max(0.01, min(0.99, iou_threshold))

    contents = await file.read()

    # --- Video branch -----------------------------------------------------
    if is_video:
        result = _process_video(
            contents, model_name, conf_threshold, iou_threshold
        )
        return JSONResponse(result)

    # --- Image branch -----------------------------------------------------
    try:
        pil_image = Image.open(io.BytesIO(contents)).convert("RGB")
    except Exception:
        raise HTTPException(400, "Unable to decode the uploaded image")

    cv2_image = _pil_to_cv2(pil_image)
    img_h, img_w = cv2_image.shape[:2]

    t_start = time.perf_counter()

    # --- SAHI sliced inference branch ------------------------------------
    if sahi_enabled:
        valid_sizes = {512, 704, 1024}
        if sahi_slice_size not in valid_sizes:
            sahi_slice_size = 704

        detection_model = AutoDetectionModel.from_pretrained(
            model_type="yolov8",
            model_path=_MODEL_PATHS[model_name],
            confidence_threshold=conf_threshold,
            device=_resolve_device(),
        )

        sahi_result = get_sliced_prediction(
            pil_image,
            detection_model,
            slice_height=sahi_slice_size,
            slice_width=sahi_slice_size,
            overlap_height_ratio=0.2,
            overlap_width_ratio=0.2,
        )

        defects: List[Dict[str, Any]] = []
        boxes_raw: List[Tuple[float, float, float, float]] = []
        for idx, obj_pred in enumerate(sahi_result.object_prediction_list, start=1):
            # Filter by allowed class IDs
            if obj_pred.category.id not in class_ids:
                continue
            bbox = obj_pred.bbox
            x1, y1, x2, y2 = bbox.minx, bbox.miny, bbox.maxx, bbox.maxy
            area = round((x2 - x1) * (y2 - y1), 2)
            cls_name = obj_pred.category.name
            formatted_name = _format_class_name(cls_name)
            conf = round(float(obj_pred.score.value), 4)

            defects.append({
                "id": idx,
                "class": formatted_name,
                "confidence": conf,
                "area_px": area,
                "x1": round(x1, 2),
                "y1": round(y1, 2),
                "x2": round(x2, 2),
                "y2": round(y2, 2),
            })
            boxes_raw.append((x1, y1, x2, y2))

        # Re-number after filtering
        for i, d in enumerate(defects, start=1):
            d["id"] = i
    else:
        results = model(cv2_image, conf=conf_threshold, iou=iou_threshold, classes=class_ids)
        defects, boxes_raw = _extract_defects(results[0], start_id=1)

    t_end = time.perf_counter()
    latency_ms = round((t_end - t_start) * 1000, 1)

    defect_ratio = _compute_aci(boxes_raw, img_w, img_h)
    triage_level, advisory_text = _classify_triage(defects, defect_ratio)

    annotated = _draw_annotations(cv2_image, defects)
    image_base64 = _cv2_to_base64_uri(annotated)

    return JSONResponse({
        "image_base64": image_base64,
        "is_video": False,
        "latency_ms": latency_ms,
        "triage_level": triage_level,
        "advisory_text": advisory_text,
        "defect_ratio": round(defect_ratio, 6),
        "defect_count": len(defects),
        "defects": defects,
    })


# ---------------------------------------------------------------------------
# Model info (class list)
# ---------------------------------------------------------------------------

@app.get("/api/model-info")
async def api_model_info(model_name: str = "yolov8s") -> JSONResponse:
    """Return the class list for the given model, derived from model.names."""
    if model_name not in _MODEL_PATHS:
        raise HTTPException(
            400,
            f"Unknown model '{model_name}'. "
            f"Choose from: {list(_MODEL_PATHS.keys())}",
        )
    model = _get_model(model_name)
    classes = [
        {"id": int(k), "name": _format_class_name(v)}
        for k, v in sorted(model.names.items())
    ]
    return JSONResponse({"classes": classes})


# ---------------------------------------------------------------------------
# Media file serving (processed videos)
# ---------------------------------------------------------------------------

@app.get("/api/media/{filename}")
async def serve_media(filename: str) -> FileResponse:
    """Serve a temporary processed video file."""
    path = _MEDIA_DIR / filename
    if not path.exists():
        raise HTTPException(404, "Media file not found or expired")
    return FileResponse(
        path,
        media_type="video/mp4",
        headers={"Accept-Ranges": "bytes"},
    )


# ---------------------------------------------------------------------------
# Static file serving (must be registered AFTER API routes)
# ---------------------------------------------------------------------------

@app.get("/")
async def serve_index() -> FileResponse:
    """Serve the SPA entry point."""
    return FileResponse("static/index.html")


# Mount /static so index.html can reference style.css and app.js
app.mount("/static", StaticFiles(directory="static"), name="static")


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Execution entry point
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=7860, reload=True)
