-- =====================================================================
-- Frontend Supabase schema add-on: catalogue expansion + draft JAMB pass.
-- Apply only after wolidantech/Tech-hub-frontend migration 011.
--
-- This file targets public.categories / public.courses(category text) / public.bundles.
-- It is intentionally NOT in supabase/migrations/, because that folder is the
-- separate legacy-backend chain and must not be pushed wholesale to this project.
-- New courses and the JAMB access bundle remain unpublished until reviewed.
-- =====================================================================

insert into public.categories (name, sort_order) values
  ('Science & Laboratory', 30),
  ('Art & Industrial Design', 40),
  ('Business/Commercial', 50)
on conflict (name) do nothing;

insert into public.courses
  (slug, title, short_description, description, category, duration, level, price, original_price, published, featured)
select t.slug, t.title, t.short_description, t.description, t.category, t.duration,
       t.level, 5000, 10000, false, false
from (values
  ('quality-assurance-laboratories-manufacturing', 'Quality Assurance for Laboratories and Manufacturing',
   'Build practical foundations in quality systems for laboratories and manufacturing.',
   'An applied introduction to quality management systems, controlled documentation, SOPs, audits, validation, non-conformance management and continual improvement in laboratory and manufacturing settings.',
   'Science & Laboratory', '8 weeks', 'Intermediate'),
  ('quality-control-testing-methods', 'Quality Control and Testing Methods',
   'Learn the purpose and workflow of quality control and testing.',
   'Learn the purpose and workflow of quality control: sampling plans, inspection, measurement, control charts, method checks, result review and clear test records.',
   'Science & Laboratory', '8 weeks', 'Intermediate'),
  ('molecular-biology-laboratory-techniques', 'Molecular Biology Laboratory Techniques',
   'Study the principles behind core molecular biology workflows.',
   'A theory-led introduction to molecular biology workflows including nucleic-acid handling, extraction principles, PCR, gel electrophoresis, contamination control, controls and result interpretation. Practical work requires appropriate supervision and facilities.',
   'Science & Laboratory', '12 weeks', 'Intermediate'),
  ('laboratory-analysis-instrumentation', 'Laboratory Analysis and Instrumentation',
   'Build foundations in analytical measurements, instruments and reporting.',
   'Build foundations in sample handling, analytical measurement, calibration, quality checks, instrument selection, data interpretation and laboratory reporting.',
   'Science & Laboratory', '10 weeks', 'Intermediate'),
  ('technical-drawing-cad-industrial-design', 'Technical Drawing and CAD for Industrial Design',
   'Communicate product design intent through technical drawings and CAD.',
   'Learn visual communication for products: orthographic and isometric drawing, dimensioning, tolerances, CAD modelling and communicating design intent.',
   'Art & Industrial Design', '8 weeks', 'Beginner'),
  ('3d-product-modelling-rendering', '3D Product Modelling and Rendering',
   'Develop product concepts into presentation-ready 3D models.',
   'Develop a product concept into a clean 3D model, apply materials and lighting, create useful views and prepare a presentation-ready render using accessible modelling tools.',
   'Art & Industrial Design', '10 weeks', 'Beginner'),
  ('product-prototyping-materials-fabrication', 'Product Prototyping, Materials and Fabrication',
   'Explore materials, low-risk prototypes, testing and iteration.',
   'Explore user needs, concept sketches, material properties, low-risk prototypes, fit and function testing, iteration and safe fabrication planning.',
   'Art & Industrial Design', '8 weeks', 'Intermediate'),
  ('digital-illustration-vector-art', 'Digital Illustration and Vector Art',
   'Create original illustrations and scalable vector artwork.',
   'Create original illustrations and scalable vector artwork using shape, line, colour, composition, typography and export practices for screen and print.',
   'Art & Industrial Design', '8 weeks', 'Beginner'),
  ('business-administration', 'Business Administration',
   'Build practical skills for office administration and business operations.',
   'Build practical skills in office administration, planning, business communication, records, operations, customer service, teamwork and basic performance reporting.',
   'Business/Commercial', '8 weeks', 'Beginner'),
  ('laboratory-safety-biosafety-glp', 'Laboratory Safety, Biosafety and Good Laboratory Practice',
   'Understand hazards, controls and responsible laboratory practice.',
   'Understand hazard identification, risk assessment, PPE, safe handling, waste segregation, incident reporting, biosafety principles and good laboratory practice. This course does not replace site-specific training.',
   'Science & Laboratory', '4 weeks', 'Beginner'),
  ('microbiology-laboratory-techniques', 'Microbiology Laboratory Techniques',
   'Study microbiology workflow concepts and safe laboratory practice.',
   'Study aseptic technique, microbial culture concepts, microscopy, basic identification workflows, contamination prevention, records and safe laboratory practice. Practical work requires qualified supervision.',
   'Science & Laboratory', '10 weeks', 'Intermediate'),
  ('food-safety-quality-management', 'Food Safety and Quality Management',
   'Learn food hygiene, traceability, quality checks and records.',
   'Learn food hygiene, hazard analysis concepts, traceability, sampling, quality checks, corrective actions and practical record keeping across food operations.',
   'Science & Laboratory', '6 weeks', 'Beginner'),
  ('water-environmental-analysis', 'Water and Environmental Analysis',
   'Explore sampling, water-quality indicators and result reporting.',
   'An introduction to environmental sampling, field notes, basic water-quality indicators, analytical methods, uncertainty, result interpretation and reporting.',
   'Science & Laboratory', '8 weeks', 'Intermediate'),
  ('packaging-design-print-production', 'Packaging Design and Print Production',
   'Design packaging from brief and dieline to print-ready artwork.',
   'Design useful packaging from brief to dieline: hierarchy, typography, colour, materials, print-ready artwork, mock-ups and production handoff.',
   'Art & Industrial Design', '6 weeks', 'Beginner'),
  ('fashion-pattern-making-garment-construction', 'Fashion Pattern-Making and Garment Construction',
   'Learn measurement, pattern fundamentals, construction and fit checks.',
   'Learn measurement, pattern fundamentals, fabric selection, garment assembly, finishing, fit checks and communicating a small fashion collection.',
   'Art & Industrial Design', '8 weeks', 'Beginner'),
  ('bookkeeping-computerised-accounting', 'Bookkeeping and Computerised Accounting',
   'Practise records, journals, reconciliation and small-business reporting.',
   'Practise source-document control, journals, ledgers, reconciliation, trial balances and clear small-business reporting using spreadsheet or accounting software.',
   'Business/Commercial', '6 weeks', 'Beginner'),
  ('procurement-supply-chain-fundamentals', 'Procurement and Supply Chain Fundamentals',
   'Learn purchasing workflows, supplier comparison and inventory basics.',
   'Learn purchasing workflows, supplier comparison, inventory basics, procurement records, delivery tracking, ethics and simple supply-chain performance measures.',
   'Business/Commercial', '8 weeks', 'Beginner'),
  ('entrepreneurship-small-business-operations', 'Entrepreneurship and Small-Business Operations',
   'Turn a customer problem into a testable, responsible business idea.',
   'Turn a customer problem into a testable business idea using value propositions, basic costing, cash-flow planning, operations, marketing and responsible growth.',
   'Business/Commercial', '6 weeks', 'Beginner'),
  ('sales-customer-relationship-management', 'Sales and Customer Relationship Management',
   'Build ethical selling, customer service and practical CRM habits.',
   'Develop ethical selling, customer discovery, clear product communication, follow-up, complaint handling and simple CRM record keeping.',
   'Business/Commercial', '6 weeks', 'Beginner')
) as t(slug, title, short_description, description, category, duration, level)
where not exists (select 1 from public.courses existing where existing.slug = t.slug)
on conflict (slug) do nothing;

-- A separate exam-access product, not a course bundle. Keep it hidden until
-- the admin confirms the price and launches the reviewed JAMB question bank.
insert into public.bundles
  (title, description, course_ids, price, original_price, badge, is_published, kind)
select 'JAMB CBT pass',
       'Paid access to reviewed JAMB/UTME subject practice and mock examinations.',
       '{}'::uuid[], 5000, 5000, 'EXAM ACCESS', false, 'exam_access'
where not exists (
  select 1 from public.bundles where kind = 'exam_access' and lower(title) = 'jamb cbt pass'
);
