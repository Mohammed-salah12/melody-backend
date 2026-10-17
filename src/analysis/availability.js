/**
 * Doctor availability, computed from real data:
 *  - working days/hours (clinic time zone), "on break until" set by the clinic,
 *  - booked appointments (a doctor in an appointment right now is "busy").
 */
const config = require('../config');
const Appointment = require('../models/Appointment');
const { clinicToUtc, clinicDay, clinicHM, parts, weekdayOf } = require('../lib/clinic-time');

const MIN = 60e3;
const LEAD_MIN = 30; // can't book a slot starting in less than 30 minutes

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** All slot start times (UTC Dates) of a doctor on a clinic day. */
function daySlots(doctor, day) {
  if (!doctor.workDays.includes(weekdayOf(day))) return [];
  const out = [];
  for (let h = doctor.startHour; h < doctor.endHour; h++) out.push(clinicToUtc(day, h, 0));
  return out;
}

async function bookedFor(doctorIds, from, to) {
  return Appointment.find({ doctor: { $in: doctorIds }, status: 'booked', start: { $lt: to }, end: { $gt: from } }).select('doctor start end').lean();
}

/** Slots for one day with availability flags. */
async function slotsForDay(doctor, day, now = new Date()) {
  const len = config.clinic.slotMinutes * MIN;
  const starts = daySlots(doctor, day);
  if (!starts.length) return [];
  const booked = await bookedFor([doctor._id], starts[0], new Date(starts[starts.length - 1].getTime() + len));
  return starts.map((start) => {
    const end = new Date(start.getTime() + len);
    let reason = null;
    if (start.getTime() < now.getTime() + LEAD_MIN * MIN) reason = 'past';
    else if (doctor.breakUntil && start < doctor.breakUntil && end > now) reason = 'break';
    else if (booked.some((b) => b.start < end && b.end > start)) reason = 'booked';
    return { start: start.toISOString(), end: end.toISOString(), time: clinicHM(start), available: !reason, reason };
  });
}

/** First free slot within the next `days` days. */
async function nextFreeSlot(doctor, now = new Date(), days = 14) {
  const today = clinicDay(now);
  for (let i = 0; i < days; i++) {
    const free = (await slotsForDay(doctor, addDays(today, i), now)).find((s) => s.available);
    if (free) return free;
  }
  return null;
}

/**
 * Status right now: online | busy | soon | break | offline
 * (+ until / minutes / nextSlot for the card text).
 */
async function statusOf(doctor, now = new Date(), bookedNow) {
  const current = (bookedNow ?? (await bookedFor([doctor._id], now, new Date(now.getTime() + 1))))
    .find((b) => String(b.doctor) === String(doctor._id) && b.start <= now && b.end > now);
  if (doctor.breakUntil && doctor.breakUntil > now) return { status: 'break', until: doctor.breakUntil.toISOString(), untilText: clinicHM(doctor.breakUntil) };
  const p = parts(now);
  const working = doctor.workDays.includes(p.weekday) && p.h >= doctor.startHour && p.h < doctor.endHour;
  if (current) {
    const minutes = Math.ceil((current.end - now) / MIN);
    return minutes <= 15 ? { status: 'soon', minutes } : { status: 'busy', until: current.end.toISOString() };
  }
  if (working) return { status: 'online' };
  return { status: 'offline' };
}

module.exports = { slotsForDay, nextFreeSlot, statusOf, bookedFor, addDays };
