import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
// Item 4: the legacy /api/auth/register route is retired (410) outside the offline test fixtures.
const state = vi.hoisted(() => ({ queries: 0 }));
vi.mock('../src/db/pool', () => ({ pool: {
  query: async () => { state.queries++; return { rows: [] }; },
  connect: async () => { throw new Error('no db'); },
} }));
import { authRouter } from '../src/routes/auth';
const app = express(); app.use(express.json()); app.use('/api/auth', authRouter);
const saved = process.env.VITEST;
afterEach(() => { process.env.VITEST = saved; });

describe('legacy register retired', () => {
  it('returns 410 pointing to Add team member when not running under vitest, without touching the database', async () => {
    delete process.env.VITEST; state.queries = 0;
    const res = await request(app).post('/api/auth/register').send({ email: 'x@example.invalid', password: 'x'.repeat(12), full_name: 'X', role: 'admin' });
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'register_retired', message: 'Use Add team member (POST /api/members).' });
    expect(state.queries).toBe(0);
  });
  it('keeps the fixture path for the offline suites only (still requires an admin token)', async () => {
    process.env.VITEST = 'true';
    const res = await request(app).post('/api/auth/register').send({});
    expect(res.status).toBe(401);
  });
  it('the dashboard no longer calls /auth/register anywhere; the Team page uses /members', () => {
    expect(readFileSync('dashboard/src/lib/api.ts', 'utf8')).not.toContain('/auth/register');
    expect(readFileSync('dashboard/src/pages/TeamPage.tsx', 'utf8')).not.toContain('/auth/register');
    expect(readFileSync('dashboard/src/lib/api.ts', 'utf8')).toContain('/members');
  });
});