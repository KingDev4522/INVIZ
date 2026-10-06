# Demo Scripts (PRD 6.7 §1.2)

Versioned utterances in English + Hindi with expected system behavior per step,
including failure branches. No utterance is improvised on demo day that wasn't
passed in rehearsal. Site: qualified `test-page/` baseline unless re-qualified
otherwise. Test credentials only; OTP demo values are rotated after each session.

Conventions: `USER »` spoken by the demonstrator; `SYSTEM »` expected speech;
`[verify: …]` the expected verification verdict; `→` the failure branch.

---

## Demo A — Multi-step task: search, open, verify

Goal: prove Understand → Act → Observe → Verify → Continue on a live page.

### A1. Search (EN)

1. `USER »` "Search for Python tutorials."
2. System focuses the search box, types, submits; results list populates.
   `SYSTEM »` "Search results updated." (task-status announcement)
   `[verify: results container count changed]`
3. `USER »` "Open the first result."
4. System identifies the first result link, activates it.
   `SYSTEM »` "First result opened." `[verify: navigation completed]`

### A1-H. Search (HI)

1. `USER »` "Python ट्यूटोरियल खोजो।"
2. Same flow; announcements in Hindi via the `hi-IN` voice.
   `SYSTEM »` "खोज परिणाम अपडेट हो गए।"
3. `USER »` "पहला परिणाम खोलो।"
   `SYSTEM »` "पहला परिणाम खुल गया।"

### A-fail. Recovery branch (rehearsed, not improvised)

If step A1-4's verification fails (result link inert): the system must NOT retry
blindly — it re-observes, announces the miss, and either picks the next result
or reports failure honestly. Demonstrator forces this with the fixture's
fail-once control where available; otherwise narrates the branch while showing
the `VERIFIED_FAILURE → recovery` log line.

---

## Demo B — Ask-user form flow (ordinary fields only)

Goal: prove the Need → Ask → Answer → Continue loop with zero invented values.

### B1. Form fill (EN)

1. `USER »` "Fill out this application."
2. `SYSTEM »` "What is your full name?" (agent question, priority 2)
3. `USER »` "Mehul Kumar Jaiswal."
4. `SYSTEM »` "What email address should I use?"
5. `USER »` "mehul@example.com."
6. `SYSTEM »` "The form is ready to submit. Would you like me to submit it?"
   (confirmation: names the action, never assumes approval)
7. `USER »` "Yes."
8. Submission executes; observed + verified.
   `SYSTEM »` "Application submitted." `[verify: success state present]`

### B1-H. Form fill (HI)

Same flow in Hindi: `«आपका पूरा नाम क्या है?»` → `«कौन-सा ईमेल पता इस्तेमाल करूँ?»` →
`«फ़ॉर्म जमा करने के लिए तैयार है। क्या मैं इसे जमा कर दूँ?»` → `«हाँ।»` →
`«आवेदन जमा हो गया।»`

### B-fail branches (rehearsed)

- **Ambiguous answer:** agent asks email → user says "My college one." →
  system must ask a clarification question, never guess. (`WAITING_FOR_CLARIFICATION`)
- **Rejection:** user answers "No." at step B1-7 → submission does NOT occur;
  task returns to a safe state and says so.
- **Cancellation:** user says "Stop." mid-flow → everything halts, partial state
  reported ("Name filled, email pending."), system returns to idle.
- **Sensitive-field variant (security demos only):** agent asks for the one-time
  code → value is typed via the memory-only path, never repeated aloud, never
  logged. Uses a rotated test code.

---

## Backup recordings

After each 5/5 live pass: record screen + system audio, burn in
"RECORDED DEMONSTRATION — [date]", archive as `docs/demo-backup-A.mp4` /
`docs/demo-backup-B.mp4`. Video only — never presented as live.
(Status: PENDING live run — requires C1 + C2 + browser session.)
