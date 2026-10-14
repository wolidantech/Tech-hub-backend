-- =====================================================================
-- 015 — LECTURER ASSIGNMENTS + ADMIN-GATED CONTENT & GRADE WORKFLOW
-- =====================================================================
-- Apply ONLY to the frontend/live schema (migrations 001-011 + 012 + 014).
-- Never apply the legacy backend chain to that project. This file is
-- additive and idempotent.
--
-- What it adds
-- ------------
-- 1. Role helpers: public.is_instructor() and public.teaches(course_id).
--    Lecturer powers come ONLY from profiles.role = 'instructor' plus a row
--    in lecturer_course_assignments — never from JWT metadata.
--
-- 2. lecturer_course_assignments: admin-managed mapping. Lecturers can act
--    only on courses listed here; removing a row revokes access immediately.
--
-- 3. Draft/publish separation on live content tables (course_modules,
--    course_lessons, quizzes, assignments get status/archived/created_by
--    columns). Student-facing read policies now hide draft/archived rows,
--    so anything a lecturer creates is invisible until an admin publishes it.
--
-- 4. lecturer_content_revisions: the moderation table. A lecturer's module,
--    lesson, quiz or assignment work lives here as a draft, is submitted for
--    review, and is COPIED into the live tables only when an admin approves
--    the exact submitted payload. Editing published work always creates a
--    new revision, so the approved version stays unchanged for students.
--
-- 5. lecturer_grade_reviews: lecturer marks/feedback are proposed here and
--    released to assignment_submissions only by an admin. Until release, the
--    student-visible submission keeps its previous state, so unapproved marks
--    cannot affect progress, XP, completion rules or certificates. Release
--    goes through the existing triggers, so XP and certificate eligibility
--    are evaluated only at release time.
--
-- 6. RLS hardening for lecturers: read access to assigned courses, enrolled
--    students, submissions and quiz answers; draft-insert policies for the
--    browser-defence-in-depth path. Lecturers can never UPDATE or DELETE
--    live content directly, can never approve their own work, and students
--    cannot read moderation tables or quiz answer keys.
--
-- 7. A private `resources-pending` storage bucket for files attached to
--    pending content. Files land in the public live buckets only after the
--    owning revision is approved (performed by the service-role backend).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------
create or replace function public.is_instructor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'instructor'
  );
$$;

comment on function public.is_instructor() is
  'True when profiles.role = instructor for auth.uid(); SECURITY DEFINER mirrors is_admin() and avoids recursive profiles RLS.';

-- ---------------------------------------------------------------------
-- 2. Assignments table (admin-managed)
-- ---------------------------------------------------------------------
create table if not exists public.lecturer_course_assignments (
  id          uuid primary key default gen_random_uuid(),
  lecturer_id uuid not null references public.profiles(id) on delete cascade,
  course_id   uuid not null references public.courses(id) on delete cascade,
  assigned_by text,
  created_at  timestamptz not null default now(),
  unique (lecturer_id, course_id)
);
create index if not exists idx_lca_course on public.lecturer_course_assignments(course_id);
alter table public.lecturer_course_assignments enable row level security;

drop policy if exists "lecturer assignments readable" on public.lecturer_course_assignments;
create policy "lecturer assignments readable" on public.lecturer_course_assignments
  for select using (public.is_admin() or lecturer_id = auth.uid());
-- No insert/update/delete policies: assignments change only through the
-- SECURITY DEFINER RPCs below, which validate roles and write audit logs.

-- teaches() reads lecturer_course_assignments, and language-sql bodies are
-- validated at CREATE time — so it must be defined AFTER the table exists.
create or replace function public.teaches(p_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.lecturer_course_assignments a
    where a.lecturer_id = auth.uid()
      and a.course_id = p_course_id
  );
$$;

comment on function public.teaches(uuid) is
  'True when auth.uid() has an active lecturer_course_assignments row for the given course.';

-- ---------------------------------------------------------------------
-- 3. Draft/publish columns on live content tables
-- ---------------------------------------------------------------------
alter table public.course_modules
  add column if not exists status text not null default 'published'
    check (status in ('draft', 'published', 'archived')),
  add column if not exists archived boolean not null default false,
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists approved_revision_id uuid;

alter table public.course_lessons
  add column if not exists status text not null default 'published'
    check (status in ('draft', 'published', 'archived')),
  add column if not exists archived boolean not null default false,
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists approved_revision_id uuid;

alter table public.quizzes
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists approved_revision_id uuid;

alter table public.assignments
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists approved_revision_id uuid;

-- ---------------------------------------------------------------------
-- 4. Moderation tables
-- ---------------------------------------------------------------------
create table if not exists public.lecturer_content_revisions (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in (
                 'module_create', 'module_update', 'module_remove',
                 'lesson_create', 'lesson_update', 'lesson_remove',
                 'quiz_create',   'quiz_update',   'quiz_remove',
                 'assignment_create', 'assignment_update', 'assignment_remove')),
  course_id    uuid not null references public.courses(id) on delete cascade,
  module_id    uuid references public.course_modules(id) on delete set null,
  lesson_id    uuid references public.course_lessons(id) on delete set null,
  target_id    uuid,                       -- row being edited/archived; null for creates
  lecturer_id  uuid not null references public.profiles(id) on delete cascade,
  title        text not null,
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'draft'
                 check (status in ('draft', 'pending_approval', 'changes_requested',
                                   'rejected', 'approved')),
  review_notes text,
  reviewed_by  uuid references public.profiles(id),
  reviewed_at  timestamptz,
  submitted_at timestamptz,
  version      integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_lcr_status on public.lecturer_content_revisions(status, course_id);
create index if not exists idx_lcr_lecturer on public.lecturer_content_revisions(lecturer_id, status);
alter table public.lecturer_content_revisions enable row level security;

drop policy if exists "lecturer content own read" on public.lecturer_content_revisions;
create policy "lecturer content own read" on public.lecturer_content_revisions
  for select using (public.is_admin() or lecturer_id = auth.uid());
drop policy if exists "lecturer content own draft insert" on public.lecturer_content_revisions;
create policy "lecturer content own draft insert" on public.lecturer_content_revisions
  for insert with check (
    public.is_instructor()
    and lecturer_id = auth.uid()
    and status = 'draft'
    and public.teaches(course_id)
  );
drop policy if exists "lecturer content own draft update" on public.lecturer_content_revisions;
create policy "lecturer content own draft update" on public.lecturer_content_revisions
  for update using (lecturer_id = auth.uid() and status in ('draft', 'changes_requested'))
  with check (lecturer_id = auth.uid() and status in ('draft', 'pending_approval'));
drop policy if exists "lecturer content own draft delete" on public.lecturer_content_revisions;
create policy "lecturer content own draft delete" on public.lecturer_content_revisions
  for delete using (lecturer_id = auth.uid() and status = 'draft');
-- Admins review through admin_review_content_approval(); no direct writes.

create table if not exists public.lecturer_grade_reviews (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  submission_id uuid references public.assignment_submissions(id) on delete set null,
  course_id     uuid not null references public.courses(id) on delete cascade,
  student_id    uuid not null references public.profiles(id) on delete cascade,
  lecturer_id   uuid not null references public.profiles(id) on delete cascade,
  decision      text not null check (decision in ('approved', 'changes_requested')),
  score         integer,
  feedback      text not null default '',
  prev_values   jsonb not null default '{}'::jsonb,   -- student-visible values before this grade
  status        text not null default 'draft'
                  check (status in ('draft', 'pending_approval', 'changes_requested',
                                    'rejected', 'released')),
  review_notes  text,
  reviewed_by   uuid references public.profiles(id),
  reviewed_at   timestamptz,
  submitted_at  timestamptz,
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (assignment_id, student_id, lecturer_id)
);
create index if not exists idx_lgr_status on public.lecturer_grade_reviews(status, course_id);
create index if not exists idx_lgr_lecturer on public.lecturer_grade_reviews(lecturer_id, status);
alter table public.lecturer_grade_reviews enable row level security;

drop policy if exists "lecturer grades own read" on public.lecturer_grade_reviews;
create policy "lecturer grades own read" on public.lecturer_grade_reviews
  for select using (public.is_admin() or lecturer_id = auth.uid());
drop policy if exists "lecturer grades own insert" on public.lecturer_grade_reviews;
create policy "lecturer grades own insert" on public.lecturer_grade_reviews
  for insert with check (
    public.is_instructor()
    and lecturer_id = auth.uid()
    and status in ('draft', 'pending_approval')
    and public.teaches(course_id)
  );
drop policy if exists "lecturer grades own update" on public.lecturer_grade_reviews;
create policy "lecturer grades own update" on public.lecturer_grade_reviews
  for update using (lecturer_id = auth.uid() and status in ('draft', 'changes_requested'))
  with check (lecturer_id = auth.uid() and status in ('draft', 'pending_approval'));
drop policy if exists "lecturer grades own delete" on public.lecturer_grade_reviews;
create policy "lecturer grades own delete" on public.lecturer_grade_reviews
  for delete using (lecturer_id = auth.uid() and status = 'draft');

-- Readers for the lecturer dashboard: admins see every lecturer's queue and
-- history, so review pages must expose the lecturer's name/course names.
drop policy if exists "lecturer content course names" on public.courses;
create policy "lecturer content course names" on public.courses
  for select using (
    public.is_instructor() and public.teaches(id)
  );

-- ---------------------------------------------------------------------
-- 5. Lecturer read access to assigned courses (RLS)
-- ---------------------------------------------------------------------
drop policy if exists "instructor read teaching modules" on public.course_modules;
create policy "instructor read teaching modules" on public.course_modules
  for select using (public.is_instructor() and public.teaches(course_id));

drop policy if exists "instructor read teaching lessons" on public.course_lessons;
create policy "instructor read teaching lessons" on public.course_lessons
  for select using (public.is_instructor() and public.teaches(course_id));

drop policy if exists "instructor read teaching content" on public.course_content;
create policy "instructor read teaching content" on public.course_content
  for select using (
    public.is_instructor() and exists (
      select 1 from public.course_lessons l
      where l.id = course_content.lesson_id and public.teaches(l.course_id)
    )
  );

drop policy if exists "instructor read teaching quizzes" on public.quizzes;
create policy "instructor read teaching quizzes" on public.quizzes
  for select using (public.is_instructor() and public.teaches(course_id));

drop policy if exists "instructor read teaching questions" on public.quiz_questions;
create policy "instructor read teaching questions" on public.quiz_questions
  for select using (
    public.is_instructor() and exists (
      select 1 from public.quizzes q
      where q.id = quiz_questions.quiz_id and public.teaches(q.course_id)
    )
  );

drop policy if exists "instructor read teaching assignments" on public.assignments;
create policy "instructor read teaching assignments" on public.assignments
  for select using (public.is_instructor() and public.teaches(course_id));

drop policy if exists "instructor read teaching attempts" on public.quiz_attempts;
create policy "instructor read teaching attempts" on public.quiz_attempts
  for select using (public.is_instructor() and public.teaches(course_id));

drop policy if exists "instructor read teaching submissions" on public.assignment_submissions;
create policy "instructor read teaching submissions" on public.assignment_submissions
  for select using (public.is_instructor() and public.teaches(course_id));

drop policy if exists "instructor read teaching enrollments" on public.enrollments;
create policy "instructor read teaching enrollments" on public.enrollments
  for select using (public.is_instructor() and public.teaches(course_id));

drop policy if exists "instructor read enrolled students" on public.profiles;
create policy "instructor read enrolled students" on public.profiles
  for select using (
    public.is_instructor() and exists (
      select 1 from public.enrollments e
      where e.user_id = profiles.id and public.teaches(e.course_id)
    )
  );

-- ---------------------------------------------------------------------
-- 6. Student-facing read policies now hide draft/archived content.
--    (Replacements for the policies created in 001/009.)
-- ---------------------------------------------------------------------
drop policy if exists "modules readable" on public.course_modules;
create policy "modules readable" on public.course_modules
  for select using (
    public.is_admin()
    or (status = 'published'
        and archived = false
        and (exists (
               select 1 from public.courses c
               where c.id = course_modules.course_id
                 and c.published = true
                 and coalesce(c.archived, false) = false
             )
             or exists (
               select 1 from public.enrollments e
               where e.course_id = course_modules.course_id
                 and e.user_id = auth.uid()
                 and e.status = 'active'
             )))
  );

drop policy if exists "lessons readable" on public.course_lessons;
create policy "lessons readable" on public.course_lessons
  for select using (
    public.is_admin()
    or (status = 'published'
        and archived = false
        and (exists (
               select 1 from public.courses c
               where c.id = course_lessons.course_id
                 and c.published = true
                 and coalesce(c.archived, false) = false
             )
             or exists (
               select 1 from public.enrollments e
               where e.course_id = course_lessons.course_id
                 and e.user_id = auth.uid()
                 and e.status = 'active'
             )))
  );

drop policy if exists "content enrolled only" on public.course_content;
create policy "content enrolled only" on public.course_content
  for select using (
    public.is_admin()
    or exists (
      select 1
      from public.course_lessons l
      join public.enrollments e on e.course_id = l.course_id
      where l.id = course_content.lesson_id
        and l.status = 'published'
        and l.archived = false
        and e.user_id = auth.uid()
        and e.status = 'active'
    )
  );

-- Lecturers may create DRAFT shells for their assigned courses (defence in
-- depth for any browser-side drafting); publishing still requires admin
-- approval via the review RPCs. No lecturer UPDATE/DELETE policies exist.
drop policy if exists "instructor draft module insert" on public.course_modules;
create policy "instructor draft module insert" on public.course_modules
  for insert with check (
    public.is_instructor()
    and public.teaches(course_id)
    and status = 'draft'
    and created_by = auth.uid()
  );

drop policy if exists "instructor draft lesson insert" on public.course_lessons;
create policy "instructor draft lesson insert" on public.course_lessons
  for insert with check (
    public.is_instructor()
    and public.teaches(course_id)
    and status = 'draft'
    and created_by = auth.uid()
    and exists (
      select 1 from public.course_modules m
      where m.id = module_id and m.course_id = course_lessons.course_id
    )
  );

drop policy if exists "instructor draft quiz insert" on public.quizzes;
create policy "instructor draft quiz insert" on public.quizzes
  for insert with check (
    public.is_instructor()
    and public.teaches(course_id)
    and status = 'draft'
    and created_by = auth.uid()
  );

drop policy if exists "instructor draft assignment insert" on public.assignments;
create policy "instructor draft assignment insert" on public.assignments
  for insert with check (
    public.is_instructor()
    and public.teaches(course_id)
    and status = 'draft'
    and created_by = auth.uid()
  );

-- Quiz RPCs: lecturers may preview their own courses' quizzes exactly as
-- students would; answer review stays attempt-gated or privileged.
create or replace function public.get_quiz_questions(p_quiz_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); q record;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  select * into q from public.quizzes where id = p_quiz_id;
  if not found then raise exception 'Quiz not found'; end if;
  if q.status != 'published'
     and not public.is_admin()
     and not (public.is_instructor() and public.teaches(q.course_id)) then
    raise exception 'Quiz is not available';
  end if;
  if not public.is_admin()
     and not (public.is_instructor() and public.teaches(q.course_id))
     and not exists (
       select 1 from public.enrollments e
       where e.user_id = me and e.course_id = q.course_id and e.status = 'active'
     ) then
    raise exception 'Course access has not yet been approved';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', qq.id, 'type', qq.type, 'question', qq.question, 'options', qq.options
    ) order by qq.created_at, qq.id)
    from public.quiz_questions qq where qq.quiz_id = p_quiz_id
  ), '[]'::jsonb);
end $$;

create or replace function public.get_quiz_review(p_quiz_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); q record;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  select * into q from public.quizzes where id = p_quiz_id;
  if not found then raise exception 'Quiz not found'; end if;
  if not public.is_admin()
     and not (public.is_instructor() and public.teaches(q.course_id))
     and not exists (
       select 1 from public.quiz_attempts a where a.quiz_id = p_quiz_id and a.user_id = me
     ) then
    raise exception 'Attempt the quiz first to see the answers';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', qq.id, 'type', qq.type, 'question', qq.question, 'options', qq.options,
      'correctAnswer', qq.correct_answer, 'correctAnswers', qq.correct_answers,
      'acceptedAnswers', qq.accepted_answers, 'explanation', qq.explanation
    ) order by qq.created_at, qq.id)
    from public.quiz_questions qq where qq.quiz_id = p_quiz_id
  ), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 7. Admin: manage lecturer assignments
-- ---------------------------------------------------------------------
create or replace function public.admin_upsert_lecturer_assignment(
  p_lecturer_id uuid,
  p_course_id uuid
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  admin_email text; admin_name text;
  lecturer record; course record; row public.lecturer_course_assignments%rowtype;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select email, full_name into admin_email, admin_name
  from public.profiles where id = auth.uid();

  select id, full_name, email, role into lecturer
  from public.profiles where id = p_lecturer_id;
  if not found then raise exception 'Lecturer account not found'; end if;
  if lecturer.role <> 'instructor' then
    raise exception 'That user is not a lecturer (role: %)', lecturer.role;
  end if;

  select id, title into course from public.courses where id = p_course_id;
  if not found then raise exception 'Course not found'; end if;

  insert into public.lecturer_course_assignments (lecturer_id, course_id, assigned_by)
  values (p_lecturer_id, p_course_id, admin_email)
  on conflict (lecturer_id, course_id)
  do update set assigned_by = excluded.assigned_by, created_at = now()
  returning * into row;

  insert into public.student_notifications (user_id, type, title, message, course_id)
  values (p_lecturer_id, 'lecturer_assignment', 'New course assigned',
    'You can now prepare materials, quizzes, assignments and marking for "' || course.title
      || '". Everything you submit is reviewed by an administrator before students see it.',
    p_course_id);

  insert into public.audit_logs (actor_email, actor_name, action, entity_type, entity_id, details)
  values (admin_email, admin_name, 'lecturer.assign_course', 'lecturer_course_assignment', row.id::text,
    jsonb_build_object('lecturerId', p_lecturer_id, 'lecturer', lecturer.email, 'courseId', p_course_id));

  return jsonb_build_object(
    'id', row.id, 'lecturerId', row.lecturer_id, 'courseId', row.course_id, 'createdAt', row.created_at);
end $$;

create or replace function public.admin_remove_lecturer_assignment(
  p_lecturer_id uuid,
  p_course_id uuid
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare admin_email text; admin_name text; removed int;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select email, full_name into admin_email, admin_name
  from public.profiles where id = auth.uid();

  delete from public.lecturer_course_assignments
  where lecturer_id = p_lecturer_id and course_id = p_course_id;
  get diagnostics removed = row_count;

  if removed > 0 then
    insert into public.student_notifications (user_id, type, title, message, course_id)
    values (p_lecturer_id, 'lecturer_assignment_removed', 'Course access removed',
      'Your lecturer access to that course has been removed by an administrator.', p_course_id);

    insert into public.audit_logs (actor_email, actor_name, action, entity_type, entity_id, details)
    values (admin_email, admin_name, 'lecturer.remove_course', 'lecturer_course_assignment',
      p_lecturer_id::text,
      jsonb_build_object('lecturerId', p_lecturer_id, 'courseId', p_course_id));
  end if;

  return jsonb_build_object('ok', true, 'removed', removed);
end $$;

-- ---------------------------------------------------------------------
-- 8. Lecturer: content drafts -> submit for review
-- ---------------------------------------------------------------------
create or replace function public.lecturer_save_content_draft(
  p_revision_id uuid,
  p_kind        text,
  p_course_id   uuid,
  p_module_id   uuid,
  p_lesson_id   uuid,
  p_target_id   uuid,
  p_title       text,
  p_payload     jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rev public.lecturer_content_revisions%rowtype;
  m record; l record; t record;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.is_instructor() then raise exception 'Lecturers only'; end if;
  if not public.teaches(p_course_id) then
    raise exception 'You are not assigned to this course';
  end if;
  if p_kind not in (
    'module_create', 'module_update', 'module_remove',
    'lesson_create', 'lesson_update', 'lesson_remove',
    'quiz_create',   'quiz_update',   'quiz_remove',
    'assignment_create', 'assignment_update', 'assignment_remove'
  ) then raise exception 'Unsupported change kind: %', p_kind; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'A title is required'; end if;

  -- Parent module must belong to the course when provided.
  if p_module_id is not null then
    select id, course_id, title into m from public.course_modules where id = p_module_id;
    if not found or m.course_id <> p_course_id then
      raise exception 'Module does not belong to this course';
    end if;
  end if;

  -- Parent/owning lesson must belong to the course (and module) when provided.
  if p_lesson_id is not null then
    select id, module_id, course_id into l from public.course_lessons where id = p_lesson_id;
    if not found or l.course_id <> p_course_id then
      raise exception 'Lesson does not belong to this course';
    end if;
    if p_module_id is not null and l.module_id <> p_module_id then
      raise exception 'Lesson does not belong to that module';
    end if;
  end if;

  -- Targets for updates/removals must exist under the same course.
  if p_kind like '%\_update' escape '\' or p_kind like '%\_remove' escape '\' then
    if p_target_id is null then raise exception 'A target is required for %', p_kind; end if;
    if p_kind like 'module%' then
      select id, course_id into t from public.course_modules where id = p_target_id;
    elsif p_kind like 'lesson%' then
      select id, course_id into t from public.course_lessons where id = p_target_id;
    elsif p_kind like 'quiz%' then
      select id, course_id into t from public.quizzes where id = p_target_id;
    else
      select id, course_id into t from public.assignments where id = p_target_id;
    end if;
    if not found or t.course_id <> p_course_id then
      raise exception 'That item does not belong to this course';
    end if;
  elsif p_target_id is not null then
    raise exception 'Create actions must not reference an existing target';
  end if;

  if p_kind in ('lesson_create', 'lesson_update') and p_module_id is null and p_kind = 'lesson_create' then
    raise exception 'lesson_create requires a module';
  end if;

  if p_revision_id is not null then
    select * into rev from public.lecturer_content_revisions where id = p_revision_id for update;
    if not found then raise exception 'Draft not found'; end if;
    if rev.lecturer_id <> auth.uid() then raise exception 'That draft belongs to another lecturer'; end if;
    if rev.status not in ('draft', 'changes_requested') then
      raise exception 'Only drafts can be edited (current status: %)', rev.status;
    end if;

    update public.lecturer_content_revisions
    set kind = p_kind, course_id = p_course_id, module_id = p_module_id,
        lesson_id = p_lesson_id, target_id = p_target_id,
        title = trim(p_title), payload = coalesce(p_payload, '{}'::jsonb),
        updated_at = now()
    where id = p_revision_id
    returning * into rev;
  else
    insert into public.lecturer_content_revisions
      (kind, course_id, module_id, lesson_id, target_id, lecturer_id, title, payload, status)
    values
      (p_kind, p_course_id, p_module_id, p_lesson_id, p_target_id,
       auth.uid(), trim(p_title), coalesce(p_payload, '{}'::jsonb), 'draft')
    returning * into rev;
  end if;

  return jsonb_build_object(
    'id', rev.id, 'kind', rev.kind, 'courseId', rev.course_id,
    'title', rev.title, 'status', rev.status, 'version', rev.version,
    'updatedAt', rev.updated_at);
end $$;

create or replace function public.lecturer_submit_content_for_review(p_revision_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rev public.lecturer_content_revisions%rowtype;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into rev from public.lecturer_content_revisions where id = p_revision_id for update;
  if not found then raise exception 'Draft not found'; end if;
  if rev.lecturer_id <> auth.uid() then raise exception 'That draft belongs to another lecturer'; end if;
  if not public.teaches(rev.course_id) then raise exception 'You are not assigned to this course'; end if;
  if rev.status not in ('draft', 'changes_requested') then
    raise exception 'Only drafts or requested changes can be submitted (current status: %)', rev.status;
  end if;

  update public.lecturer_content_revisions
  set status = 'pending_approval',
      submitted_at = now(),
      version = version + case when rev.status = 'changes_requested' then 1 else 0 end,
      updated_at = now()
  where id = p_revision_id
  returning * into rev;

  return jsonb_build_object(
    'id', rev.id, 'status', rev.status, 'version', rev.version, 'submittedAt', rev.submitted_at);
end $$;

-- ---------------------------------------------------------------------
-- 9. Admin: review lecturer content (approve publishes the exact payload)
-- ---------------------------------------------------------------------
create or replace function public.admin_review_content_approval(
  p_revision_id uuid,
  p_action      text,
  p_notes       text default ''
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rev public.lecturer_content_revisions%rowtype;
  admin_email text; admin_name text;
  new_id uuid; pos int; applied_table text; q record;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_action not in ('approved', 'rejected', 'changes_requested') then
    raise exception 'Unsupported review action: %', p_action;
  end if;
  if p_action <> 'approved' and coalesce(trim(p_notes), '') = '' then
    raise exception 'A reason is required when rejecting or requesting changes';
  end if;

  select email, full_name into admin_email, admin_name
  from public.profiles where id = auth.uid();

  select * into rev from public.lecturer_content_revisions where id = p_revision_id for update;
  if not found then raise exception 'Review item not found'; end if;
  if rev.status <> 'pending_approval' then
    raise exception 'This item has already been reviewed (status: %)', rev.status;
  end if;
  if rev.lecturer_id = auth.uid() then
    raise exception 'You cannot approve your own lecturer submission';
  end if;

  if p_action = 'approved' then
    set local app.lecturer_action = 'publish_content';
    case rev.kind
      when 'module_create' then
        select coalesce(max(position) + 1, 0) into pos
        from public.course_modules where course_id = rev.course_id;
        insert into public.course_modules
          (course_id, title, position, status, archived, created_by, approved_revision_id)
        values (rev.course_id, rev.title, pos, 'published', false, rev.lecturer_id, rev.id)
        returning id into new_id;
        applied_table := 'course_modules';

      when 'module_update' then
        update public.course_modules
        set title = coalesce(nullif(trim(rev.payload->>'title'), ''), rev.title),
            position = coalesce(nullif(rev.payload->>'position', '')::int, position),
            approved_revision_id = rev.id
        where id = rev.target_id
        returning id into new_id;
        if new_id is null then raise exception 'Module no longer exists'; end if;
        applied_table := 'course_modules';

      when 'module_remove' then
        update public.course_modules
        set archived = true, status = 'archived', approved_revision_id = rev.id
        where id = rev.target_id and archived = false
        returning id into new_id;
        if new_id is null then raise exception 'Module no longer exists'; end if;
        update public.course_lessons
        set archived = true, status = 'archived'
        where module_id = rev.target_id;
        update public.quizzes set status = 'archived' where module_id = rev.target_id;
        update public.assignments set status = 'archived' where module_id = rev.target_id;
        applied_table := 'course_modules';

      when 'lesson_create' then
        select coalesce(max(position) + 1, 0) into pos
        from public.course_lessons where module_id = rev.module_id;
        insert into public.course_lessons
          (module_id, course_id, title, type, duration, position, description,
           resources, status, archived, created_by, approved_revision_id)
        values (
          rev.module_id, rev.course_id, rev.title,
          coalesce(nullif(rev.payload->>'type', ''), 'text'),
          nullif(rev.payload->>'duration', ''),
          pos,
          coalesce(rev.payload->>'description', ''),
          coalesce(rev.payload->'resources', '[]'::jsonb),
          'published', false, rev.lecturer_id, rev.id)
        returning id into new_id;
        if rev.payload ? 'content' then
          insert into public.course_content (lesson_id, body_markdown)
          values (new_id, coalesce(rev.payload->>'content', ''))
          on conflict (lesson_id)
          do update set body_markdown = excluded.body_markdown, updated_at = now();
        end if;
        if rev.payload ? 'video' then
          insert into public.course_videos (lesson_id, provider, url, storage_path, duration_seconds, status)
          values (
            new_id,
            coalesce(nullif(rev.payload->'video'->>'provider', ''), 'youtube'),
            nullif(rev.payload->'video'->>'url', ''),
            nullif(rev.payload->'video'->>'storage_path', ''),
            nullif(rev.payload->'video'->>'duration_seconds', '')::int,
            'published');
        end if;
        applied_table := 'course_lessons';

      when 'lesson_update' then
        update public.course_lessons
        set title = coalesce(nullif(trim(rev.payload->>'title'), ''), rev.title),
            duration = coalesce(nullif(rev.payload->>'duration', ''), duration),
            description = coalesce(rev.payload->>'description', description),
            resources = coalesce(rev.payload->'resources', resources),
            approved_revision_id = rev.id
        where id = rev.target_id
        returning id into new_id;
        if new_id is null then raise exception 'Lesson no longer exists'; end if;
        if rev.payload ? 'content' then
          insert into public.course_content (lesson_id, body_markdown)
          values (new_id, coalesce(rev.payload->>'content', ''))
          on conflict (lesson_id)
          do update set body_markdown = excluded.body_markdown, updated_at = now();
        end if;
        if rev.payload ? 'video' then
          insert into public.course_videos (lesson_id, provider, url, storage_path, duration_seconds, status)
          values (
            new_id,
            coalesce(nullif(rev.payload->'video'->>'provider', ''), 'youtube'),
            nullif(rev.payload->'video'->>'url', ''),
            nullif(rev.payload->'video'->>'storage_path', ''),
            nullif(rev.payload->'video'->>'duration_seconds', '')::int,
            'published');
        end if;
        applied_table := 'course_lessons';

      when 'lesson_remove' then
        update public.course_lessons
        set archived = true, status = 'archived', approved_revision_id = rev.id
        where id = rev.target_id and archived = false
        returning id into new_id;
        if new_id is null then raise exception 'Lesson no longer exists'; end if;
        applied_table := 'course_lessons';

      when 'quiz_create', 'quiz_update' then
        if rev.kind = 'quiz_update' then
          update public.quizzes
          set status = 'archived'
          where id = rev.target_id and status <> 'archived';
        end if;
        insert into public.quizzes
          (course_id, module_id, lesson_id, title, description, passing_score,
           allow_retake, attempt_limit, is_final, status, created_by, approved_revision_id)
        values (
          rev.course_id, rev.module_id, rev.lesson_id, rev.title,
          rev.payload->>'description',
          coalesce(nullif(rev.payload->>'passing_score', '')::int, 70),
          coalesce(nullif(rev.payload->>'allow_retake', '')::boolean, true),
          nullif(rev.payload->>'attempt_limit', '')::int,
          coalesce(nullif(rev.payload->>'is_final', '')::boolean, false),
          'published', rev.lecturer_id, rev.id)
        returning id into new_id;
        for q in
          select value from jsonb_array_elements(coalesce(rev.payload->'questions', '[]'::jsonb))
        loop
          insert into public.quiz_questions
            (quiz_id, type, question, options, correct_answer, correct_answers,
             accepted_answers, explanation)
          values (
            new_id,
            coalesce(nullif(q.value->>'type', ''), 'multiple_choice'),
            coalesce(q.value->>'question', ''),
            coalesce(q.value->'options', '[]'::jsonb),
            nullif(q.value->>'correct_answer', '')::int,
            coalesce(q.value->'correct_answers', '[]'::jsonb),
            coalesce((select array_agg(v) from jsonb_array_elements_text(q.value->'accepted_answers') v), '{}'),
            q.value->>'explanation');
        end loop;
        applied_table := 'quizzes';

      when 'quiz_remove' then
        update public.quizzes
        set status = 'archived', approved_revision_id = rev.id
        where id = rev.target_id and status <> 'archived'
        returning id into new_id;
        if new_id is null then raise exception 'Quiz no longer exists'; end if;
        applied_table := 'quizzes';

      when 'assignment_create', 'assignment_update' then
        if rev.kind = 'assignment_update' then
          update public.assignments
          set status = 'archived'
          where id = rev.target_id and status <> 'archived';
        end if;
        insert into public.assignments
          (course_id, module_id, lesson_id, title, description, instructions,
           required_output, max_score, is_final_project, deadline, submission_type,
           status, created_by, approved_revision_id)
        values (
          rev.course_id, rev.module_id, rev.lesson_id, rev.title,
          rev.payload->>'description',
          rev.payload->>'instructions',
          rev.payload->>'required_output',
          coalesce(nullif(rev.payload->>'max_score', '')::int, 100),
          coalesce(nullif(rev.payload->>'is_final_project', '')::boolean, false),
          nullif(rev.payload->>'deadline', '')::timestamptz,
          coalesce(nullif(rev.payload->>'submission_type', ''), 'any'),
          'published', rev.lecturer_id, rev.id)
        returning id into new_id;
        applied_table := 'assignments';

      when 'assignment_remove' then
        update public.assignments
        set status = 'archived', approved_revision_id = rev.id
        where id = rev.target_id and status <> 'archived'
        returning id into new_id;
        if new_id is null then raise exception 'Assignment no longer exists'; end if;
        applied_table := 'assignments';

      else
        raise exception 'Unsupported change kind: %', rev.kind;
    end case;
  end if;

  update public.lecturer_content_revisions
  set status = p_action,
      review_notes = nullif(trim(p_notes), ''),
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
  where id = p_revision_id;

  insert into public.student_notifications (user_id, type, title, message, course_id)
  values (
    rev.lecturer_id,
    case p_action
      when 'approved' then 'content_approved'
      when 'rejected' then 'content_rejected'
      else 'content_changes_requested' end,
    case p_action
      when 'approved' then 'Your content was approved'
      when 'rejected' then 'Your content was rejected'
      else 'Changes requested on your content' end,
    '"' || rev.title || '"'
      || case p_action
           when 'approved' then ' has been approved and is now live.'
           when 'rejected' then ' was rejected.'
           else ' needs changes before it can go live.' end
      || case when coalesce(trim(p_notes), '') <> '' then ' Reason: ' || trim(p_notes) else '' end,
    rev.course_id);

  insert into public.audit_logs (actor_email, actor_name, action, entity_type, entity_id, details)
  values (admin_email, admin_name,
    'lecturer_content.' || p_action, 'lecturer_content_revision', rev.id::text,
    jsonb_build_object(
      'kind', rev.kind, 'courseId', rev.course_id, 'lecturerId', rev.lecturer_id,
      'targetTable', applied_table, 'targetId', new_id, 'version', rev.version,
      'notes', nullif(trim(p_notes), '')));

  return jsonb_build_object(
    'ok', true, 'action', p_action, 'revisionId', rev.id,
    'targetTable', applied_table, 'targetId', new_id);
end $$;

-- ---------------------------------------------------------------------
-- 10. Lecturer: propose a grade -> admin releases it
-- ---------------------------------------------------------------------
create or replace function public.lecturer_submit_grade_for_review(
  p_submission_id uuid,
  p_assignment_id uuid,
  p_student_id    uuid,
  p_decision      text,
  p_score         integer,
  p_feedback      text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  sub record; asg record; g public.lecturer_grade_reviews%rowtype;
  prev jsonb; cid uuid; sid uuid; aid uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.is_instructor() then raise exception 'Lecturers only'; end if;

  if p_submission_id is not null then
    select s.id, s.assignment_id, s.user_id, s.course_id, s.status, s.score, s.feedback
    into sub
    from public.assignment_submissions s where s.id = p_submission_id;
    if not found then raise exception 'Submission not found'; end if;
    aid := sub.assignment_id; sid := sub.user_id; cid := sub.course_id;
    prev := jsonb_build_object('status', sub.status, 'score', sub.score, 'feedback', coalesce(sub.feedback, ''));
  else
    if p_assignment_id is null or p_student_id is null then
      raise exception 'Provide a submission, or an assignment and student';
    end if;
    aid := p_assignment_id; sid := p_student_id;
    select s.id into sub from public.assignment_submissions s
    where s.assignment_id = aid and s.user_id = sid;
    prev := coalesce((
      select jsonb_build_object('status', s.status, 'score', s.score, 'feedback', coalesce(s.feedback, ''))
      from public.assignment_submissions s
      where s.assignment_id = aid and s.user_id = sid
    ), '{}'::jsonb);
  end if;

  select a.id, a.course_id, a.max_score, a.title into asg
  from public.assignments a where a.id = aid;
  if not found then raise exception 'Assignment not found'; end if;
  cid := asg.course_id;
  if not public.teaches(cid) then raise exception 'You are not assigned to this course'; end if;

  if p_decision not in ('approved', 'changes_requested') then
    raise exception 'Decision must be "approved" or "changes_requested"';
  end if;
  if p_decision = 'approved' then
    if p_score is null then raise exception 'A score is required to approve work'; end if;
  end if;
  if p_score is not null and (p_score < 0 or p_score > coalesce(asg.max_score, 100)) then
    raise exception 'Score must be between 0 and %', coalesce(asg.max_score, 100);
  end if;
  if p_decision = 'changes_requested' and coalesce(trim(p_feedback), '') = '' then
    raise exception 'Feedback is required when requesting changes';
  end if;

  insert into public.lecturer_grade_reviews as gr
    (assignment_id, submission_id, course_id, student_id, lecturer_id,
     decision, score, feedback, prev_values, status, submitted_at)
  values (
    aid, p_submission_id, cid, sid, auth.uid(),
    p_decision, p_score, coalesce(trim(p_feedback), ''), prev, 'pending_approval', now())
  on conflict (assignment_id, student_id, lecturer_id)
  do update set
    submission_id = excluded.submission_id,
    decision = excluded.decision,
    score = excluded.score,
    feedback = excluded.feedback,
    prev_values = excluded.prev_values,
    status = 'pending_approval',
    submitted_at = now(),
    review_notes = null,
    reviewed_by = null,
    reviewed_at = null,
    version = case when gr.status in ('changes_requested', 'rejected', 'released')
                   then gr.version + 1 else gr.version end,
    updated_at = now()
  returning * into g;

  return jsonb_build_object(
    'id', g.id, 'status', g.status, 'decision', g.decision,
    'score', g.score, 'version', g.version, 'submittedAt', g.submitted_at);
end $$;

create or replace function public.admin_review_grade_approval(
  p_grading_id uuid,
  p_action     text,
  p_notes      text default ''
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g public.lecturer_grade_reviews%rowtype;
  admin_email text; admin_name text;
  course_title text; asg_title text; released boolean := false;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_action not in ('approved', 'rejected', 'changes_requested') then
    raise exception 'Unsupported review action: %', p_action;
  end if;
  if p_action <> 'approved' and coalesce(trim(p_notes), '') = '' then
    raise exception 'A reason is required when rejecting or requesting changes';
  end if;

  select email, full_name into admin_email, admin_name
  from public.profiles where id = auth.uid();

  select * into g from public.lecturer_grade_reviews where id = p_grading_id for update;
  if not found then raise exception 'Review item not found'; end if;
  if g.status <> 'pending_approval' then
    raise exception 'This grade has already been reviewed (status: %)', g.status;
  end if;
  if g.lecturer_id = auth.uid() then
    raise exception 'You cannot approve your own lecturer grade';
  end if;

  select title into course_title from public.courses where id = g.course_id;
  select title into asg_title from public.assignments where id = g.assignment_id;

  if p_action = 'approved' then
    -- The triggers on assignment_submissions award XP and evaluate certificate
    -- eligibility at exactly this moment — only the admin-approved state ever
    -- reaches the student-facing table.
    set local app.lecturer_action = 'release_grade';
    if g.submission_id is not null then
      update public.assignment_submissions
      set status = g.decision,
          score = g.score,
          feedback = g.feedback,
          reviewed_by = admin_email,
          reviewed_at = now()
      where id = g.submission_id;
    end if;
    released := true;

    update public.lecturer_grade_reviews
    set status = 'released',
        review_notes = nullif(trim(p_notes), ''),
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        updated_at = now()
    where id = p_grading_id;

    insert into public.student_notifications (user_id, type, title, message, course_id)
    values (g.student_id, 'grade_released', 'Your work was reviewed',
      '"' || coalesce(asg_title, 'Your assignment') || '" in ' || coalesce(course_title, 'your course')
        || case
             when g.decision = 'approved'
               then ' was approved' || case when g.score is not null then ' with a score of ' || g.score else '' end || '.'
             else ' needs changes. Check the feedback and submit again.'
           end,
      g.course_id);

    insert into public.student_notifications (user_id, type, title, message, course_id)
    values (g.lecturer_id, 'grade_approved', 'Your grade was approved',
      'Your grade for "' || coalesce(asg_title, 'the assignment') || '" was approved and released to the student.',
      g.course_id);
  else
    update public.lecturer_grade_reviews
    set status = p_action,
        review_notes = nullif(trim(p_notes), ''),
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        updated_at = now()
    where id = p_grading_id;

    insert into public.student_notifications (user_id, type, title, message, course_id)
    values (g.lecturer_id,
      case p_action when 'rejected' then 'grade_rejected' else 'grade_changes_requested' end,
      case p_action when 'rejected' then 'Your grade was rejected' else 'Changes requested on your grade' end,
      'Your grade for "' || coalesce(asg_title, 'the assignment') || '" was not released. Reason: ' || trim(p_notes),
      g.course_id);
  end if;

  insert into public.audit_logs (actor_email, actor_name, action, entity_type, entity_id, details)
  values (admin_email, admin_name,
    'lecturer_grade.' || p_action, 'lecturer_grade_review', g.id::text,
    jsonb_build_object(
      'assignmentId', g.assignment_id, 'submissionId', g.submission_id,
      'studentId', g.student_id, 'lecturerId', g.lecturer_id, 'courseId', g.course_id,
      'decision', g.decision, 'score', g.score, 'version', g.version,
      'notes', nullif(trim(p_notes), '')));

  return jsonb_build_object('ok', true, 'action', p_action, 'gradingId', g.id, 'released', released);
end $$;

-- ---------------------------------------------------------------------
-- 11. Execute grants + realtime + pending resources bucket
-- ---------------------------------------------------------------------
grant execute on function public.is_instructor() to authenticated, service_role;
grant execute on function public.teaches(uuid) to authenticated, service_role;
grant execute on function public.admin_upsert_lecturer_assignment(uuid, uuid) to authenticated, service_role;
grant execute on function public.admin_remove_lecturer_assignment(uuid, uuid) to authenticated, service_role;
grant execute on function public.lecturer_save_content_draft(uuid, text, uuid, uuid, uuid, uuid, text, jsonb) to authenticated, service_role;
grant execute on function public.lecturer_submit_content_for_review(uuid) to authenticated, service_role;
grant execute on function public.admin_review_content_approval(uuid, text, text) to authenticated, service_role;
grant execute on function public.lecturer_submit_grade_for_review(uuid, uuid, uuid, text, integer, text) to authenticated, service_role;
grant execute on function public.admin_review_grade_approval(uuid, text, text) to authenticated, service_role;
grant execute on function public.get_quiz_questions(uuid) to authenticated, service_role;
grant execute on function public.get_quiz_review(uuid) to authenticated, service_role;

-- The backend streams a lecturer's pending file into the live bucket only
-- after the revision is approved. Students and anonymous users get nothing.
insert into storage.buckets (id, name, public)
values ('resources-pending', 'resources-pending', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists "pending resources reviewer read" on storage.objects;
create policy "pending resources reviewer read" on storage.objects
  for select using (
    bucket_id = 'resources-pending'
    and (public.is_admin()
         or (public.is_instructor() and auth.uid()::text = (storage.foldername(name))[1]))
  );

drop policy if exists "pending resources lecturer upload" on storage.objects;
create policy "pending resources lecturer upload" on storage.objects
  for insert with check (
    bucket_id = 'resources-pending'
    and public.is_instructor()
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "pending resources lecturer update" on storage.objects;
create policy "pending resources lecturer update" on storage.objects
  for update using (
    bucket_id = 'resources-pending'
    and (public.is_admin() or (public.is_instructor() and auth.uid()::text = (storage.foldername(name))[1]))
  );

-- Realtime so dashboards refresh after admin decisions (guarded for runners
-- where the publication does not exist).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public'
                     and tablename = 'lecturer_content_revisions') then
      alter publication supabase_realtime add table public.lecturer_content_revisions;
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public'
                     and tablename = 'lecturer_grade_reviews') then
      alter publication supabase_realtime add table public.lecturer_grade_reviews;
    end if;
  end if;
end $$;
