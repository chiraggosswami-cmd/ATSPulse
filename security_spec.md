# ATSPulse Firestore Security Specification & Invariants

This specification outlines the data integrity constraints, access controls, and boundary checks designed to lock down ATSPulse's Firestore model against any identity spoofing or data corruption attacks.

## 1. Data Invariants

- **Resource Ownership**: Every history item stored under `/users/{userId}/history/{historyId}` must belong to the user identified by `{userId}`.
- **Identity Inception**: A history item can only be created if `request.auth.uid` matches the `{userId}` path. No impersonation is permitted.
- **Strict Scores**: Scores (such as `atsScore` and `formattingScore`) are mathematically constrained between `0` and `100`.
- **Verified Access**: Users must possess a verified email (`email_verified == true`) to perform write operations, safeguarding system resources.
- **No In-Place Modifications**: History items are write-once logs. Updates are strictly blocked (`allow update: if false;`), ensuring mathematical protection against update-gaps. Deletions are allowed only by the resource owner.
- **ID Integrity**: The document ID `{historyId}` must match the `id` field inside the item payload. Document IDs must be safe, alphanumeric strings between 1 and 128 characters, strictly vetted by `isValidId()`.

---

## 2. The Dirty Dozen Payloads

These 12 malicious payloads represent attack vectors that our security rules are guaranteed to block with a `PERMISSION_DENIED` response.

### Payload 1: Unauthenticated Create Attempt
- **Vector**: Attempting to log a scan result without active login token.
```json
{
  "id": "item123",
  "timestamp": "2026-05-28T21:30:00Z",
  "fileName": "Resume.pdf",
  "targetRole": "React Engineer",
  "atsScore": 85,
  "report": {
    "atsScore": 85,
    "atsTier": "Strong Match",
    "roleAlignment": "React Engineer",
    "matchedKeywords": ["React", "TypeScript"],
    "missingKeywords": [],
    "formattingScore": 90,
    "formattingIssues": [],
    "formattingTips": [],
    "contentRecommendations": [],
    "keywordTips": [],
    "alignmentSummary": "Good candidate"
  },
  "userId": "attacker1"
}
```

### Payload 2: Impersonate Other User
- **Vector**: Logged in as `userA`, but attempting to write a document inside `userB`'s path `/users/userB/history/item123`.
```json
{
  "id": "item123",
  "timestamp": "2026-05-28T21:30:00Z",
  "fileName": "Spam.pdf",
  "targetRole": "Hacker",
  "atsScore": 99,
  "report": { ... },
  "userId": "userB"
}
```

### Payload 3: Spoofed Verified Token (Unverified Email Write)
- **Vector**: User logged in but with `email_verified == false`, trying to bypass block.
- **Target path**: `/users/unverifiedUser/history/item123`

### Payload 4: Hostile ID injection (Resource Poisoning)
- **Vector**: Injecting a massive character sequence or special directory traversal characters as the document ID.
- **Target path**: `/users/userA/history/../../someOtherPath`

### Payload 5: ID Mismatch (Identity Spoofing)
- **Vector**: The document is targeted at path `/users/userA/history/itemXYZ`, but the inner `id` payload property says `"id": "itemABC"`.
- **Target path**: `/users/userA/history/itemXYZ`
```json
{
  "id": "itemABC",
  "timestamp": "2026-05-28T21:30:00Z",
  "fileName": "Mismatch.pdf",
  "targetRole": "React Developer",
  "atsScore": 80,
  "report": { ... },
  "userId": "userA"
}
```

### Payload 6: Score Overflow (Value Poisoning)
- **Vector**: Attempting to set an ATS score of `150` out of `100`.
- **Target path**: `/users/userA/history/item123`
```json
{
  "id": "item123",
  "timestamp": "2026-05-28T21:30:00Z",
  "fileName": "Cheated.pdf",
  "targetRole": "Senior Dev",
  "atsScore": 150,
  "report": { ... },
  "userId": "userA"
}
```

### Payload 7: Negative Score Attempt (Underflow)
- **Vector**: Setting `atsScore` to `-25` or other mathematically invalid values.
- **Target path**: `/users/userA/history/item123`
```json
{
  "id": "item123",
  "timestamp": "2026-05-28T21:30:00Z",
  "fileName": "Neg.pdf",
  "targetRole": "Product PM",
  "atsScore": -10,
  "report": { ... },
  "userId": "userA"
}
```

### Payload 8: Mutability / Write Bypass Attempt (Update Bypass)
- **Vector**: Attempting to edit an existing history item to change the keyword array.
- **Operation**: `Update` on `/users/userA/history/item123`.

### Payload 9: Non-existent Field Inject (Shadow Field / Ghost Field Attack)
- **Vector**: Trying to create a history doc containing a ghost key `"isPremiumAdmin": true` which is not in the schema.
- **Target path**: `/users/userA/history/item123`
```json
{
  "id": "item123",
  "timestamp": "2026-05-28T21:30:00Z",
  "fileName": "Exploit.pdf",
  "targetRole": "Engineer",
  "atsScore": 75,
  "report": { ... },
  "userId": "userA",
  "isPremiumAdmin": true
}
```

### Payload 10: Missing Critical Nested Values (Structural Sabotage)
- **Vector**: Omitting mandatory arrays (e.g., `matchedKeywords`, `formattingIssues`) inside the report object to trigger application-side UI runtime errors.
- **Target path**: `/users/userA/history/item123`
```json
{
  "id": "item123",
  "timestamp": "2026-05-28T21:30:00Z",
  "fileName": "Broken.pdf",
  "targetRole": "Architect",
  "atsScore": 88,
  "report": {
    "atsScore": 88,
    "atsTier": "Strong Match"
  },
  "userId": "userA"
}
```

### Payload 11: Cross-user Read Attempt (PII Leak Guard)
- **Vector**: `userB` attempting to read `/users/userA/history/item123`.
- **Operation**: `Get` on foreign path.

### Payload 12: Directory Listing Query (Denial of Wallet Constraint)
- **Vector**: Trying to scan all history items globally outside any security filter using a raw unconstrained collectionGroup query across all user paths.
- **Operation**: `List` on `history` collectionGroup.

---

## 3. Test Runner Design (`firestore.rules.test.ts`)

A production suite would emulate the Firestore Emulator environment, verifying user login scenarios, payload content length, and structural denials. Since the rules block updates entirely, and restrict access to path owners who match `request.auth.uid`, each of the attempts mapped above results in a distinct permission denial.
