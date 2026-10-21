// Operator opt-in only. This does not activate any backup format or scheduler.
// Keep absent configuration off until combined hosted memory/readback is proved.
export function hostedBackupReadView(value) {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw Error('HOSTED_BACKUP_READ_CONFIG');
}
