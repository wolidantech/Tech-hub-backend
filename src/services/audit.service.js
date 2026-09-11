import { supabaseAdmin } from '../config/supabase.js';

/**
 * Records an administrator action in audit_logs. Audit failures are
 * logged but never break the primary operation.
 */
export async function logAudit({ adminId, action, targetType = null, targetId = null, description = null }) {
  try {
    const { error } = await supabaseAdmin.from('audit_logs').insert({
      admin_id: adminId,
      action,
      target_type: targetType,
      target_id: targetId,
      description,
    });
    if (error) console.error('[audit] insert failed', error.message);
  } catch (err) {
    console.error('[audit] unexpected failure', err?.message);
  }
}
