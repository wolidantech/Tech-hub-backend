-- =====================================================================
-- WOLI DAN TECH HUB
-- Migration 006: Fix empty catalog — ensure seed data is published
--
-- This migration is idempotent and safe to run on a live project
-- where seed_12_courses.sql was run as drafts but publish step was
-- missed. It also backfills platform_settings and categories if they
-- were somehow missing.
--
-- Fixes the [FAIL] Course catalog diagnostic that students were seeing:
-- "The courses table is EMPTY, or every row is hidden from this key.
-- Row-level security only exposes courses where published = true,
-- so a visitor sees nothing."
-- =====================================================================

-- Ensure platform settings exist
insert into public.platform_settings (key, value, is_public)
values (
  'bank_details',
  '{"bank_name": "MONIEPOINT", "account_number": "69852663361", "account_name": "LUNA ENTRY SERVICES- WOLI DAN TECH HUB"}'::jsonb,
  true
)
on conflict (key) do nothing;

insert into public.platform_settings (key, value, is_public)
values (
  'platform',
  '{"name": "WOLI DAN TECH HUB", "tagline": "LEARN • BUILD • GROW", "support_email": "wolidantech@gmail.com", "currency": "NGN"}'::jsonb,
  true
)
on conflict (key) do nothing;

-- Ensure categories exist
insert into public.course_categories (name, description) values
  ('AI & Technology',    'Artificial intelligence, automation and emerging technology skills'),
  ('Design',             'Graphic design, UI/UX and visual communication'),
  ('Video & Media',      'Video production, editing and media content creation'),
  ('Marketing',          'Digital marketing, growth and brand strategy'),
  ('Web Development',    'Frontend, backend and full-stack web development'),
  ('Mobile Development', 'Android and cross-platform mobile application development'),
  ('Microsoft Office',   'Word, Excel, PowerPoint and workplace productivity')
on conflict (name) do nothing;

-- If courses table is empty, seed it as PUBLISHED (not drafts) — this migration
-- is the "auto-fix" version, unlike seed_12_courses.sql which deliberately uses drafts.
insert into public.courses (category_id, title, slug, description, price, duration, difficulty_level, is_published)
select c.id, t.title, t.slug, t.description, 5000.00, t.duration, t.difficulty::public.difficulty_level, true
from (
  values
    ('ai-video-content-creation',  'AI Video Content Creation',        'AI & Technology',
     'Learn how to plan, script and produce professional videos using modern AI tools — from idea to final render without expensive equipment.', '4 weeks', 'BEGINNER'),
    ('video-editing-with-capcut',  'Video Editing with CapCut',        'Video & Media',
     'Master CapCut from the basics to advanced editing: cuts, transitions, effects, audio, colour and a complete final project.', '6 weeks', 'BEGINNER'),
    ('graphic-design-with-canva',  'Graphic Design with Canva',        'Design',
     'Design stunning flyers, social media creatives, logos and brand assets with Canva — no prior design experience required.', '4 weeks', 'BEGINNER'),
    ('digital-marketing',          'Digital Marketing',                'Marketing',
     'Grow any business online with social media marketing, content strategy, ads, funnels and analytics.', '6 weeks', 'BEGINNER'),
    ('mobile-application-development', 'Mobile Application Development', 'Mobile Development',
     'Build real mobile applications from scratch — UI design, logic, data and publishing to app stores.', '10 weeks', 'INTERMEDIATE'),
    ('portfolio-creation',         'Portfolio Creation',               'Design',
     'Create a professional portfolio that showcases your skills and wins clients and jobs.', '2 weeks', 'BEGINNER'),
    ('frontend-web-development',   'Frontend Web Development',         'Web Development',
     'HTML, CSS, JavaScript and modern frameworks — build responsive, interactive websites and web apps.', '12 weeks', 'INTERMEDIATE'),
    ('web-design-with-wordpress',  'Web Design with WordPress',        'Web Development',
     'Design and launch professional business websites, blogs and online stores with WordPress — no coding needed.', '5 weeks', 'BEGINNER'),
    ('ui-ux-design-with-figma',    'UI/UX Design with Figma',          'Design',
     'Design beautiful, usable interfaces — wireframes, prototypes, design systems and developer handoff with Figma.', '8 weeks', 'INTERMEDIATE'),
    ('microsoft-excel',            'Microsoft Excel',                  'Microsoft Office',
     'From spreadsheets to data analysis: formulas, functions, charts, pivot tables and business reporting in Excel.', '4 weeks', 'BEGINNER'),
    ('microsoft-word',             'Microsoft Word',                   'Microsoft Office',
     'Create professional documents — formatting, styles, tables, mail merge and templates in Microsoft Word.', '3 weeks', 'BEGINNER'),
    ('microsoft-powerpoint',       'Microsoft PowerPoint',             'Microsoft Office',
     'Design persuasive presentations with layouts, animations, media and delivery best practices.', '3 weeks', 'BEGINNER')
) as t(slug, title, category_name, description, duration, difficulty)
join public.course_categories c on c.name = t.category_name
on conflict (slug) do nothing;

-- CRITICAL FIX: If courses exist but are all drafts (is_published=false),
-- publish them so anon key can see them. This is what was causing
-- [FAIL] Course catalog for students.
update public.courses
set is_published = true,
    updated_at = now()
where is_published = false;

-- Ensure at least the CapCut example curriculum exists (idempotent)
insert into public.course_modules (course_id, title, description, order_number)
select c.id, m.title, m.description, m.order_number
from public.courses c
join (
  values
    (1, 'Introduction to Video Editing', 'What video editing is, storytelling fundamentals and what you will build in this course.'),
    (2, 'CapCut Interface',              'A complete tour of the CapCut workspace: timeline, preview, media bin and tools.'),
    (3, 'Basic Editing',                 'Importing media, trimming, splitting, cutting and arranging clips on the timeline.'),
    (4, 'Transitions and Effects',       'Applying smooth transitions, visual effects, filters, text and stickers.'),
    (5, 'Audio and Voiceovers',          'Working with music, sound effects, voiceover recording and audio mixing.'),
    (6, 'Advanced Editing',              'Keyframes, masking, chroma key (green screen), speed ramping and colour grading.'),
    (7, 'Final Project',                 'Plan, edit and export a complete professional video from start to finish.')
) as m(order_number, title, description) on c.slug = 'video-editing-with-capcut'
on conflict do nothing;

insert into public.lessons (module_id, title, description, lesson_type, content, duration, order_number, is_published)
select m.id,
       'Welcome to the course',
       'Course overview, what you will learn, and how to get the most out of WOLI DAN TECH HUB.',
       'TEXT',
       'Welcome to Video Editing with CapCut! In this course you will move from complete beginner to confidently editing professional videos. Download CapCut (mobile or desktop) and get ready to LEARN • BUILD • GROW.',
       5,
       1,
       true
from public.course_modules m
join public.courses c on c.id = m.course_id
where c.slug = 'video-editing-with-capcut' and m.order_number = 1
on conflict do nothing;
