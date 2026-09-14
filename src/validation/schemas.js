import { z } from 'zod';

const uuid = z.string().uuid('Invalid identifier');
const trimmed = (min = 1, max = 500) => z.string().trim().min(min, `Must be at least ${min} characters`).max(max);

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long')
  .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

const slugOrId = z.union([uuid, trimmed(1, 200)]);

// ---------------- auth / profile ----------------
export const registerSchema = z.object({
  full_name: trimmed(2, 120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  phone: z
    .string()
    .trim()
    .regex(/^[+\d][\d\s\-()]{6,19}$/, 'Enter a valid phone number')
    .optional()
    .or(z.literal(''))
    .transform((v) => (v ? v : undefined)),
  password,
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
});

export const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'Current password is required'),
  new_password: password,
});

export const updateProfileSchema = z.object({
  full_name: trimmed(2, 120).optional(),
  phone: z
    .string()
    .trim()
    .regex(/^[+\d][\d\s\-()]{6,19}$/, 'Enter a valid phone number')
    .nullish(),
});

// ---------------- courses / catalog ----------------
export const listCoursesQuery = z.object({
  category: z.string().trim().max(200).optional(),
  category_id: uuid.optional(),
  search: z.string().trim().max(200).optional(),
  difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const courseParams = z.object({ idOrSlug: slugOrId });

export const createCourseSchema = z.object({
  title: trimmed(2, 200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug may only contain lowercase letters, numbers and dashes')
    .max(200)
    .optional(),
  category_id: uuid.nullish(),
  description: z.string().trim().max(10000).nullish(),
  price: z.coerce.number().nonnegative('Price cannot be negative').max(100000000).default(5000),
  duration: z.string().trim().max(120).nullish(),
  difficulty_level: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).default('BEGINNER'),
  instructor_id: uuid.nullish(),
  is_published: z.coerce.boolean().default(false),
  thumbnail_url: z.string().trim().url().max(1000).nullish(),
});

export const updateCourseSchema = createCourseSchema.partial();

export const createCategorySchema = z.object({
  name: trimmed(2, 120),
  description: z.string().trim().max(2000).nullish(),
});

// ---------------- modules / lessons ----------------
export const createModuleSchema = z.object({
  title: trimmed(2, 200),
  description: z.string().trim().max(5000).nullish(),
  order_number: z.coerce.number().int().positive().optional(),
});

export const updateModuleSchema = createModuleSchema.partial();

export const reorderSchema = z.object({
  ids: z.array(uuid).min(1, 'Provide the ordered list of ids'),
});

export const createLessonSchema = z.object({
  title: trimmed(2, 200),
  description: z.string().trim().max(5000).nullish(),
  lesson_type: z.enum(['VIDEO', 'TEXT', 'PDF', 'RESOURCE']).default('VIDEO'),
  video_url: z.string().trim().url('Enter a valid video URL').max(1000).nullish(),
  content: z.string().trim().max(100000).nullish(),
  resource_url: z.string().trim().max(1000).nullish(),
  duration: z.coerce.number().int().nonnegative().nullish(),
  order_number: z.coerce.number().int().positive().optional(),
  topic_id: uuid.nullish(),
  is_free_preview: z.coerce.boolean().default(false),
  is_published: z.coerce.boolean().default(false),
});

export const updateLessonSchema = createLessonSchema.partial();

// ---------------- enrollment / payments ----------------
export const enrollSchema = z.object({
  course_id: uuid,
  coupon_code: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[A-Z0-9_-]+$/i, 'Invalid coupon format')
    .optional()
    .transform((v) => (v ? v.toUpperCase() : undefined)),
});

export const submitPaymentSchema = z.object({
  course_id: uuid,
  transaction_reference: z
    .string()
    .trim()
    .min(4, 'Transaction reference is too short')
    .max(120, 'Transaction reference is too long')
    .regex(/^[\w\-\/.#]+$/i, 'Transaction reference contains invalid characters'),
  transaction_date: z.coerce.date().refine((d) => d.getTime() <= Date.now() + 24 * 3600 * 1000, {
    message: 'Transaction date cannot be in the future',
  }),
  // Amount is validated server-side against the actual course price;
  // the client may send it for UX consistency but it is never trusted.
  amount: z.coerce.number().nonnegative().optional(),
  coupon_code: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[A-Z0-9_-]+$/i, 'Invalid coupon format')
    .optional()
    .transform((v) => (v ? v.toUpperCase() : undefined)),
});

export const rejectPaymentSchema = z.object({
  rejection_reason: trimmed(3, 1000),
});

export const adminPaymentsQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  search: z.string().trim().max(200).optional(),
  course_id: uuid.optional(),
  student_id: uuid.optional(),
  payment_method: z.enum(['MANUAL_BANK_TRANSFER', 'FREE']).optional(),
  from_date: z.coerce.date().optional(),
  to_date: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

// ---------------- coupons ----------------
export const couponCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[A-Z0-9_-]+$/i, 'Coupon code must be alphanumeric with dashes/underscores')
    .transform((v) => v.toUpperCase()),
  course_id: uuid,
});

export const createCouponSchema = z.object({
  code: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[A-Z0-9_-]+$/i, 'Coupon code must be alphanumeric')
    .transform((v) => v.toUpperCase()),
  description: z.string().trim().max(500).optional(),
  discount_type: z.enum(['PERCENTAGE', 'FIXED']).default('PERCENTAGE'),
  discount_value: z.coerce.number().positive().max(1000000),
  max_uses: z.coerce.number().int().positive().optional().nullable(),
  min_amount: z.coerce.number().nonnegative().optional(),
  applicable_course_ids: z.array(uuid).optional().nullable(),
  is_active: z.boolean().optional(),
  valid_from: z.coerce.date().optional(),
  valid_until: z.coerce.date().optional(),
});

export const updateCouponSchema = createCouponSchema.partial();


// ---------------- learning ----------------
export const lessonProgressSchema = z.object({
  completed: z.boolean().optional(),
  last_position: z.coerce.number().int().nonnegative().max(60 * 60 * 48).optional(),
});

// ---------------- admin users ----------------
export const adminStudentsQuery = z.object({
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const setRoleSchema = z.object({
  role: z.enum(['student', 'admin', 'instructor']),
});

export const adminUpdateProfileSchema = z.object({
  full_name: trimmed(2, 120).optional(),
  phone: z.string().trim().max(30).nullish(),
  role: z.enum(['student', 'admin', 'instructor']).optional(),
});

export const createInstructorSchema = z.object({
  full_name: trimmed(2, 120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  phone: z.string().trim().max(30).nullish(),
  password,
});

// ---------------- certificates ----------------
export const verifyCertificateParams = z.object({
  identifier: trimmed(6, 200),
});

export const updateCertificateSchema = z.object({
  status: z.enum(['ACTIVE', 'REVOKED']),
});

// ---------------- settings ----------------
export const updateSettingSchema = z.object({
  value: z.union([z.record(z.any()), z.array(z.any()), z.string(), z.number(), z.boolean()]),
  is_public: z.boolean().optional(),
});

export const uuidParams = z.object({ id: uuid });

// ---------------- curriculum engine (topics → lessons → contents → assessments) ----------------
export const createTopicSchema = z.object({
  title: trimmed(2, 200),
  description: z.string().trim().max(5000).nullish(),
  summary: z.string().trim().max(5000).nullish(),
  order_number: z.coerce.number().int().positive().optional(),
  is_published: z.coerce.boolean().default(false),
});

export const updateTopicSchema = createTopicSchema.partial();

export const createLessonContentSchema = z.object({
  block_type: z.enum(['THEORY', 'TEXT', 'EXAMPLE', 'VIDEO', 'PDF', 'IMAGE', 'AUDIO', 'CODE', 'EMBED', 'SUMMARY', 'KEY_CONCEPTS', 'READING', 'DOWNLOAD']).default('THEORY'),
  title: z.string().trim().max(300).nullish(),
  body: z.string().trim().max(100000).nullish(),
  url: z.string().trim().url('Enter a valid URL').max(2000).nullish(),
  storage_path: z.string().trim().max(1000).nullish(),
  duration_seconds: z.coerce.number().int().nonnegative().nullish(),
  order_number: z.coerce.number().int().positive().optional(),
  is_published: z.coerce.boolean().default(false),
});

export const updateLessonContentSchema = createLessonContentSchema.partial();

export const createAssignmentSchema = z.object({
  module_id: uuid.nullish(),
  topic_id: uuid.nullish(),
  lesson_id: uuid.nullish(),
  title: trimmed(2, 300),
  description: trimmed(2, 20000),
  instructions: trimmed(2, 20000),
  requirements: z.string().trim().max(20000).nullish(),
  expected_output: z.string().trim().max(20000).nullish(),
  difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).default('BEGINNER'),
  estimated_time: z.coerce.number().int().positive().nullish(),
  submission_type: z.string().trim().max(120).nullish(),
  evaluation_criteria: z.array(z.any()).nullish(),
  max_score: z.coerce.number().positive().max(1000000).default(100),
  pass_score: z.coerce.number().nonnegative().max(1000000).default(50),
  due_date: z.coerce.date().nullish(),
  status: z.enum(['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED']).default('DRAFT'),
});

export const updateAssignmentSchema = createAssignmentSchema.partial();

export const createSubmissionSchema = z.object({
  submission_text: z.string().trim().min(1).max(50000).optional(),
});

export const gradeSubmissionSchema = z.object({
  score: z.coerce.number().min(0).max(100),
  feedback: z.string().trim().max(20000).nullish(),
  status: z.enum(['GRADED', 'RETURNED', 'UNDER_REVIEW']).default('GRADED'),
});

export const createQuizSchema = z.object({
  module_id: uuid.nullish(),
  topic_id: uuid.nullish(),
  lesson_id: uuid.nullish(),
  assessment_id: uuid.nullish(),
  scope: z.enum(['LESSON', 'TOPIC', 'MODULE', 'FINAL']).default('LESSON'),
  title: trimmed(2, 300),
  description: z.string().trim().max(10000).nullish(),
  passing_score: z.coerce.number().int().min(0).max(100).default(70),
  time_limit: z.coerce.number().int().positive().nullish(),
  order_number: z.coerce.number().int().positive().optional(),
  status: z.enum(['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED']).default('DRAFT'),
});

export const updateQuizSchema = createQuizSchema.partial();

export const createQuestionSchema = z.object({
  question: trimmed(2, 10000),
  question_type: z.enum(['multiple_choice', 'true_false', 'multiple_answer']).default('multiple_choice'),
  options: z.array(z.any()).default([]),
  correct_answer: z.any().nullish(),
  explanation: z.string().trim().max(10000).nullish(),
  difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).default('BEGINNER'),
  topic: z.string().trim().max(300).nullish(),
  order_number: z.coerce.number().int().positive().optional(),
});

export const updateQuestionSchema = createQuestionSchema.partial();

export const createOptionSchema = z.object({
  option_text: trimmed(1, 5000),
  is_correct: z.coerce.boolean().default(false),
  order_number: z.coerce.number().int().positive().optional(),
  explanation: z.string().trim().max(10000).nullish(),
});

export const updateOptionSchema = createOptionSchema.partial();

export const submitQuizAttemptSchema = z.object({
  answers: z.array(z.object({
    question_id: uuid,
    answer: z.any(),
  })).min(1, 'At least one answer is required').max(500),
  started_at: z.coerce.date().optional(),
});

export const createAssessmentSchema = z.object({
  module_id: uuid.nullish(),
  title: trimmed(2, 300),
  description: z.string().trim().max(10000).nullish(),
  instructions: z.string().trim().max(20000).nullish(),
  assessment_type: z.enum(['FINAL_EXAM', 'MODULE_EXAM', 'PLACEMENT', 'PRACTICE']).default('FINAL_EXAM'),
  passing_score: z.coerce.number().int().min(0).max(100).default(70),
  time_limit_minutes: z.coerce.number().int().positive().nullish(),
  max_attempts: z.coerce.number().int().positive().nullish(),
  order_number: z.coerce.number().int().positive().optional(),
  status: z.enum(['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED']).default('DRAFT'),
});

export const updateAssessmentSchema = createAssessmentSchema.partial();

export const publishCourseSchema = z.object({
  publish: z.coerce.boolean().default(true),
  include_quizzes: z.coerce.boolean().default(false),
  include_assignments: z.coerce.boolean().default(false),
  include_assessments: z.coerce.boolean().default(false),
});

export const completionRulesSchema = z.object({
  required_lesson_completion_percentage: z.coerce.number().int().min(0).max(100).default(80),
  minimum_quiz_score: z.coerce.number().int().min(0).max(100).nullish(),
  assignment_required: z.coerce.boolean().default(false),
  final_project_required: z.coerce.boolean().default(false),
  final_assessment_score: z.coerce.number().int().min(0).max(100).nullish(),
});

export const updateCourseMetaSchema = z.object({
  learning_outcomes: z.array(z.string().trim().max(500)).max(50).optional(),
  prerequisites: z.array(z.string().trim().max(500)).max(50).optional(),
  learning_objectives: z.array(z.string().trim().max(500)).max(50).optional(),
});
