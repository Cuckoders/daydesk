import assert from 'node:assert/strict';
import test from 'node:test';

import { InvalidCalendarInvitationError, parseCalendarInvitation } from '../src/calendar-invitation.js';

function attachment(source: string, overrides: Partial<{ name: string; mimeType: string }> = {}) {
  const content = Buffer.from(source);
  return {
    id: '1', name: overrides.name ?? 'invite.ics', mimeType: overrides.mimeType ?? 'text/calendar',
    size: content.length, downloadable: true, content,
  };
}

function calendar(event: string) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//DayDesk Test//EN\r\n${event}\r\nEND:VCALENDAR\r\n`;
}

test('calendar invitation parser returns a sanitized timed meeting', () => {
  const result = parseCalendarInvitation(attachment(calendar([
    'BEGIN:VEVENT', 'UID:meeting-1', 'DTSTART:20260901T120000Z', 'DTEND:20260901T130000Z',
    'SUMMARY:Product \r\n review  ', 'LOCATION:Room 4', 'END:VEVENT',
  ].join('\r\n'))));
  assert.deepEqual(result, {
    title: 'Product review', startsAt: '2026-09-01T12:00:00.000Z', endsAt: '2026-09-01T13:00:00.000Z',
    location: 'Room 4', allDay: false,
  });
});

test('calendar invitation parser preserves exclusive all-day dates', () => {
  const result = parseCalendarInvitation(attachment(calendar([
    'BEGIN:VEVENT', 'UID:day-1', 'DTSTART;VALUE=DATE:20260903', 'DTEND;VALUE=DATE:20260905',
    'SUMMARY:Conference', 'END:VEVENT',
  ].join('\r\n'))));
  assert.equal(result.allDay, true);
  assert.equal(result.allDayStartDate, '2026-09-03');
  assert.equal(result.allDayEndDate, '2026-09-05');
});

test('calendar invitation parser rejects cancellations, recurrence and unresolved timezones', () => {
  const invalidEvents = [
    ['METHOD:CANCEL', 'BEGIN:VEVENT', 'UID:x', 'DTSTART:20260901T120000Z', 'SUMMARY:Cancelled', 'END:VEVENT'],
    ['BEGIN:VEVENT', 'UID:x', 'DTSTART:20260901T120000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Recurring', 'END:VEVENT'],
    ['BEGIN:VEVENT', 'UID:x', 'DTSTART;TZID=America/New_York:20260901T120000', 'DTEND;TZID=America/New_York:20260901T130000', 'SUMMARY:Unknown zone', 'END:VEVENT'],
    ['BEGIN:VEVENT', 'UID:x', 'DTSTART:20260901T120000', 'DTEND:20260901T130000', 'SUMMARY:Floating time', 'END:VEVENT'],
  ];
  for (const lines of invalidEvents) {
    assert.throws(() => parseCalendarInvitation(attachment(calendar(lines.join('\r\n')))), InvalidCalendarInvitationError);
  }
});

test('calendar invitation parser rejects mislabeled and oversized input', () => {
  const source = calendar('BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260901T120000Z\r\nSUMMARY:Meeting\r\nEND:VEVENT');
  assert.throws(() => parseCalendarInvitation(attachment(source, { name: 'note.txt', mimeType: 'text/plain' })), InvalidCalendarInvitationError);
  const oversized = attachment(`${source}${' '.repeat(256 * 1024)}`);
  assert.throws(() => parseCalendarInvitation(oversized), InvalidCalendarInvitationError);
});
