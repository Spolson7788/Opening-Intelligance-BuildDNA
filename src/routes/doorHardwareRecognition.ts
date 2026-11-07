import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, AuthedRequest, isMissingSchema } from '../middleware/auth';
import { enforceRolePermissions } from '../middleware/permissions';
import { auditLog } from '../middleware/auditLog';
import { executeConfirm, executeIdentify, publicRun, validateIdentifyRequest } from '../services/doorHardwareRecognition';
import { createDoorHardwareStore } from '../services/doorHardwareRecognitionStore';

const confirmSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    include: z.boolean(),
    component_type: z.string().min(1).max(80),
    subtype: z.string().max(200).nullable().optional(),
    manufacturer: z.string().max(200).nullable().optional(),
    model_number: z.string().max(200).nullable().optional(),
    finish: z.string().max(80).nullable().optional(),
  }).strict()).min(1).max(30),
}).strict();

function unavailable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return isMissingSchema(error) || code === '42703';
}

export const doorHardwareRecognitionRouter = Router();
doorHardwareRecognitionRouter.use(requireAuth, enforceRolePermissions, auditLog);
doorHardwareRecognitionRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

doorHardwareRecognitionRouter.post('/runs', async (req: AuthedRequest, res) => {
  const parsed = validateIdentifyRequest(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    const outcome = await executeIdentify(
      { organizationId: req.auth!.organizationId, userId: req.auth!.userId },
      { openingId: parsed.openingId, photoIds: parsed.photoIds, clientRequestId: parsed.clientRequestId },
      { store: createDoorHardwareStore() },
    );
    return res.status(outcome.httpStatus).json(outcome.body);
  } catch (error) {
    if (!unavailable(error)) console.error('door_hardware_recognition_failed', (error as { code?: string })?.code ?? 'unknown');
    return res.status(503).json({ error: 'hardware_recognition_unavailable' });
  }
});

doorHardwareRecognitionRouter.post('/runs/:id/confirm', async (req: AuthedRequest, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: 'not_found' });
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_confirmation' });
  try {
    const outcome = await executeConfirm(
      { organizationId: req.auth!.organizationId, userId: req.auth!.userId },
      req.params.id,
      parsed.data.items.map((item) => ({
        id: item.id,
        include: item.include,
        component_type: item.component_type,
        subtype: item.subtype ?? null,
        manufacturer: item.manufacturer ?? null,
        model_number: item.model_number ?? null,
        finish: item.finish ?? null,
      })),
      createDoorHardwareStore(),
    );
    return res.status(outcome.httpStatus).json(outcome.body);
  } catch (error) {
    if (!unavailable(error)) console.error('door_hardware_recognition_confirm_failed', (error as { code?: string })?.code ?? 'unknown');
    return res.status(503).json({ error: 'hardware_recognition_unavailable' });
  }
});

doorHardwareRecognitionRouter.get('/runs/:id', async (req: AuthedRequest, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: 'not_found' });
  try {
    const store = createDoorHardwareStore();
    const run = await store.findRun(req.auth!.organizationId, req.params.id);
    if (!run) return res.status(404).json({ error: 'not_found' });
    if (!(await store.areaAllows(req.auth!.userId, run.opening_id))) return res.status(403).json({ error: 'forbidden' });
    return res.json({ run: publicRun(run) });
  } catch (error) {
    if (!unavailable(error)) console.error('door_hardware_recognition_read_failed', (error as { code?: string })?.code ?? 'unknown');
    return res.status(503).json({ error: 'hardware_recognition_unavailable' });
  }
});
