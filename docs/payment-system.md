# WOLI DAN TECH HUB — Manual Payment Verification System

Production-ready implementation for manual bank-transfer payments with receipt upload, admin review, enrollment activation, and coupon support.

## Architecture

```
Netlify Frontend (React)
        ↓ HTTPS + Bearer <supabase access token>
Railway Backend API (this repo — Express + service_role)
        ↓ PostgREST + Storage (service_role bypasses RLS for trusted ops)
Supabase Auth / PostgreSQL + RLS / Storage (private buckets)
        ↓
Enrollment (ACTIVE) → Course Access (gated by RLS + backend)
```

## Data Model

### `payments` table (existing, enhanced in migration 008)

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| student_id | uuid | FK profiles, indexed |
| course_id | uuid | FK courses, indexed |
| amount | numeric(12,2) | Amount actually paid (after discount) |
| original_amount | numeric(12,2) | Original course price |
| discount_amount | numeric(12,2) | Discount from coupon |
| coupon_id | uuid | FK coupons, nullable |
| currency | text | NGN default, check NGN/USD |
| payment_method | enum | MANUAL_BANK_TRANSFER, FREE |
| transaction_reference | text | Unique, user-provided, indexed |
| payment_reference | text | Alias for spec compatibility |
| transaction_date | date | Date of bank transfer |
| payment_date | date | Alias for spec |
| receipt_path | text | Optional, receipt stored in payment_receipts table |
| status | enum | PENDING, APPROVED, REJECTED |
| rejection_reason | text | Required when REJECTED |
| submitted_at | timestamptz | When student submitted |
| reviewed_at | timestamptz | When admin reviewed |
| reviewed_by | uuid | FK profiles (admin) |
| created_at, updated_at | timestamptz | |

Constraints:
- `uq_transaction_reference` unique
- `uq_pending_payment_per_course` unique (student_id, course_id) where status=PENDING — prevents duplicate pending
- `chk_rejection_reason` — REJECTED must have reason
- `chk_review_fields` — APPROVED/REJECTED must have reviewed_at/by

Indexes: student_id, course_id, status, transaction_reference, payment_reference, created_at, coupon_id

### `payment_receipts` table

| Column | Type |
|--------|------|
| id | uuid |
| payment_id | uuid FK payments |
| student_id | uuid FK profiles |
| file_path | text unique — path in private bucket |
| file_name | text |
| file_type | text — check image/jpeg, image/png, application/pdf |
| uploaded_at | timestamptz |

Storage: private bucket `payment-receipts`
Path: `{student_id}/{payment_id}/{timestamp}-{sanitized_filename}` — matches spec `receipts/{studentId}/{paymentId}/receipt.ext`

### `enrollments` table

| Column | Type |
|--------|------|
| id | uuid |
| student_id | uuid |
| course_id | uuid |
| payment_id | uuid nullable FK payments |
| status | enum PENDING, ACTIVE, COMPLETED, CANCELLED |
| enrolled_at | timestamptz |
| completed_at | timestamptz nullable |
| Unique | (student_id, course_id) |

### `coupons` table (migration 008)

| Column | Type |
|--------|------|
| id | uuid PK |
| code | text unique, e.g. WOLI100, regex ^[A-Z0-9_-]{3,50}$ |
| description | text |
| discount_type | enum PERCENTAGE, FIXED |
| discount_value | numeric — 100 for 100%, 50 for 50%, 2500 for NGN 2500 off |
| max_uses | int nullable — null = unlimited |
| used_count | int default 0 |
| min_amount | numeric default 0 |
| applicable_course_ids | uuid[] nullable — null = all courses |
| is_active | bool default true |
| valid_from | timestamptz |
| valid_until | timestamptz nullable |
| created_by | uuid FK profiles |
| created_at, updated_at | timestamptz |

Seeded: `WOLI100` 100% off, `WELCOME50` 50% off

### `coupon_redemptions` table

Audit trail for coupon usage.

| Column | Type |
|--------|------|
| id | uuid |
| coupon_id | uuid FK coupons |
| student_id | uuid FK profiles |
| course_id | uuid FK courses |
| payment_id | uuid nullable FK payments (null for free) |
| enrollment_id | uuid nullable FK enrollments |
| discount_amount | numeric |
| amount_paid | numeric |
| original_amount | numeric |
| redeemed_at | timestamptz |
| Unique | (coupon_id, student_id, course_id) — prevents reuse per course |

## API Contract

### Student Endpoints (authenticated)

#### POST /api/enrollments
Start checkout — returns bank details and exact amount (never trusts frontend). Supports coupons.

**Auth:** Bearer token (student)

**Body:**
```json
{
  "course_id": "uuid",
  "coupon_code": "WELCOME50" // optional
}
```

**Responses:**
- 200: If no coupon or partial coupon — returns amount_to_pay, bank_details, next_step
```json
{
  "success": true,
  "data": {
    "course": { "id": "uuid", "title": "React", "price": 5000 },
    "original_amount": 5000,
    "discount_amount": 2500,
    "amount_to_pay": 2500,
    "coupon": { "code": "WELCOME50", "validation": { "discount_amount": 2500, "amount_due": 2500, "is_free": false } },
    "bank_details": { "bank_name": "MONIEPOINT", "account_number": "...", "account_name": "..." },
    "next_step": "POST /api/payments with receipt"
  }
}
```
- 201: If 100% coupon — free enrollment activated immediately
```json
{
  "success": true,
  "message": "Coupon applied — free enrollment activated!",
  "data": { "enrollment_id": "uuid", "is_free": true, "amount_to_pay": 0 }
}
```
- 400: Invalid coupon
- 401: Unauthenticated
- 404: Course not found
- 409: Already enrolled or payment pending

#### POST /api/payments
Submit payment receipt (multipart/form-data)

**Auth:** student

**Form fields:**
- course_id: uuid (required)
- transaction_reference: string 4-120 chars, regex ^[\w\-\/.#]+$ (required, unique)
- transaction_date: ISO date <= now+24h (required)
- amount: number optional — validated against DB price (never trusted)
- coupon_code: string optional — e.g. WELCOME50 (for partial discounts)
- receipt: file (required) — JPG, JPEG, PNG, PDF, max 5MB (configurable), magic-byte verified

**Backend validation:**
1. Authenticate Supabase user
2. Verify course exists and is_published=true
3. Determine legitimate price from DB (never trust frontend)
4. If coupon_code: validate via `validate_coupon` RPC, calculate amount_due, reject if is_free (use enrollments endpoint)
5. Validate payment reference uniqueness (global unique + per student/course pending unique)
6. Validate receipt: MIME type in allowlist, extension, file size, magic bytes (JPEG FF D8 FF, PNG 89 50 4E 47, PDF %PDF)
7. Upload to private bucket `payment-receipts` at `{student_id}/{payment_id}/{timestamp}-{sanitized_name}`
8. Create payment record status=PENDING, with coupon_id, discount_amount, original_amount, currency=NGN
9. Create payment_receipts row
10. If coupon: create coupon_redemptions row (pending)
11. Trigger creates notification PAYMENT_SUBMITTED

**Responses:**
- 201:
```json
{
  "success": true,
  "message": "Payment submitted successfully and is awaiting admin verification.",
  "data": {
    "payment": {
      "id": "uuid",
      "course_id": "uuid",
      "amount": 2500,
      "original_amount": 5000,
      "discount_amount": 2500,
      "coupon_id": "uuid",
      "transaction_reference": "REF123",
      "status": "PENDING",
      "submitted_at": "2026-09-13T...",
      "currency": "NGN"
    }
  }
}
```
- 400: Invalid receipt, amount mismatch, invalid coupon, receipt required
- 401: Unauthenticated
- 404: Course not found
- 409: Duplicate transaction reference, payment already pending, already enrolled
- 422: Invalid payment evidence (magic byte mismatch)
- 500: Storage failure (compensating delete)

#### GET /api/payments/me and GET /api/payments/my
Student payment history (alias my per spec)

**Auth:** student

**Query:** page, limit

**Response:** 200
```json
{
  "success": true,
  "data": {
    "payments": [
      {
        "id": "uuid",
        "course_id": "uuid",
        "amount": 2500,
        "original_amount": 5000,
        "discount_amount": 2500,
        "coupon_id": "uuid",
        "currency": "NGN",
        "payment_method": "MANUAL_BANK_TRANSFER",
        "transaction_reference": "REF123",
        "status": "PENDING",
        "rejection_reason": null,
        "submitted_at": "...",
        "reviewed_at": null,
        "courses": { "id": "uuid", "title": "React", "slug": "react" },
        "coupons": { "id": "uuid", "code": "WELCOME50", "discount_type": "PERCENTAGE", "discount_value": 50 },
        "payment_receipts": [{ "file_name": "receipt.jpg", "file_type": "image/jpeg" }]
      }
    ],
    "summary": { "total_paid": 5000, "pending_payments": 1, "approved_payments": 1, "rejected_payments": 0 },
    "pagination": { "page": 1, "limit": 10, "total": 2, "total_pages": 1 }
  }
}
```

Only returns own payments — RLS + student_id filter

#### GET /api/payments/:id
Student payment detail (ownership verified)

**Auth:** student

**Response:** 200 with course, amount, reference, date, status, rejection reason, coupon, receipt info

**Errors:** 401, 403 (not owner), 404

#### GET /api/payments/:id/receipt-url
Signed URL for own receipt (or admin can view any)

**Auth:** student (owner) or admin

**Response:** 200
```json
{
  "success": true,
  "data": { "url": "https://.../signed-url", "expires_in_seconds": 600, "file_name": "receipt.jpg", "file_type": "image/jpeg" }
}
```

**Security:** Students cannot request another student's receipt — checks `payments.student_id == profile.id`

#### POST /api/coupons/validate
Validate coupon without redeeming

**Body:** { code, course_id }

**Response:** 200 valid, 400 invalid with reason

#### POST /api/coupons/apply
Apply 100% free coupon — instant enrollment

**Body:** { code, course_id }

**Response:** 201 free enrollment, 400 if coupon requires payment (use checkout), 409 already enrolled

#### POST /api/coupons/checkout
For partial coupons — returns amount due and bank details

**Body:** { code, course_id }

**Response:** 200 with validation, amount_due, bank_details, next_step

---

### Admin Endpoints (admin role required)

#### GET /api/admin/payments
List payments with filters

**Auth:** admin

**Query:**
- status: PENDING, APPROVED, REJECTED (default PENDING)
- course_id: uuid
- student_id: uuid
- payment_method: MANUAL_BANK_TRANSFER, FREE
- search: string — searches transaction_reference, payment_reference
- from_date, to_date: ISO dates
- page, limit

**Response:** 200 with payments array, each includes student (id, full_name, email, phone, photo), course (id, title, slug, price, thumbnail), reviewer, coupon, payment_receipts

**Errors:** 401, 403

#### GET /api/admin/payments/:id
Full payment detail with signed receipt URL + student's history for context

**Auth:** admin

**Response:** 200
```json
{
  "success": true,
  "data": {
    "payment": { "...": "...", "receipt_url": "https://.../signed-1h", "student": {}, "course": {}, "coupon": {} },
    "history": [ { "id": "uuid", "status": "REJECTED", "rejection_reason": "..." } ]
  }
}
```

#### GET /api/admin/payments/:id/receipt
Secure admin receipt access — returns signed URL (1 hour)

**Auth:** admin

**Response:** 200
```json
{
  "success": true,
  "data": {
    "payment_id": "uuid",
    "receipt": { "id": "uuid", "file_name": "receipt.jpg", "file_type": "image/jpeg", "url": "https://.../signed", "expires_in_seconds": 3600 }
  }
}
```

**Security:** Verifies admin role, payment existence. Students cannot access this endpoint (admin middleware blocks).

#### POST /api/admin/payments/:id/approve
Approve payment — transactional

**Auth:** admin only

**Backend transaction (RPC approve_payment):**
1. Authenticate admin, verify role=admin
2. Lock payment row `SELECT ... FOR UPDATE`
3. Verify status=PENDING — if not, return 409 "Payment has already been reviewed"
4. Update payments: status=APPROVED, reviewed_at=NOW(), reviewed_by=ADMIN_ID, rejection_reason=NULL
5. Create or activate enrollment: student_id, course_id, payment_id, status=ACTIVE, enrolled_at=NOW() — unique constraint prevents duplicate
6. If coupon: increment coupons.used_count, link coupon_redemptions.enrollment_id
7. Create notifications: PAYMENT_APPROVED, COURSE_ENROLLED
8. Audit log: PAYMENT_APPROVED with amount, ref, course, coupon

**Race protection:** `WHERE status='PENDING'` + row locking — if 0 rows updated, returns 409. No duplicate enrollments.

**Response:** 200
```json
{
  "success": true,
  "message": "Payment approved. The student now has access to the course.",
  "data": { "payment": {}, "result": { "payment_id": "uuid", "status": "APPROVED", "enrollment_id": "uuid" } }
}
```

**Errors:** 401, 403, 404, 409 Payment already reviewed, 500

#### POST /api/admin/payments/:id/reject
Reject payment

**Auth:** admin

**Body:** { rejection_reason: string 3-1000 chars, required }

**Backend:**
1. Auth admin, verify role
2. Verify payment is PENDING (for update)
3. Set status=REJECTED, rejection_reason, reviewed_at=NOW(), reviewed_by=ADMIN_ID
4. Set enrollment status=PENDING (if exists) — do NOT activate
5. Do NOT increment coupon used_count — rejected coupon can be reused
6. Notification PAYMENT_REJECTED with reason
7. Audit log PAYMENT_REJECTED

**Response:** 200

**Errors:** 400 reason required, 401, 403, 404, 409 already reviewed

#### GET /api/admin/coupons
List coupons

**Query:** is_active, search, page, limit

**Response:** 200 with coupons array

#### POST /api/admin/coupons
Create coupon

**Body:**
```json
{
  "code": "WOLI50",
  "description": "50% off",
  "discount_type": "PERCENTAGE",
  "discount_value": 50,
  "max_uses": 100,
  "min_amount": 0,
  "applicable_course_ids": ["uuid"] or null for all,
  "is_active": true,
  "valid_from": "2026-01-01",
  "valid_until": "2026-12-31"
}
```

**Validation:** code regex ^[A-Z0-9_-]{3,50}$, discount_value >0, PERCENTAGE <=100, valid_until > valid_from

**Response:** 201

#### GET /api/admin/coupons/:id
Coupon detail + redemptions count

#### PATCH /api/admin/coupons/:id
Update coupon

#### DELETE /api/admin/coupons/:id
Delete or deactivate if has redemptions

#### GET /api/admin/coupon-redemptions
List redemptions with filters coupon_id, student_id, course_id

---

## Workflow

```
STUDENT
  ↓ POST /api/enrollments {course_id, coupon_code?}
  → If 100% coupon: Enrollment=ACTIVE immediately, no payment needed
  → Else: returns bank_details + amount_to_pay (after discount)

  ↓ Transfer to bank (MONIEPOINT 69852663361)

  ↓ POST /api/payments {courseId, paymentReference, paymentDate, receipt, coupon_code?}
  → Backend validates price from DB (never trusts frontend)
  → Validates coupon if provided, calculates amount_due
  → Validates receipt (MIME, magic bytes, size)
  → Uploads to private bucket receipts/{studentId}/{paymentId}/receipt.ext
  → Creates payment PENDING
  → Notification: "Your payment has been submitted and is awaiting verification."

ADMIN DASHBOARD
  ↓ GET /api/admin/payments?status=PENDING
  ↓ GET /api/admin/payments/:id (with receipt_url)
  ↓ GET /api/admin/payments/:id/receipt (signed URL 1h)

  → Review receipt

  ↓ POST /api/admin/payments/:id/approve
    → Payment APPROVED, reviewed_at, reviewed_by
    → Enrollment ACTIVE (or re-activated)
    → If coupon: used_count++, redemption linked
    → Notification: "Your payment has been approved. Your course access is now active."
    → Audit log

  ↓ OR POST /api/admin/payments/:id/reject {reason}
    → Payment REJECTED, reason stored
    → Notification: "Your payment was rejected..."
    → Audit log
    → Student may resubmit (pending unique index allows after rejection)

STUDENT
  ↓ GET /api/payments/me — sees PENDING → APPROVED
  ↓ GET /api/enrollments/me — sees ACTIVE enrollment
  ↓ GET /api/courses/:id/lessons — now has access (enrollment ACTIVE required)
  ↓ Dashboard updates, can learn
```

## Security

- Supabase Auth: tokens verified via /auth/v1/user, cached 60s
- RLS: students SELECT own payments only, INSERT own PENDING, cannot UPDATE status, cannot approve/reject
- Admin: role checked via profiles.role, read via service_role on every request, never trust token claims
- Storage: private bucket payment-receipts, no public access, signed URLs 10min student, 1h admin
- Validation: zod schemas, magic-byte file verification, amount from DB, coupon via RPC
- Constraints: unique transaction_reference, unique pending per course, check rejection_reason
- Race: SELECT FOR UPDATE + WHERE status=PENDING, 409 if already reviewed
- Audit: all sensitive actions logged to audit_logs, never modifiable by students
- Rate limiting: paymentLimiter on POST /api/payments, per-user fixed window
- Secrets: SERVICE_ROLE_KEY server only, never returned

## Error Codes

| Status | Meaning | Example |
|--------|---------|---------|
| 200 | Success, or integrity refusal (DanTECH) | Payment list |
| 201 | Created | Payment submitted, free enrollment |
| 400 | Invalid request | Invalid coupon, amount mismatch, receipt required, invalid receipt |
| 401 | Unauthenticated | Missing/invalid token |
| 403 | Unauthorized | Student trying admin endpoint, or accessing another student's receipt |
| 404 | Not found | Payment/course not found, receipt not found, coupon not found |
| 409 | Conflict | Payment already reviewed, duplicate transaction reference, already enrolled, payment already pending |
| 422 | Invalid payment evidence | Magic byte mismatch, file type not allowed |
| 500 | Server error | Storage failure, DB error (no stack trace) |

## Testing

Run `npm run test:db` for legacy LMS schema tests (embedded Postgres).

For payment system, run manual tests:

1. Student submits payment → PENDING
2. Student sees own payment in /api/payments/me
3. Student cannot see another student's payment (403)
4. Admin sees pending in /api/admin/payments
5. Admin views receipt via signed URL
6. Admin approves → enrollment ACTIVE
7. Student gets course access via /api/courses/:id/lessons
8. Admin tries duplicate approval → 409
9. Student tries to approve → 403
10. Duplicate transaction_reference → 409
11. Invalid receipt (wrong magic bytes) → 400/422
12. 100% coupon WOLI100 → free enrollment, no payment
13. 50% coupon WELCOME50 → amount_due 2500, payment PENDING with discount, after approval enrollment ACTIVE and used_count++

See `scripts/test-payments.mjs` for automated checks (requires DATABASE_URL and service role).

## Frontend Integration

- Never implement payment approval logic in frontend
- Always use backend-calculated amount_to_pay from /api/enrollments
- For 100% coupon, call /api/coupons/apply or /api/enrollments with coupon_code — no receipt needed
- For partial coupon, call /api/enrollments with coupon_code to get discounted amount, then POST /api/payments with coupon_code + receipt
- Show student payment history via /api/payments/me
- Show rejection reason from payment.rejection_reason
- Admin dashboard: list via /api/admin/payments, approve/reject via POST, view receipt via /api/admin/payments/:id/receipt (signed URL)

## Environment Variables

No new env vars required — uses existing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, etc.

Receipt bucket `payment-receipts` must exist (created by migration 004 storage).

## Migrations

- 001: initial schema (payments, enrollments, payment_receipts)
- 008: coupons, coupon_redemptions, payments enhancements (currency, coupon_id, discount_amount, etc.), seed WOLI100 and WELCOME50
- 009: approve_payment/reject_payment enhanced for coupons

Run `npm run migrate` to apply.
