-- ============================================================
-- 010 — CERTIFICATES: FULL HOLDER NAME + VERIFICATION CODE BACKFILL
-- ------------------------------------------------------------
-- Two confirmed live bugs are repaired here, in one idempotent migration:
--
-- 1. verify_certificate() masked the holder name ("O***"), so even the
--    certificate owner saw a masked name on their own certificate. The owner
--    has explicitly requested the FULL student name on the public certificate
--    and the public verifier. Certificate IDs carry a random hex suffix and
--    verification codes are separate random values, so full-name display at
--    those unguessable references is the accepted trade-off. The response keeps
--    its exact shape ({ found, status, ... }) and gains verificationCode so
--    the certificate page can print and encode the real code.
--
-- 2. Some live certificate_issues rows carry a NULL/empty verification_code,
--    which rendered "—" on the certificate and made the QR encode the
--    certificate ID by fallback. Backfill every missing code with a
--    deterministic, collision-checked value in the project's WDTH-XXXX-XXXX
--    format, then enforce the invariant for future rows.
--
-- RLS is untouched: certificate_issues stays own-rows/admin-only for direct
-- reads; only the SECURITY DEFINER RPC's output changes. Issue paths
-- (maybe_issue_certificate, issue_certificate_manual) already set both
-- verification_code and issue_date and are not modified.
--
-- Idempotent: safe to apply to a fresh project and safe to re-run.
-- ============================================================

-- ---------- 1. Public verification RPC returns the full holder name ----------
create or replace function public.verify_certificate(p_code text)
returns jsonb language plpgsql security definer
set search_path = public
as $$
declare r record;
begin
  select certificate_id, verification_code, student_name, course_name, issue_date, status
  into r from public.certificate_issues
  where certificate_id = trim(p_code) or verification_code = trim(p_code);
  if not found then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'status', r.status,
    'studentName', coalesce(nullif(btrim(coalesce(r.student_name, '')), ''), 'Student'),
    'courseName', r.course_name, 'issueDate', r.issue_date,
    'certificateId', r.certificate_id,
    'verificationCode', r.verification_code,
    'issuedBy', 'WOLI DAN TECH HUB');
end $$;

comment on function public.verify_certificate(text) is
  'Looks a certificate up by ID or verification code. Returns the full holder name (owner-requested) and the verification code; shape is otherwise unchanged.';

-- ---------- 2. Backfill missing verification codes ----------
-- Deterministic per row (derived from the certificate_id) so a re-run cannot
-- shuffle codes, and collision-checked against every existing code because
-- verification_code is UNIQUE. Matches the gen_verify_code() shape.
do $cert_code_backfill$
declare
  r         record;
  candidate text;
  attempt   int;
  placed    boolean;
begin
  for r in
    select id, certificate_id
      from public.certificate_issues
     where verification_code is null or btrim(verification_code) = ''
  loop
    placed := false;
    for attempt in 1..10 loop
      candidate := 'WDTH-'
        || upper(substr(md5(r.certificate_id || ':code:' || attempt), 1, 4))
        || '-'
        || upper(substr(md5(r.certificate_id || ':salt:' || attempt), 1, 4));
      if not exists (
        select 1 from public.certificate_issues
         where verification_code = candidate and id <> r.id
      ) then
        update public.certificate_issues
           set verification_code = candidate
         where id = r.id;
        placed := true;
        exit;
      end if;
    end loop;
    if not placed then
      raise exception 'certificate %: could not allocate a unique verification_code after 10 attempts',
        r.certificate_id;
    end if;
  end loop;
end
$cert_code_backfill$;

-- ---------- 3. Missing issue dates ----------
-- issue_date defaults to now() on insert; backstop any legacy NULL.
update public.certificate_issues
   set issue_date = now()
 where issue_date is null;

-- ---------- 4. Enforce the invariant going forward ----------
-- Every issue path writes a code; this stops any future hand-edit from
-- re-introducing NULLs. (Safe after step 2: no NULL rows remain.)
alter table public.certificate_issues
  alter column verification_code set not null;

-- ---------- Verify (read-only) ----------
-- Any row still lacking a code or date would surface here (expect zero rows).
select certificate_id, status, verification_code, issue_date
  from public.certificate_issues
 where verification_code is null
    or btrim(verification_code) = ''
    or issue_date is null;
