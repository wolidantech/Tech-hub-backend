-- =====================================================================
-- WOLI DAN TECH HUB — Draft catalogue expansion
-- Migration 016: Add new catalogue categories and draft course products.
--
-- All new courses deliberately remain unpublished (is_published=false).
-- They must not be sold until their reviewed curriculum and real media are
-- ready. Prices use the site's existing NGN 5,000 catalogue baseline and
-- can be changed by an admin before publication.
-- =====================================================================

insert into public.course_categories (name, description) values
  ('Science & Laboratory', 'Laboratory science, analysis, biosafety and quality systems'),
  ('Art & Industrial Design', 'Fine art, product design, CAD, prototyping and visual communication'),
  ('Business & Commercial Skills', 'Business administration, accounting, operations and commercial skills'),
  ('JAMB CBT & Exam Preparation', 'Paid JAMB/UTME practice and mock examination access')
on conflict (name) do nothing;

insert into public.courses
  (category_id, title, slug, description, price, duration, difficulty_level, is_published)
select c.id, t.title, t.slug, t.description, 5000.00,
       t.duration, t.difficulty::public.difficulty_level, false
from (
  values
    ('science-laboratory', 'Quality Assurance for Laboratories and Manufacturing',
     'quality-assurance-laboratories-manufacturing',
     'An applied introduction to quality management systems, controlled documentation, SOPs, audits, validation, non-conformance management and continual improvement in laboratory and manufacturing settings.',
     '8 weeks', 'INTERMEDIATE', 'Science & Laboratory'),
    ('science-laboratory', 'Quality Control and Testing Methods',
     'quality-control-testing-methods',
     'Learn the purpose and workflow of quality control: sampling plans, inspection, measurement, control charts, method checks, result review and clear test records.',
     '8 weeks', 'INTERMEDIATE', 'Science & Laboratory'),
    ('science-laboratory', 'Molecular Biology Laboratory Techniques',
     'molecular-biology-laboratory-techniques',
     'A theory-led introduction to molecular biology workflows including nucleic-acid handling, extraction principles, PCR, gel electrophoresis, contamination control, controls and result interpretation. Practical work requires appropriate supervision and facilities.',
     '12 weeks', 'INTERMEDIATE', 'Science & Laboratory'),
    ('science-laboratory', 'Laboratory Analysis and Instrumentation',
     'laboratory-analysis-instrumentation',
     'Build foundations in sample handling, analytical measurement, calibration, quality checks, instrument selection, data interpretation and laboratory reporting.',
     '10 weeks', 'INTERMEDIATE', 'Science & Laboratory'),
    ('art-industrial-design', 'Technical Drawing and CAD for Industrial Design',
     'technical-drawing-cad-industrial-design',
     'Learn visual communication for products: orthographic and isometric drawing, dimensioning, tolerances, CAD modelling and communicating design intent.',
     '8 weeks', 'BEGINNER', 'Art & Industrial Design'),
    ('art-industrial-design', '3D Product Modelling and Rendering',
     '3d-product-modelling-rendering',
     'Develop a product concept into a clean 3D model, apply materials and lighting, create useful views and prepare a presentation-ready render using accessible modelling tools.',
     '10 weeks', 'BEGINNER', 'Art & Industrial Design'),
    ('art-industrial-design', 'Product Prototyping, Materials and Fabrication',
     'product-prototyping-materials-fabrication',
     'Explore user needs, concept sketches, material properties, low-risk prototypes, fit and function testing, iteration and safe fabrication planning.',
     '8 weeks', 'INTERMEDIATE', 'Art & Industrial Design'),
    ('art-industrial-design', 'Digital Illustration and Vector Art',
     'digital-illustration-vector-art',
     'Create original illustrations and scalable vector artwork using shape, line, colour, composition, typography and export practices for screen and print.',
     '8 weeks', 'BEGINNER', 'Art & Industrial Design'),
    ('business-commercial', 'Business Administration',
     'business-administration',
     'Build practical skills in office administration, planning, business communication, records, operations, customer service, teamwork and basic performance reporting.',
     '8 weeks', 'BEGINNER', 'Business & Commercial Skills'),
    ('science-laboratory', 'Laboratory Safety, Biosafety and Good Laboratory Practice',
     'laboratory-safety-biosafety-glp',
     'Understand hazard identification, risk assessment, PPE, safe handling, waste segregation, incident reporting, biosafety principles and good laboratory practice. This course does not replace site-specific training.',
     '4 weeks', 'BEGINNER', 'Science & Laboratory'),
    ('science-laboratory', 'Microbiology Laboratory Techniques',
     'microbiology-laboratory-techniques',
     'Study aseptic technique, microbial culture concepts, microscopy, basic identification workflows, contamination prevention, records and safe laboratory practice. Practical work requires qualified supervision.',
     '10 weeks', 'INTERMEDIATE', 'Science & Laboratory'),
    ('science-laboratory', 'Food Safety and Quality Management',
     'food-safety-quality-management',
     'Learn food hygiene, hazard analysis concepts, traceability, sampling, quality checks, corrective actions and practical record keeping across food operations.',
     '6 weeks', 'BEGINNER', 'Science & Laboratory'),
    ('science-laboratory', 'Water and Environmental Analysis',
     'water-environmental-analysis',
     'An introduction to environmental sampling, field notes, basic water-quality indicators, analytical methods, uncertainty, result interpretation and reporting.',
     '8 weeks', 'INTERMEDIATE', 'Science & Laboratory'),
    ('art-industrial-design', 'Packaging Design and Print Production',
     'packaging-design-print-production',
     'Design useful packaging from brief to dieline: hierarchy, typography, colour, materials, print-ready artwork, mock-ups and production handoff.',
     '6 weeks', 'BEGINNER', 'Art & Industrial Design'),
    ('art-industrial-design', 'Fashion Pattern-Making and Garment Construction',
     'fashion-pattern-making-garment-construction',
     'Learn measurement, pattern fundamentals, fabric selection, garment assembly, finishing, fit checks and communicating a small fashion collection.',
     '8 weeks', 'BEGINNER', 'Art & Industrial Design'),
    ('business-commercial', 'Bookkeeping and Computerised Accounting',
     'bookkeeping-computerised-accounting',
     'Practise source-document control, journals, ledgers, reconciliation, trial balances and clear small-business reporting using spreadsheet or accounting software.',
     '6 weeks', 'BEGINNER', 'Business & Commercial Skills'),
    ('business-commercial', 'Procurement and Supply Chain Fundamentals',
     'procurement-supply-chain-fundamentals',
     'Learn purchasing workflows, supplier comparison, inventory basics, procurement records, delivery tracking, ethics and simple supply-chain performance measures.',
     '8 weeks', 'BEGINNER', 'Business & Commercial Skills'),
    ('business-commercial', 'Entrepreneurship and Small-Business Operations',
     'entrepreneurship-small-business-operations',
     'Turn a customer problem into a testable business idea using value propositions, basic costing, cash-flow planning, operations, marketing and responsible growth.',
     '6 weeks', 'BEGINNER', 'Business & Commercial Skills'),
    ('business-commercial', 'Sales and Customer Relationship Management',
     'sales-customer-relationship-management',
     'Develop ethical selling, customer discovery, clear product communication, follow-up, complaint handling and simple CRM record keeping.',
     '6 weeks', 'BEGINNER', 'Business & Commercial Skills'),
    ('jamb-preparation', 'JAMB CBT Practice and Mock Examination Access',
     'jamb-cbt-practice-mock-exams',
     'A paid digital access pass for subject-based UTME practice and full mock examinations. Access must remain unpublished until the question bank has been reviewed, licensed or written originally, and a complete mock is available.',
     'Digital access', 'BEGINNER', 'JAMB CBT & Exam Preparation')
) as t(category_key, title, slug, description, duration, difficulty, category_name)
join public.course_categories c on c.name = t.category_name
on conflict (slug) do nothing;

comment on table public.course_categories is 'Public catalogue groupings; new expansion categories are seeded in migration 016.';
comment on column public.courses.is_published is 'The expansion course shells are seeded as drafts and must not be published without reviewed curriculum and verified media.';
