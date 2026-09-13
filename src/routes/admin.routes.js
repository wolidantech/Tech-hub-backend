import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { thumbnailUpload, resourceUpload } from '../middleware/upload.js';
import * as adminPayments from '../controllers/admin-payments.controller.js';
import * as adminCourses from '../controllers/admin-courses.controller.js';
import * as adminStudents from '../controllers/admin-students.controller.js';
import * as adminDashboard from '../controllers/admin-dashboard.controller.js';
import * as coupons from '../controllers/coupons.controller.js';
import {
  adminPaymentsQuery,
  rejectPaymentSchema,
  createCourseSchema,
  updateCourseSchema,
  createCategorySchema,
  createModuleSchema,
  updateModuleSchema,
  reorderSchema,
  createLessonSchema,
  updateLessonSchema,
  adminStudentsQuery,
  adminUpdateProfileSchema,
  createInstructorSchema,
  setRoleSchema,
  updateSettingSchema,
  updateCertificateSchema,
  uuidParams,
  createCouponSchema,
  updateCouponSchema,
} from '../validation/schemas.js';

const router = Router();

// EVERYTHING under /api/admin requires a verified ADMIN profile.
router.use(authenticate, requireAdmin);

const idOrSlugParams = z.object({ idOrSlug: z.string().trim().min(1).max(200) });
const settingKeyParams = z.object({ key: z.string().trim().min(1).max(80) });

// ---------------- dashboard & statistics ----------------
router.get('/statistics', adminDashboard.getStatistics);
router.get('/audit-logs', adminDashboard.getAuditLogs);
router.get('/diagnostics', adminDashboard.getDiagnostics);

// ---------------- payments review ----------------
router.get('/payments', validate({ query: adminPaymentsQuery }), adminPayments.adminListPayments);
router.get('/payments/:id', validate({ params: uuidParams }), adminPayments.adminGetPayment);
router.get('/payments/:id/receipt', validate({ params: uuidParams }), adminPayments.adminGetReceipt);
router.post('/payments/:id/approve', validate({ params: uuidParams }), adminPayments.approvePayment);
router.post(
  '/payments/:id/reject',
  validate({ params: uuidParams, body: rejectPaymentSchema }),
  adminPayments.rejectPayment
);

// ---------------- coupons ----------------
router.get('/coupons', coupons.adminListCoupons);
router.post('/coupons', validate({ body: createCouponSchema }), coupons.adminCreateCoupon);
router.get('/coupons/:id', validate({ params: uuidParams }), coupons.adminGetCoupon);
router.patch('/coupons/:id', validate({ params: uuidParams, body: updateCouponSchema }), coupons.adminUpdateCoupon);
router.delete('/coupons/:id', validate({ params: uuidParams }), coupons.adminDeleteCoupon);
router.get('/coupon-redemptions', coupons.adminListRedemptions);

// ---------------- courses ----------------
router.get('/courses', adminCourses.adminListCourses);
router.post('/courses', validate({ body: createCourseSchema }), adminCourses.createCourse);
router.get('/courses/:idOrSlug', validate({ params: idOrSlugParams }), adminCourses.adminGetCourse);
router.patch(
  '/courses/:idOrSlug',
  validate({ params: idOrSlugParams, body: updateCourseSchema }),
  adminCourses.updateCourse
);
router.delete('/courses/:idOrSlug', validate({ params: idOrSlugParams }), adminCourses.deleteCourse);
router.post(
  '/courses/:idOrSlug/thumbnail',
  validate({ params: idOrSlugParams }),
  thumbnailUpload.single('file'),
  adminCourses.uploadCourseThumbnail
);

// ---------------- categories ----------------
router.post('/categories', validate({ body: createCategorySchema }), adminCourses.createCategory);
router.patch(
  '/categories/:id',
  validate({ params: uuidParams, body: createCategorySchema.partial() }),
  adminCourses.updateCategory
);
router.delete('/categories/:id', validate({ params: uuidParams }), adminCourses.deleteCategory);

// ---------------- modules ----------------
router.post(
  '/courses/:idOrSlug/modules',
  validate({ params: idOrSlugParams, body: createModuleSchema }),
  adminCourses.createModule
);
router.post(
  '/courses/:idOrSlug/modules/reorder',
  validate({ params: idOrSlugParams, body: reorderSchema }),
  adminCourses.reorderModules
);
router.patch('/modules/:id', validate({ params: uuidParams, body: updateModuleSchema }), adminCourses.updateModule);
router.delete('/modules/:id', validate({ params: uuidParams }), adminCourses.deleteModule);

// ---------------- lessons ----------------
router.post(
  '/modules/:id/lessons',
  validate({ params: uuidParams, body: createLessonSchema }),
  adminCourses.createLesson
);
router.post(
  '/modules/:id/lessons/reorder',
  validate({ params: uuidParams, body: reorderSchema }),
  adminCourses.reorderLessons
);
router.patch('/lessons/:id', validate({ params: uuidParams, body: updateLessonSchema }), adminCourses.updateLesson);
router.delete('/lessons/:id', validate({ params: uuidParams }), adminCourses.deleteLesson);
router.post(
  '/lessons/:id/resource',
  validate({ params: uuidParams }),
  resourceUpload.single('file'),
  adminCourses.uploadLessonResource
);

// ---------------- enrollments ----------------
router.get('/enrollments', adminDashboard.adminListEnrollments);
router.patch('/enrollments/:id', validate({ params: uuidParams }), adminDashboard.adminUpdateEnrollment);

// ---------------- students / instructors / roles ----------------
router.get('/students', validate({ query: adminStudentsQuery }), adminStudents.listStudents);
router.get('/students/:id', validate({ params: uuidParams }), adminStudents.getStudentDetail);
router.patch(
  '/students/:id',
  validate({ params: uuidParams, body: adminUpdateProfileSchema }),
  adminStudents.adminUpdateStudent
);
router.get('/instructors', adminStudents.listInstructors);
router.post('/instructors', validate({ body: createInstructorSchema }), adminStudents.createInstructor);
router.post('/users/:id/role', validate({ params: uuidParams, body: setRoleSchema }), adminStudents.setUserRole);

// ---------------- certificates ----------------
router.get('/certificates', adminDashboard.adminListCertificates);
router.patch(
  '/certificates/:id',
  validate({ params: uuidParams, body: updateCertificateSchema }),
  adminDashboard.adminUpdateCertificate
);

// ---------------- platform settings (bank details, etc.) ----------------
router.get('/settings', adminDashboard.getSettings);
router.put(
  '/settings/:key',
  validate({ params: settingKeyParams, body: updateSettingSchema }),
  adminDashboard.updateSetting
);

export default router;
