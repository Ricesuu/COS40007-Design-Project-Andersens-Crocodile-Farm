# COS40007 Design Project — Andersen's Crocodile Farm

AI-powered structural defect detection for campus building inspection.

**Demo:** [Campus Inspector on Hugging Face Spaces](https://huggingface.co/spaces/zynapse/COS40007-Campus-Inspector)  
**Fallback:** https://huggingface.co/spaces/Ricesuu/COS40007-Campus-Inspector

---

## Project Structure

```
.
├── Training Scripts/
│   ├── Pipeline1.ipynb          # 3-class model training (Roboflow dataset)
│   └── Pipeline2.ipynb          # 6-class model training (HuggingFace dataset)
│
├── Training Results/
│   ├── Pipeline1/
│   │   ├── YOLOv8s_Run/         # Baseline small model results + weights
│   │   ├── YOLOv8m_Run/         # Medium model results + weights
│   │   └── YOLOv5su_Run/        # Classic anchor-based model results + weights
│   └── Pipeline2/
│       ├── YOLOv8s_Run/         # Small model results + weights
│       └── YOLOv8m_Run/         # Medium model results + weights
│
└── Campus-Inspector-Interface/  # Web app (FastAPI + Docker, hosted on HF Spaces)
    ├── main.py                  # FastAPI backend — YOLO inference, SAHI tiling, ACI scoring
    ├── static/                  # Frontend (HTML/CSS/JS)
    ├── yolov8s.pt               # YOLOv8s weights — 6-class (Pipeline 2)
    ├── yolov8m.pt               # YOLOv8m weights — 6-class (Pipeline 2)
    ├── yolov5su.pt              # YOLOv5su weights — 3-class (Pipeline 1)
    ├── 3cls_s.pt                # YOLOv8s weights — 3-class (Pipeline 1)
    ├── 3cls_m.pt                # YOLOv8m weights — 3-class (Pipeline 1)
    ├── Dockerfile
    └── requirements.txt
```

---

## Pipeline 1 — Training

**Dataset:** 1,640 images (1,458 train / 91 val / 91 test) — sourced from Roboflow  
**Classes (3):** Crack · Delamination · Stain  
**Models:** YOLOv8s · YOLOv8m · YOLOv5su

Run `Training Scripts/Pipeline1.ipynb` on Google Colab (GPU recommended). The notebook covers:
1. Environment setup & dataset download (Roboflow)
2. EDA — class distribution and sample annotations
3. Training runs for all three models (100 epochs, img 832, AdamW + cosine LR)
4. Test-set evaluation with mAP@0.5 and per-class AP
5. Export of weights and result charts

## Pipeline 2 — Training

**Dataset:** 7,353 images (5,882 train / 735 val / 736 test) — sourced from HuggingFace (`xueaidezhouzhou/buildingsurfacedefectdetection`)  
**Classes (6):** Crack · Delamination · Exposed Reinforcement · Rust Stain · Spalling · Efflorescence  
**Models:** YOLOv8s · YOLOv8m

Run `Training Scripts/Pipeline2.ipynb` on Google Colab (GPU recommended). The notebook covers:
1. Environment setup & dataset download (HuggingFace, .7z archive)
2. EDA — class distribution and sample annotations
3. YOLOv8s baseline run with defect-specific augmentations (copy-paste, mosaic, scale/colour jitter)
4. YOLOv8m optimised run (dropout + lower LR to address overfitting)
5. Test-set evaluation with mAP@0.5 and per-class AP
