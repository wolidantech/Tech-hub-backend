import { supabaseAdmin } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { parsePagination } from '../utils/helpers.js';

/** GET /api/notifications — own notifications, newest first */
export const getNotifications = asyncHandler(async (req, res) => {
  const { from, to, page, limit } = parsePagination(req.query);

  const { data, error, count } = await req.supabase
    .from('notifications')
    .select('id, title, message, type, is_read, created_at', { count: 'exact' })
    .eq('user_id', req.profile.id)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw ApiError.internal('Unable to load notifications');

  const { count: unread } = await supabaseAdmin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', req.profile.id)
    .eq('is_read', false);

  res.json({
    success: true,
    data: {
      notifications: data,
      unread_count: unread || 0,
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

/** POST /api/notifications/:id/read */
export const markNotificationRead = asyncHandler(async (req, res) => {
  const { error } = await req.supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', req.validatedParams.id)
    .eq('user_id', req.profile.id);

  if (error) throw ApiError.internal('Unable to update notification');
  res.json({ success: true, message: 'Notification marked as read' });
});

/** POST /api/notifications/read-all */
export const markAllNotificationsRead = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', req.profile.id)
    .eq('is_read', false);

  if (error) throw ApiError.internal('Unable to update notifications');
  res.json({ success: true, message: 'All notifications marked as read' });
});
