# COS40007 Design Project — Andersen's Crocodile Farm

AI-powered structural defect detection for campus building inspection.

**Demo:** [Campus Inspector on Hugging Face Spaces](https://huggingface.co/spaces/zynapse/COS40007-Campus-Inspector)  
**Fallback:** https://huggingface.co/spaces/Ricesuu/COS40007-Campus-Inspector

---

## Project Structure

```
.
├── Training Scripts/
│   ├── Pipeline1.ipynb          # Training pipeline: EDA, 3-model training, evaluation
│   └── Pipeline2.ipynb          # (coming soon)
│
├── Training Results/
│   ├── Pipeline1/
│   │   ├── YOLOv8s_Run/         # Baseline small model results
│   │   ├── YOLOv8m_Run/         # Medium model results
│   │   └── YOLOv5su_Run/        # Classic anchor-based model results
│   └── Pipeline2/               # (coming soon)
│
└── Campus-Inspector-Interface/  # Web app (FastAPI + Docker, hosted on HF Spaces)
    ├── main.py                  # FastAPI backend — YOLO inference, SAHI tiling, ACI scoring
    ├── static/                  # Frontend (HTML/CSS/JS)
    ├── 3cls_m.pt                # Fine-tuned YOLOv8m weights (3-class)
    ├── 3cls_s.pt                # Fine-tuned YOLOv8s weights (3-class)
    ├── Dockerfile
    └── requirements.txt
```

## Models & Classes

Three models were trained and compared on a 1,640-image dataset:

| Model | Architecture |
|-------|-------------|
| YOLOv8s | Small, anchor-free (baseline) |
| YOLOv8m | Medium, anchor-free |
| YOLOv5su | Classic anchor-based |

**Detected defect classes:** Crack · Delamination · Stain

## Pipeline 1 — Training



Run `Training Scripts/Pipeline1.ipynb` on Google Colab (GPU recommended). The notebook covers:
1. Environment setup & dataset download (Roboflow)
2. EDA — class distribution and sample annotations
3. Training runs for all three models (100 epochs, img 832, AdamW + cosine LR)
4. Test-set evaluation with mAP@0.5 and per-class AP
5. Export of weights and result charts

## Pipeline 2 — Training

> Coming soon.
