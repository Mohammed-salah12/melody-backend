"""
Train Melody's skin model from doctor-graded scan photos.

    npm run export:dataset -- ./dataset          # from the backend folder
    pip install -r ml/requirements.txt
    python3 ml/train.py --data ./dataset --out ./ml-model

What it does
  * Fine-tunes a small pretrained image network (MobileNetV3) to predict the doctors' 1–5 grades
    for hydration, oil, redness, dark spots, texture, pores and fine lines from the face crop.
  * Splits by PERSON (nobody is in both training and validation), so the scores are honest.
  * Compares the model with the current rule-based scanner on the same validation photos, overall
    and per skin tone (Fitzpatrick I–II / III–IV / V–VI).
  * Writes melody-skin.onnx + model.json. model.json holds per-measurement blend weights: a
    measurement only uses the model where it beat the rules, and the weight is capped if the model
    is clearly worse on one skin-tone group. The backend picks the files up on its next start.

Nothing is shipped blindly: read report.json, and only copy ml-model/ to the server if you're happy.
"""
import argparse
import csv
import json
import math
import os
import random
import time

import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms

LABELS = ["hydration", "oil", "redness", "pigmentation", "texture", "pores", "wrinkles"]
MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]
TONE_GROUPS = {"I–II": (1, 2), "III–IV": (3, 4), "V–VI": (5, 6)}


def read_rows(data_dir):
    with open(os.path.join(data_dir, "labels.csv"), newline="") as f:
        rows = [r for r in csv.DictReader(f) if os.path.exists(os.path.join(data_dir, "images", r["id"] + ".jpg"))]
    for r in rows:
        r["y"] = [float(r[k]) for k in LABELS]
        r["rule"] = [float(r[f"rule_{k}"]) / 100 * 4 + 1 if r.get(f"rule_{k}") not in (None, "") else math.nan for k in LABELS]
        r["tone"] = int(r["fitzpatrick"]) if r.get("fitzpatrick") else 0
    return rows


def split_by_person(rows, val_share, seed):
    people = sorted({r["user"] for r in rows})
    random.Random(seed).shuffle(people)
    n_val = max(1, round(len(people) * val_share))
    val_people = set(people[:n_val])
    return [r for r in rows if r["user"] not in val_people], [r for r in rows if r["user"] in val_people]


class Faces(Dataset):
    def __init__(self, rows, data_dir, size, train):
        self.rows, self.dir = rows, data_dir
        # colour is part of the signal (redness, tone), so augmentation never changes hue
        aug = [transforms.RandomResizedCrop(size, scale=(0.85, 1.0), ratio=(0.95, 1.05)), transforms.RandomHorizontalFlip(),
               transforms.ColorJitter(brightness=0.08, contrast=0.08)] if train else [transforms.Resize(size), transforms.CenterCrop(size)]
        self.tf = transforms.Compose(aug + [transforms.ToTensor(), transforms.Normalize(MEAN, STD)])

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        r = self.rows[i]
        img = Image.open(os.path.join(self.dir, "images", r["id"] + ".jpg")).convert("RGB")
        return self.tf(img), torch.tensor(r["y"], dtype=torch.float32)


class SkinNet(nn.Module):
    def __init__(self, pretrained):
        super().__init__()
        weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
        self.backbone = models.mobilenet_v3_small(weights=weights)
        n = self.backbone.classifier[0].in_features
        self.backbone.classifier = nn.Sequential(nn.Linear(n, 256), nn.Hardswish(), nn.Dropout(0.2), nn.Linear(256, len(LABELS)))

    def forward(self, x):
        # grades live on 1–5
        return 1 + 4 * torch.sigmoid(self.backbone(x))


def mae_by(rows, preds, key):
    """MAE per label for model predictions or rule baseline."""
    out = {}
    for j, k in enumerate(LABELS):
        pairs = [(p[j], r["y"][j]) for r, p in zip(rows, preds) if not math.isnan(p[j])]
        out[k] = round(sum(abs(a - b) for a, b in pairs) / len(pairs), 3) if pairs else None
    return out


def spearman(a, b):
    if len(a) < 3:
        return None
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    c = np.corrcoef(ra, rb)[0, 1]
    return None if np.isnan(c) else round(float(c), 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=25)
    ap.add_argument("--size", type=int, default=224)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--val", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--no-pretrained", action="store_true", help="train from scratch (only for testing the pipeline)")
    ap.add_argument("--min-photos", type=int, default=300)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rows = read_rows(args.data)
    print(f"{len(rows)} graded photos from {len({r['user'] for r in rows})} people")
    if len(rows) < args.min_photos:
        print(f"WARNING: fewer than {args.min_photos} photos — the model will be weak and will most likely NOT beat the rules. "
              "Blend weights will reflect that (it will barely be used).")
    train_rows, val_rows = split_by_person(rows, args.val, args.seed)
    print(f"train {len(train_rows)} · validation {len(val_rows)} (split by person)")

    dev = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    model = SkinNet(pretrained=not args.no_pretrained).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    loss_fn = nn.SmoothL1Loss()
    tl = DataLoader(Faces(train_rows, args.data, args.size, True), batch_size=args.batch, shuffle=True, num_workers=0)
    vl = DataLoader(Faces(val_rows, args.data, args.size, False), batch_size=args.batch, shuffle=False, num_workers=0)

    def predict(loader):
        model.eval()
        out = []
        with torch.no_grad():
            for x, _ in loader:
                out.extend(model(x.to(dev)).cpu().numpy().tolist())
        return out

    best, best_state = 1e9, None
    for epoch in range(1, args.epochs + 1):
        model.train()
        total = 0.0
        for x, y in tl:
            x, y = x.to(dev), y.to(dev)
            opt.zero_grad()
            loss = loss_fn(model(x), y)
            loss.backward()
            opt.step()
            total += loss.item() * len(x)
        sched.step()
        preds = predict(vl)
        val_mae = np.mean([abs(p[j] - r["y"][j]) for r, p in zip(val_rows, preds) for j in range(len(LABELS))])
        print(f"epoch {epoch:02d}  train loss {total / max(1, len(train_rows)):.3f}  val MAE {val_mae:.3f}")
        if val_mae < best:
            best, best_state = val_mae, {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)

    # ---------- honest comparison with the rule-based scanner ----------
    preds = predict(vl)
    model_mae = mae_by(val_rows, preds, "model")
    rule_mae = mae_by(val_rows, [r["rule"] for r in val_rows], "rule")
    per_tone = {}
    for g, (lo, hi) in TONE_GROUPS.items():
        idx = [i for i, r in enumerate(val_rows) if lo <= r["tone"] <= hi]
        if len(idx) >= 5:
            per_tone[g] = {"photos": len(idx), "model": mae_by([val_rows[i] for i in idx], [preds[i] for i in idx], "m"),
                           "rules": mae_by([val_rows[i] for i in idx], [val_rows[i]["rule"] for i in idx], "r")}
    corr = {k: spearman([p[j] for p in preds], [r["y"][j] for r in val_rows]) for j, k in enumerate(LABELS)}

    blend, notes = {}, []
    for k in LABELS:
        m, r = model_mae[k], rule_mae[k]
        w = 0.0
        if m is not None and len(val_rows) >= 30:
            w = 0.8 if r is None else max(0.0, min(0.8, (r - m) / r * 1.5))
        # fairness guard: if the model is much worse for one skin-tone group, limit its say
        tone_m = [v["model"][k] for v in per_tone.values() if v["model"][k] is not None]
        if len(tone_m) >= 2 and max(tone_m) > 1.5 * min(tone_m):
            w = min(w, 0.3)
            notes.append(f"{k}: model is much less accurate on one skin-tone group — weight capped at 0.3")
        blend[k] = round(w, 2)
    if len(val_rows) < 30:
        notes.append("fewer than 30 validation photos — all blend weights set to 0 (the model is not used yet)")

    os.makedirs(args.out, exist_ok=True)
    model.eval().cpu()
    dummy = torch.randn(1, 3, args.size, args.size)
    torch.onnx.export(model, dummy, os.path.join(args.out, "melody-skin.onnx"), input_names=["image"], output_names=["grades"],
                      dynamic_axes={"image": {0: "batch"}, "grades": {0: "batch"}}, opset_version=17, dynamo=False)
    version = time.strftime("skin-%Y%m%d-%H%M")
    meta = {"version": version, "outputs": LABELS, "inputSize": args.size, "mean": MEAN, "std": STD, "blend": blend,
            "trainedOn": len(train_rows), "validatedOn": len(val_rows), "pretrained": not args.no_pretrained}
    report = {"version": version, "validation_mae": {"model": model_mae, "rules": rule_mae}, "spearman": corr, "per_skin_tone": per_tone, "blend": blend, "notes": notes}
    with open(os.path.join(args.out, "model.json"), "w") as f:
        json.dump(meta, f, indent=2)
    with open(os.path.join(args.out, "report.json"), "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print("\nValidation error (1–5 scale, lower is better):")
    print(f"{'':14}{'model':>8}{'rules':>8}{'blend':>8}")
    for k in LABELS:
        print(f"{k:14}{model_mae[k] if model_mae[k] is not None else '—':>8}{rule_mae[k] if rule_mae[k] is not None else '—':>8}{blend[k]:>8}")
    for n in notes:
        print("NOTE:", n)
    print(f"\nSaved {args.out}/melody-skin.onnx, model.json, report.json")


if __name__ == "__main__":
    main()
