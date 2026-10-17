# Melody skin model

The scanner works without a model (rule-based image analysis). This folder trains a model from
**doctor-graded photos** that improves those numbers, and only where it has proven better.

## 1. Collect photos (in the app)
Users opt in under **Skin Profile → Help improve Melody’s scans**. From then on, each completed scan
stores one square face crop (`TrainingSample`). Turning the switch off deletes their photos.

## 2. Doctors grade them
Open **/admin/grading.html** (admin login). For each photo: hydration, oil, redness, dark spots,
texture, pores and fine lines on 1–5, plus skin tone (Fitzpatrick I–VI). Mark blurry / filtered /
heavy-makeup photos as unusable. Two doctors per photo gives much better labels.

How many? Under ~300 graded photos the model will not beat the rules. ~1,000–2,000 photos,
spread across all skin tones, is a good first target.

## 3. Export and train (on a computer with Python 3.10+)
```bash
cd backend
npm run export:dataset -- ./dataset         # writes dataset/images/*.jpg + dataset/labels.csv
python3 -m venv .venv && source .venv/bin/activate
pip install -r ml/requirements.txt
python3 ml/train.py --data ./dataset --out ./ml-model
```
A Mac with Apple Silicon or any NVIDIA GPU trains in minutes; plain CPU works too (slower).

The script splits by person, compares the model with the rules on the same validation photos
(overall and per skin tone), and writes `ml-model/melody-skin.onnx`, `model.json` (with
per-measurement blend weights) and `report.json`. Read `report.json` before using it.

## 4. Use it
```bash
npm install onnxruntime-node     # once, on the server (on Linux, if its install script fails: add --ignore-scripts)
```
Copy `ml-model/` to the backend folder on the server and restart. The log shows
`Skin model skin-YYYYMMDD-HHMM loaded`. Completed scans then blend the model's grades with the
rule numbers using the weights from training (0 = rules only, max 0.8). Scan results record
`results.model.version`, so you can always see which scans used which model.

Delete `dataset/` after training — it contains face photos.
