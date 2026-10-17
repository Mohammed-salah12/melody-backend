/** Consultation report PDF (Clinical Archive → "Download PDF Report"). */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const BROWN = '#693D32';
const BRICK = '#9D3E1D';

function fmt(d, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'long', timeStyle: 'short' }).format(d);
}

/** Streams the PDF into `out` (an http response). */
function writeReport(out, { appt, doctor, user, scan, tz }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Consultation report — ${doctor?.name ?? ''}`, Author: 'Melody Beauty' } });
  doc.pipe(out);

  const logo = path.join(__dirname, '..', '..', 'public', 'logo.png');
  if (fs.existsSync(logo)) doc.image(logo, 50, 40, { width: 46 });
  doc.fillColor(BROWN).fontSize(20).text('Melody Beauty', 105, 50);
  doc.fillColor('#777').fontSize(9).text('Consultation report', 105, 74);
  doc.moveTo(50, 105).lineTo(545, 105).strokeColor('#E8DCD7').stroke();

  doc.moveDown(2).fillColor('#222').fontSize(11);
  const row = (k, v) => {
    doc.fillColor('#8A726B').fontSize(9).text(k.toUpperCase(), { continued: false });
    doc.fillColor('#222').fontSize(12).text(v || '—').moveDown(0.5);
  };
  doc.y = 120;
  row('Patient', user.fullName);
  row('Specialist', `${doctor?.name ?? '—'}${doctor?.title ? ` · ${doctor.title}` : ''}`);
  row('Date', fmt(appt.start, tz));
  row('Consultation', `${appt.type === 'chat' ? 'Chat' : 'Video'} consultation · ${appt.durationMinutes ?? Math.round((appt.end - appt.start) / 60e3)} minutes`);
  if (appt.problem) row('Reason', appt.problem);

  doc.moveDown(0.5).fillColor(BRICK).fontSize(10).text('CLINICAL SUMMARY').moveDown(0.3);
  doc.fillColor('#222').fontSize(11.5).text(appt.summary || 'No summary written.', { lineGap: 3 });

  if (appt.protocol?.length) {
    doc.moveDown(1).fillColor(BRICK).fontSize(10).text('PROTOCOL UPDATE').moveDown(0.3);
    for (const p of appt.protocol) doc.fillColor('#222').fontSize(11.5).text(`•  ${p.name}${p.note ? ` — ${p.note}` : ''}`, { lineGap: 2 });
  }

  if (scan?.results) {
    const m = scan.results.metrics;
    doc.moveDown(1).fillColor(BRICK).fontSize(10).text('LATEST SKIN SCAN (CAMERA ESTIMATE)').moveDown(0.3);
    doc.fillColor('#222').fontSize(10.5).text(
      `Score ${Math.round(scan.results.score)} · hydration ${Math.round(m.hydration)} · oil ${Math.round(m.oil)} · redness ${Math.round(m.redness)} · dark spots ${Math.round(m.pigmentation)} · texture ${Math.round(m.texture)} · pores ${Math.round(m.pores)} · fine lines ${Math.round(m.wrinkles)}`,
      { lineGap: 2 },
    );
  }

  doc.moveDown(2).fillColor('#999').fontSize(8.5).text('This report summarises a remote consultation. Scan values are estimates from phone-camera photos, not medical measurements.', { lineGap: 2 });
  doc.end();
}

/** Skin report the doctor sends in the chat: the patient's scan + the doctor's note. */
function writeSkinReport(out, { code, note, doctor, user, scan, at, tz }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Skin report ${code}`, Author: 'Melody Beauty' } });
  doc.pipe(out);
  const logo = path.join(__dirname, '..', '..', 'public', 'logo.png');
  if (fs.existsSync(logo)) doc.image(logo, 50, 40, { width: 46 });
  doc.fillColor(BROWN).fontSize(20).text('Melody Beauty', 105, 50);
  doc.fillColor('#777').fontSize(9).text(`Skin report · ${code}`, 105, 74);
  doc.moveTo(50, 105).lineTo(545, 105).strokeColor('#E8DCD7').stroke();
  doc.y = 120;
  const row = (k, v) => {
    doc.fillColor('#8A726B').fontSize(9).text(k.toUpperCase());
    doc.fillColor('#222').fontSize(12).text(v || '—').moveDown(0.5);
  };
  row('Patient', user?.fullName);
  row('Specialist', `${doctor?.name ?? '—'}${doctor?.title ? ` · ${doctor.title}` : ''}`);
  row('Issued', fmt(at, tz));
  const r = scan?.results;
  if (r) {
    row('Skin scan', `${fmt(scan.completedAt ?? at, tz)} · ${scan.source === 'smart-pen' ? 'Smart Skin Pen' : 'phone camera'}`);
    doc.moveDown(0.3).fillColor(BRICK).fontSize(10).text('MEASUREMENTS').moveDown(0.3);
    const m = r.metrics ?? {};
    const lines = [
      ['Skin score', r.score],
      ['Hydration', m.hydration],
      ['Oil / shine', m.oil],
      ['Redness', m.redness],
      ['Dark spots', m.pigmentation],
      ['Texture', m.texture],
      ['Visible pores', m.pores],
      ['Fine lines', m.wrinkles],
      ['Even tone', m.evenness],
    ].filter(([, v]) => typeof v === 'number');
    for (const [k, v] of lines) doc.fillColor('#222').fontSize(11.5).text(`${k}: ${Math.round(v)} / 100`);
    if (r.zones?.tzoneOil != null) doc.text(`T-zone oil ${Math.round(r.zones.tzoneOil)} · cheek oil ${Math.round(r.zones.cheekOil ?? 0)} · cheek hydration ${Math.round(r.zones.cheekHydration ?? 0)}`);
    if (r.skinType) doc.moveDown(0.3).text(`Skin type: ${r.skinType}`);
    if (r.concerns?.length) doc.text(`Concerns: ${r.concerns.join(', ')}`);
  } else {
    row('Skin scan', 'No scan linked to this consultation.');
  }
  doc.moveDown(0.8).fillColor(BRICK).fontSize(10).text('SPECIALIST NOTE').moveDown(0.3);
  doc.fillColor('#222').fontSize(11.5).text(note || '—', { lineGap: 3 });
  doc.moveDown(1.5).fillColor('#999').fontSize(8.5).text('Measurements come from an automated photo analysis and are indicative only; they are not a medical diagnosis.', { lineGap: 2 });
  doc.end();
}

module.exports = { writeReport, writeSkinReport };
