import { isValidEmail, normalizeEmail, SuppressionReason } from '@npm-outreach/shared';
import { OutreachDb } from '../../db/types';
import { AppError } from '../../utils/errors';

export async function suppressEmail(
  db: OutreachDb,
  input: { email: string; reason: SuppressionReason; notes?: string | null },
) {
  const normalized = normalizeEmail(input.email);
  if (!isValidEmail(normalized)) throw new AppError(400, 'INVALID_EMAIL', 'Email address is invalid');
  const existing = await db.suppressions.findByEmail(normalized);
  if (existing) return existing;
  const created = await db.suppressions.create({
    normalizedEmail: normalized,
    reason: input.reason,
    notes: input.notes ?? null,
  });
  const contact = await db.contacts.findByNormalized(normalized);
  if (contact) {
    const status = input.reason === 'UNSUBSCRIBED'
      ? 'UNSUBSCRIBED'
      : input.reason === 'HARD_BOUNCE'
        ? 'BOUNCED'
        : input.reason === 'INVALID'
          ? 'INVALID'
          : input.reason === 'ALREADY_CONTACTED'
            ? 'CONTACTED'
            : 'BLOCKED';
    await db.contacts.update(contact.id, { status });
  }
  await db.audit.create({
    eventType: 'SUPPRESSION_ADDED',
    entityType: 'suppression',
    entityId: created.id,
    metadata: { normalizedEmail: normalized, reason: input.reason },
  });
  return created;
}

export async function removeSuppression(db: OutreachDb, id: string) {
  const existing = await db.suppressions.findById(id);
  if (!existing) throw new AppError(404, 'SUPPRESSION_NOT_FOUND', 'Suppression not found');
  await db.suppressions.delete(id);
  if (existing.reason !== 'ALREADY_CONTACTED') {
    const contact = await db.contacts.findByNormalized(existing.normalizedEmail);
    if (contact && !contact.firstSentAt && contact.sendCount === 0 && contact.status !== 'CONTACTED') {
      await db.contacts.update(contact.id, { status: 'NEW' });
    }
  }
  return existing;
}
