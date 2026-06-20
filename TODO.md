# TODO - Fix multiple punches not showing for M S Arjun

- [x] Update CCTV punches de-duplication logic in `server.js` to preserve multiple exits/entries.
- [x] Replace `(time,type)` exact dedupe with tolerant bucketing (10 seconds) or improved rule.
- [x] Ensure `checkIn/checkOut` and lunch calculations use the updated `uniquePunches` array unchanged.
- [x] Re-run quick searches to confirm no other punch dedupe logic exists for this flow.
- [ ] (Optional) Add a small debug log to show counts of punches vs uniquePunches for a given employee/day.
- [ ] Run node lint/tests if available (or start server smoke test).

