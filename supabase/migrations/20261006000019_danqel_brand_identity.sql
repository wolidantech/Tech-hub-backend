-- =====================================================================
-- DANQEL DIGITAL INSTITUTE — additive brand identity update
--
-- This migration changes platform-facing names and issuer presentation only.
-- It preserves certificate numbers/codes, validity/revocation, student/course
-- links, account details, support email, authentication, and audit history.
-- =====================================================================

-- Update the public institution name and its official tagline while retaining
-- every operational setting (including support email, currency and bank data).
insert into public.platform_settings (key, value, is_public)
values (
  'platform',
  '{"name":"DANQEL DIGITAL INSTITUTE","tagline":"Technology • Science • Digital Learning","support_email":"wolidantech@gmail.com","currency":"NGN"}'::jsonb,
  true
)
on conflict (key) do update
set value = jsonb_set(
      jsonb_set(
        case when jsonb_typeof(public.platform_settings.value) = 'object'
          then public.platform_settings.value else '{}'::jsonb end,
        '{name}', to_jsonb('DANQEL DIGITAL INSTITUTE'::text), true
      ),
      '{tagline}', to_jsonb('Technology • Science • Digital Learning'::text), true
    ),
    updated_at = now();

-- Keep the existing certificate and verification identifiers. The additional
-- version marker lets the download service re-render old PDFs once, in place.
alter table public.certificates
  add column if not exists pdf_brand_version integer not null default 0;

-- Preserve the public verification response contract; only its issuer value
-- changes. Certificate validity and revocation remain sourced from the row.
create or replace function public.verify_certificate(p_identifier text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
           'valid',              c.status = 'ACTIVE',
           'status',             c.status,
           'student_name',       p.full_name,
           'course_name',        co.title,
           'date_completed',     e.completed_at,
           'certificate_number', c.certificate_number,
           'issued_at',          c.issued_at,
           'issued_by',          'DANQEL DIGITAL INSTITUTE'
         )
    into v_result
    from public.certificates c
    join public.profiles p  on p.id  = c.student_id
    join public.courses  co on co.id = c.course_id
    left join public.enrollments e
           on e.student_id = c.student_id and e.course_id = c.course_id
   where c.certificate_number = upper(trim(p_identifier))
      or c.verification_code = lower(trim(p_identifier));

  return v_result; -- null when not found
end;
$$;

grant execute on function public.verify_certificate(text) to anon, authenticated, service_role;
comment on function public.verify_certificate(text) is
  'Public certificate verification. Returns the existing holder/course/status/identifier contract with the current institutional issuer.';

-- New welcome messages use the current institution name. The trigger behavior,
-- profile fields, student role, and duplicate handling are unchanged.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_full_name  text;
begin
  v_full_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    split_part(coalesce(new.email, 'user'), '@', 1)
  );

  insert into public.profiles (user_id, full_name, email, phone, role)
  values (
    new.id,
    v_full_name,
    coalesce(new.email, ''),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
    'student'
  )
  on conflict (user_id) do nothing
  returning id into v_profile_id;

  if v_profile_id is not null then
    insert into public.notifications (user_id, title, message, type)
    values (
      v_profile_id,
      'Welcome to DANQEL DIGITAL INSTITUTE',
      'Welcome aboard! Technology • Science • Digital Learning. Browse the course catalog, enroll, and start building your future today.',
      'WELCOME'
    );
  end if;

  return new;
end;
$$;

-- Brand-only cleanup for existing welcome notices. Keep the notification row,
-- read state, timestamps, and all non-brand content intact.
update public.notifications
set title = replace(title, 'WOLI DAN TECH HUB', 'DANQEL DIGITAL INSTITUTE'),
    message = replace(
      replace(
        replace(message, 'WOLI DAN TECH HUB', 'DANQEL DIGITAL INSTITUTE'),
        'LEARN • BUILD • GROW', 'Technology • Science • Digital Learning'
      ),
      'Learn • Build • Grow', 'Technology • Science • Digital Learning'
    )
where type = 'WELCOME'
  and (title like '%WOLI DAN TECH HUB%'
       or message like '%WOLI DAN TECH HUB%'
       or message like '%LEARN • BUILD • GROW%'
       or message like '%Learn • Build • Grow%');

-- Update only known, seed-owned Biology catalogue fields. Other/admin-authored
-- courses and content are left untouched.
update public.courses
set description = replace(description, 'WOLI DAN TECH HUB', 'DANQEL DIGITAL INSTITUTE'),
    metadata = case
      when metadata ->> 'instructor_name' = 'WOLI DAN TECH HUB Science Faculty'
        then jsonb_set(metadata, '{instructor_name}', to_jsonb('DANQEL DIGITAL INSTITUTE Science Faculty'::text), true)
      else metadata
    end
where slug = 'biology'
  and (
    coalesce(description, '') like '%WOLI DAN TECH HUB%'
    or metadata ->> 'instructor_name' = 'WOLI DAN TECH HUB Science Faculty'
  );

update public.lessons l
set metadata = jsonb_set(
  l.metadata,
  '{references}',
  (
    select coalesce(
      jsonb_agg(to_jsonb(replace(ref.value, 'WOLI DAN TECH HUB', 'DANQEL DIGITAL INSTITUTE')) order by ref.ordinality),
      '[]'::jsonb
    )
    from jsonb_array_elements_text(
      case when jsonb_typeof(l.metadata -> 'references') = 'array'
        then l.metadata -> 'references' else '[]'::jsonb end
    ) with ordinality as ref(value, ordinality)
  ),
  true
)
where l.seed_key like 'biology:%'
  and l.metadata ->> 'references' like '%WOLI DAN TECH HUB%';

update public.resource_sources
set description = replace(description, 'WOLI DAN TECH HUB', 'DANQEL DIGITAL INSTITUTE')
where name = 'Amoeba Sisters'
  and description like '%WOLI DAN TECH HUB%';

-- Update the known seed-owned CapCut preview lesson without touching student or
-- administrator-authored lessons elsewhere in the catalogue.
update public.lessons l
set description = replace(
      replace(l.description, 'WOLI DAN TECH HUB', 'DANQEL DIGITAL INSTITUTE'),
      'LEARN • BUILD • GROW', 'Technology • Science • Digital Learning'
    ),
    content = replace(l.content, 'LEARN • BUILD • GROW', 'Technology • Science • Digital Learning')
from public.course_modules m
join public.courses c on c.id = m.course_id
where l.module_id = m.id
  and c.slug = 'video-editing-with-capcut'
  and m.order_number = 1
  and l.title = 'Welcome to the course'
  and (coalesce(l.description, '') like '%WOLI DAN TECH HUB%'
       or coalesce(l.description, '') like '%LEARN • BUILD • GROW%'
       or coalesce(l.content, '') like '%LEARN • BUILD • GROW%');
