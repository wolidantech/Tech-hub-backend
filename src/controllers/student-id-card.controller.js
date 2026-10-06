import { asyncHandler } from '../utils/errors.js';
import { generateStudentIdCard, getStudentIdCard } from '../services/student-id-card.service.js';

export const getMyIdCard = asyncHandler(async (req, res) => {
  const card = await getStudentIdCard(req.profile.id);
  res.json({ success: true, data: { id_card: card } });
});

export const regenerateMyIdCard = asyncHandler(async (req, res) => {
  const card = await generateStudentIdCard(req.profile.id);
  res.json({
    success: true,
    message: card.status === 'GENERATED' ? 'Student ID card generated' : 'Add a JPEG or PNG profile photo to generate your ID card',
    data: { id_card: card },
  });
});
