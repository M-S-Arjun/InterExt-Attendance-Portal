# TODO - Fix multiple punches not showing for M S Arjun

- [x] Update CCTV punches de-duplication logic in `server.js` to preserve multiple exits/entries.
- [x] Replace `(time,type)` exact dedupe with tolerant bucketing (10 seconds) or improved rule.
- [x] Ensure `checkIn/checkOut` and lunch calculations use the updated `uniquePunches` array unchanged.
- [x] Re-run quick searches to confirm no other punch dedupe logic exists for this flow.
- [ ] (Optional) Add a small debug log to show counts of punches vs uniquePunches for a given employee/day.
- [ ] Run node lint/tests if available (or start server smoke test).

# TODO - Camera multi-face/multi-tracking reliability

- [ ] Fix any backend overwrite/merge bug in CCTV webhook so multiple detections are persisted independently.
- [ ] Ensure `camera_event_recorded` and attendance punch payloads are consistent for UI rendering.
- [ ] Add guarded debug logs for: incoming punches count, dedupe results, final attendance punch list.
- [ ] Verify `public/app.js` renders punches from `row.punches[*].time` (or correct key) for all camera punches.
- [ ] Smoke test: send 2-3 detections for same employee/day and verify UI shows all punches.

