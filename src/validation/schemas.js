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
  is_published: z.coerce.boolean().default(false),
});

export const updateLessonSchema = createLessonSchema.partial();

// ---------------- enrollment / payments ----------------
export const enrollSchema = z.object({
  course_id: uuid,
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
});

export const rejectPaymentSchema = z.object({
  rejection_reason: trimmed(3, 1000),
});

export const adminPaymentsQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  search: z.string().trim().max(200).optional(),
  course_id: uuid.optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

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
