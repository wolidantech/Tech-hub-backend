import { ApiError } from '../utils/errors.js';

const PROP = { body: 'validatedBody', query: 'validatedQuery', params: 'validatedParams' };

/**
 * Validates request parts with zod schemas:
 *   validate({ body: schema, query: schema, params: schema })
 * Parsed values are exposed as req.validatedBody / req.validatedQuery /
 * req.validatedParams so handlers never touch untrusted raw input.
 */
export function validate(schemas) {
  return (req, _res, next) => {
    for (const [part, schema] of Object.entries(schemas)) {
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (!result.success) {
        const details = result.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        }));
        return next(
          ApiError.badRequest(
            details[0] ? `${details[0].field ? details[0].field + ': ' : ''}${details[0].message}` : 'Invalid request data',
            'VALIDATION_ERROR',
            details
          )
        );
      }
      req[PROP[part]] = result.data;
    }
    next();
  };
}
