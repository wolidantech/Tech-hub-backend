import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as catalog from '../controllers/catalog.controller.js';
import { listCoursesQuery, courseParams } from '../validation/schemas.js';

const router = Router();

router.get('/course-categories', catalog.listCategories);

router.get('/courses', validate({ query: listCoursesQuery }), catalog.listCourses);
router.get('/courses/:idOrSlug', optionalAuth, validate({ params: courseParams }), catalog.getCourse);

// Full lesson content — strictly gated by enrollment/role.
router.get('/courses/:idOrSlug/lessons', authenticate, validate({ params: courseParams }), catalog.getCourseLessons);

export default router;
