# Daily Heart Rate

The Daily Heart Rate view compares provider-attributed heart-rate samples for
one local calendar day. The web and mobile views provide the same navigation:

- **Previous** moves to the preceding day.
- **Next** moves forward until today; future days are not available.
- **Today** returns to the current day.
- The date picker can select today or an earlier day.

The view identifies the device's local time zone next to the selected date. That
time zone defines the calendar-day boundaries used by the server query, so a
sample near midnight is assigned to the day shown for that device. The server
returns the source samples and summaries; the clients only render them.

See the [web view](../packages/web/src/pages/DailyHeartRatePage.tsx), [mobile
view](../packages/mobile/app/daily-heart-rate.tsx), and [server repository](../packages/server/src/repositories/heart-rate-repository.ts)
for the implementation contract.
