import { randomBytes, randomUUID } from 'node:crypto';
import { pool } from '../db/pool';
import { openingsForOrgSubquery, photoVisibleSql } from '../db/tenantScope';
import { areaAllowsOpening } from '../db/areaAccess';
import { getObjectBytes } from './storage';
import { MAX_ORIGINAL_READ_BYTES } from './recognitionDownscale';
import type { ConfirmationPlan, DoorHardwareStore, HardwareItem, StoredItem, StoredRun } from './doorHardwareRecognition';

const RUN_SQL = `SELECT r.id, r.organization_id, r.property_id, r.opening_id, r.requested_by_user_id, r.client_request_id,
  r.status, r.failure_code, r.photo_count,
  COALESCE((SELECT json_agg(json_build_object(
      'id', i.id, 'ordinal', i.ordinal, 'hardware_type', i.hardware_type, 'component_type', i.component_type,
      'subtype', i.subtype, 'manufacturer', i.manufacturer, 'exact_model', i.exact_model, 'finish', i.finish,
      'supporting_photos', i.supporting_photos, 'visible_evidence', i.visible_evidence, 'confidence', i.confidence,
      'next_photo', i.next_photo, 'model_unknown', i.model_unknown, 'review_state', i.review_state,
      'hardware_component_id', i.hardware_component_id
    ) ORDER BY i.ordinal) FROM hardware_recognition_items i WHERE i.run_id = r.id), '[]'::json) AS items,
  COALESCE((SELECT json_agg(json_build_object('photo_id', p.photo_id, 'ordinal', p.ordinal) ORDER BY p.ordinal)
    FROM hardware_recognition_run_photos p WHERE p.run_id = r.id), '[]'::json) AS photos
  FROM hardware_recognition_runs r`;

function asRun(row: any): StoredRun {
  const items = (typeof row.items === 'string' ? JSON.parse(row.items) : row.items) as StoredItem[];
  const photos = (typeof row.photos === 'string' ? JSON.parse(row.photos) : row.photos) as StoredRun['photos'];
  return {
    id: row.id,
    organization_id: row.organization_id,
    property_id: row.property_id,
    opening_id: row.opening_id,
    requested_by_user_id: row.requested_by_user_id,
    client_request_id: row.client_request_id,
    status: row.status,
    failure_code: row.failure_code,
    photo_count: Number(row.photo_count),
    items: (items ?? []).map((item) => ({ ...item, supporting_photos: item.supporting_photos ?? [], model_unknown: item.model_unknown === true })),
    photos: photos ?? [],
  };
}

function trackerId(): string {
  return `TRK-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export function createDoorHardwareStore(): DoorHardwareStore {
  return {
    async findOpening(orgId, openingId) {
      const row = (await pool.query(
        `SELECT o.id, b.property_id FROM openings o JOIN buildings b ON b.id = o.building_id
         WHERE o.id = $1 AND o.id IN (${openingsForOrgSubquery(2)})`,
        [openingId, orgId],
      )).rows[0];
      return row ?? null;
    },
    areaAllows(userId, openingId) {
      return areaAllowsOpening(userId, openingId);
    },
    async findRunByRequest(userId, clientRequestId) {
      const row = (await pool.query(
        `SELECT id, organization_id, opening_id FROM hardware_recognition_runs
         WHERE requested_by_user_id = $1 AND client_request_id = $2`,
        [userId, clientRequestId],
      )).rows[0];
      return row ?? null;
    },
    async findRun(orgId, runId) {
      const row = (await pool.query(
        `${RUN_SQL} WHERE r.id = $1 AND r.organization_id = $2 AND r.opening_id IN (${openingsForOrgSubquery(2)})`,
        [runId, orgId],
      )).rows[0];
      return row ? asRun(row) : null;
    },
    async loadPhotos(orgId, openingId, photoIds) {
      const rows = (await pool.query(
        `SELECT p.id, p.sha256_checksum, p.storage_object_key, p.content_type
         FROM photos p
         WHERE p.id = ANY($1::uuid[]) AND p.opening_id = $3 AND p.media_type = 'photo'
           AND p.upload_state IN ('verified', 'legacy_confirmed')
           AND p.sha256_checksum IS NOT NULL AND p.storage_object_key IS NOT NULL
           AND ${photoVisibleSql('p', 2)}`,
        [photoIds, orgId, openingId],
      )).rows;
      return rows;
    },
    readBytes(key) {
      return getObjectBytes(key, MAX_ORIGINAL_READ_BYTES);
    },
    async orgDailyLimit(orgId) {
      const row = (await pool.query(
        'SELECT daily_run_limit FROM hardware_recognition_settings WHERE organization_id = $1',
        [orgId],
      )).rows[0];
      // No settings row, or a null limit, means the company is not capped.
      if (!row || row.daily_run_limit == null) return null;
      return Number(row.daily_run_limit);
    },
    async consumeDailyRun(orgId, userId, techLimit, companyLimit) {
      const client = await pool.connect();
      const techSql = `WITH attempt AS (
           INSERT INTO hardware_recognition_tech_daily_usage (organization_id, user_id, run_day, run_count)
           SELECT $1, $2, (timezone('utc', now()))::date, 1
           WHERE $3::int >= 1
           ON CONFLICT (organization_id, user_id, run_day)
           DO UPDATE SET run_count = hardware_recognition_tech_daily_usage.run_count + 1
           WHERE hardware_recognition_tech_daily_usage.run_count < $3::int
           RETURNING run_count
         ) SELECT run_count FROM attempt`;
      const companySql = `WITH attempt AS (
           INSERT INTO hardware_recognition_daily_usage (organization_id, run_day, run_count)
           SELECT $1, (timezone('utc', now()))::date, 1
           WHERE $2::int >= 1
           ON CONFLICT (organization_id, run_day)
           DO UPDATE SET run_count = hardware_recognition_daily_usage.run_count + 1
           WHERE hardware_recognition_daily_usage.run_count < $2::int
           RETURNING run_count
         ) SELECT run_count FROM attempt`;
      try {
        await client.query('BEGIN');
        const tech = (await client.query(techSql, [orgId, userId, techLimit])).rows[0];
        if (!tech) { await client.query('ROLLBACK'); return false; }
        if (companyLimit != null) {
          const company = (await client.query(companySql, [orgId, companyLimit])).rows[0];
          if (!company) { await client.query('ROLLBACK'); return false; }
        }
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async insertRun(row) {
      const inserted = (await pool.query(
        `INSERT INTO hardware_recognition_runs
           (organization_id, property_id, opening_id, requested_by_user_id, client_request_id, status, photo_count)
         VALUES ($1,$2,$3,$4,$5,'running',$6)
         ON CONFLICT (requested_by_user_id, client_request_id) DO NOTHING
         RETURNING id`,
        [row.organizationId, row.propertyId, row.openingId, row.userId, row.clientRequestId, row.photoCount],
      )).rows[0];
      if (inserted) return { id: inserted.id, created: true };
      const existing = (await pool.query(
        'SELECT id FROM hardware_recognition_runs WHERE requested_by_user_id = $1 AND client_request_id = $2',
        [row.userId, row.clientRequestId],
      )).rows[0];
      return { id: existing.id, created: false };
    },
    async attachPhotos(runId, photos) {
      for (const photo of photos) {
        await pool.query(
          `INSERT INTO hardware_recognition_run_photos (run_id, photo_id, ordinal, sha256_checksum, sent_byte_size)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (run_id, ordinal) DO NOTHING`,
          [runId, photo.photoId, photo.ordinal, photo.sha256, photo.sentBytes],
        );
      }
    },
    async finishRun(runId, patch) {
      await pool.query(
        `UPDATE hardware_recognition_runs
         SET status = $2, failure_code = $3, result = $4::jsonb, provider_called = $5, finished_at = now()
         WHERE id = $1 AND status = 'running'`,
        [runId, patch.status, patch.failure_code ?? null, patch.result === undefined ? null : JSON.stringify(patch.result), patch.provider_called],
      );
    },
    async insertItems(runId, items: HardwareItem[]) {
      for (const [index, item] of items.entries()) {
        await pool.query(
          `INSERT INTO hardware_recognition_items
             (run_id, ordinal, hardware_type, component_type, subtype, manufacturer, exact_model, finish,
              supporting_photos, visible_evidence, confidence, next_photo, model_unknown)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::smallint[],$10,$11,$12,$13)`,
          [runId, index + 1, item.hardware_type, item.component_type, item.subtype, item.manufacturer, item.exact_model,
            item.finish, item.supporting_photos, item.visible_evidence, item.confidence, item.next_photo, item.model_unknown],
        );
      }
    },
    async confirm(actor, runId, plan: ConfirmationPlan) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = (await client.query(
          `SELECT id, status, opening_id, organization_id FROM hardware_recognition_runs
           WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          [runId, actor.organizationId],
        )).rows[0];
        if (!locked) { await client.query('ROLLBACK'); return { already: true, hardware: [], training_labels: 0 }; }
        if (locked.status === 'confirmed') { await client.query('ROLLBACK'); return { already: true, hardware: [], training_labels: 0 }; }
        if (locked.status !== 'pending_review') { await client.query('ROLLBACK'); throw Object.assign(new Error('run_not_awaiting_review'), { code: 'RUN_STATE' }); }
        const componentByItem = new Map<string, string>();
        const hardware: { id: string; tracker_id: string; component_type: string }[] = [];
        for (const part of plan.hardware) {
          let saved: any = null;
          for (let attempt = 0; attempt < 3 && !saved; attempt++) {
            try {
              saved = (await client.query(
                `INSERT INTO hardware_components
                   (id, opening_id, component_type, manufacturer, model_number, finish, notes, tracker_id,
                    shipment_status, mounting_scope, condition, identity_status, review_state, replacement_required)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'not_shipped','opening','unverified',$9,'reviewed',false)
                 RETURNING id, tracker_id, component_type`,
                [randomUUID(), locked.opening_id, part.component_type, part.manufacturer, part.model_number, part.finish,
                  part.notes, trackerId(), part.identity_status],
              )).rows[0];
            } catch (error: any) {
              if (error?.code !== '23505') throw error;
            }
          }
          if (!saved) throw new Error('tracker_id_exhausted');
          componentByItem.set(part.itemId, saved.id);
          hardware.push(saved);
        }
        for (const label of plan.labels) {
          const componentId = componentByItem.get(label.itemId) ?? null;
          await client.query(
            `INSERT INTO hardware_training_labels
               (organization_id, opening_id, run_id, item_id, photo_id, photo_ordinal, hardware_component_id,
                component_type, subtype, manufacturer, model_number, finish, confidence, visible_evidence,
                confirmed_by_user_id, label)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
            [actor.organizationId, locked.opening_id, runId, label.itemId, label.photoId, label.photoOrdinal, componentId,
              label.component_type, label.subtype, label.manufacturer, label.model_number, label.finish, label.confidence,
              label.visible_evidence, actor.userId, JSON.stringify(label.label)],
          );
        }
        for (const update of plan.itemUpdates) {
          await client.query(
            `UPDATE hardware_recognition_items
             SET review_state = $3, hardware_component_id = $4, component_type = $5, subtype = $6,
                 manufacturer = $7, exact_model = $8, finish = $9
             WHERE id = $1 AND run_id = $2`,
            [update.itemId, runId, update.review_state, componentByItem.get(update.itemId) ?? null, update.component_type,
              update.subtype, update.manufacturer, update.model_number, update.finish],
          );
        }
        for (const link of plan.singlePhotoLinks) {
          const componentId = componentByItem.get(link.itemId);
          if (!componentId) continue;
          await client.query(
            `UPDATE photos SET related_entity_type = 'hardware_component', related_entity_id = $2, hardware_component_id = $2
             WHERE id = $1 AND opening_id = $3`,
            [link.photoId, componentId, locked.opening_id],
          );
        }
        await client.query(
          `UPDATE hardware_recognition_runs
           SET status = 'confirmed', confirmed_at = now(), confirmed_by_user_id = $2
           WHERE id = $1 AND status = 'pending_review'`,
          [runId, actor.userId],
        );
        await client.query('COMMIT');
        return { already: false, hardware, training_labels: plan.labels.length };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
