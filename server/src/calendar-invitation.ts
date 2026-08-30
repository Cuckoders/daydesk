import ICAL from 'ical.js';

import type { IncomingMailAttachmentData } from './types.js';

export const MAX_CALENDAR_INVITATION_BYTES = 256 * 1024;

export interface CalendarInvitation {
  title: string;
  startsAt: string;
  endsAt: string;
  location?: string;
  allDay: boolean;
  allDayStartDate?: string;
  allDayEndDate?: string;
}

export class InvalidCalendarInvitationError extends Error {}

export function isCalendarInvitationAttachment(attachment: Pick<IncomingMailAttachmentData, 'name' | 'mimeType'>) {
  return attachment.mimeType.toLowerCase() === 'text/calendar' || attachment.name.toLowerCase().endsWith('.ics');
}

function cleanText(value: unknown, maximum: number) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function validDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function calendarError(): never {
  throw new InvalidCalendarInvitationError('Invalid calendar invitation');
}

export function parseCalendarInvitation(attachment: IncomingMailAttachmentData): CalendarInvitation {
  if (!isCalendarInvitationAttachment(attachment) || attachment.content.length < 1
    || attachment.content.length > MAX_CALENDAR_INVITATION_BYTES || attachment.size !== attachment.content.length) calendarError();

  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(attachment.content); }
  catch { calendarError(); }
  if (source.includes('\0') || !/BEGIN:VCALENDAR/i.test(source) || !/END:VCALENDAR/i.test(source)) calendarError();

  try {
    const calendar = new ICAL.Component(ICAL.parse(source));
    if (calendar.name !== 'vcalendar') calendarError();
    const events = calendar.getAllSubcomponents('vevent');
    if (events.length !== 1 || String(calendar.getFirstPropertyValue('method') ?? '').toUpperCase() === 'CANCEL') calendarError();
    const component = events[0];
    if (!component || component.hasProperty('rrule') || String(component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') calendarError();

    for (const propertyName of ['dtstart', 'dtend'] as const) {
      const property = component.getFirstProperty(propertyName);
      const timezone = property?.getParameter('tzid');
      if (timezone !== undefined && (typeof timezone !== 'string' || timezone.length > 100
        || (!['UTC', 'GMT', 'Z'].includes(timezone.toUpperCase()) && !calendar.getTimeZoneByID(timezone)))) calendarError();
    }

    const event = new ICAL.Event(component);
    const title = cleanText(event.summary, 300);
    if (!title) calendarError();
    const start = event.startDate;
    const end = event.endDate;
    if (!start || !end || start.isDate !== end.isDate) calendarError();

    if (start.isDate) {
      const allDayStartDate = start.toString();
      const allDayEndDate = end.toString();
      if (!validDateOnly(allDayStartDate) || !validDateOnly(allDayEndDate) || allDayEndDate <= allDayStartDate) calendarError();
      const startYear = Number(allDayStartDate.slice(0, 4));
      const endYear = Number(allDayEndDate.slice(0, 4));
      if (startYear < 1970 || startYear > 2100 || endYear < 1970 || endYear > 2100) calendarError();
      const durationDays = (Date.parse(`${allDayEndDate}T00:00:00.000Z`) - Date.parse(`${allDayStartDate}T00:00:00.000Z`)) / 86_400_000;
      if (durationDays > 31) calendarError();
      const location = cleanText(event.location, 500);
      return {
        title,
        startsAt: `${allDayStartDate}T00:00:00.000Z`,
        endsAt: `${allDayEndDate}T00:00:00.000Z`,
        ...(location ? { location } : {}),
        allDay: true,
        allDayStartDate,
        allDayEndDate,
      };
    }

    if (event.startDate.zone.tzid === 'floating' || event.endDate.zone.tzid === 'floating') calendarError();
    const startsAt = event.startDate.toJSDate();
    let endsAt = event.endDate.toJSDate();
    if (!component.hasProperty('dtend') && !component.hasProperty('duration') && endsAt.getTime() === startsAt.getTime()) {
      endsAt = new Date(startsAt.getTime() + 60 * 60_000);
    }
    const duration = endsAt.getTime() - startsAt.getTime();
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || startsAt.getUTCFullYear() < 1970
      || startsAt.getUTCFullYear() > 2100 || endsAt.getUTCFullYear() < 1970 || endsAt.getUTCFullYear() > 2100
      || duration <= 0 || duration > 31 * 86_400_000) calendarError();
    const location = cleanText(event.location, 500);
    return { title, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), ...(location ? { location } : {}), allDay: false };
  } catch (error) {
    if (error instanceof InvalidCalendarInvitationError) throw error;
    calendarError();
  }
}
