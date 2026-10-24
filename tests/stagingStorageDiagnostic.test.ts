import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
vi.mock("../src/db/pool", () => ({ pool: { query: vi.fn() } }));
import { pool } from "../src/db/pool";
import { stagingStorageDiagnosticRouter, storageIdentityProof } from "../src/routes/stagingStorageDiagnostic";

const site = "b64bf33c-a131-4ae2-b2b0-9aec16e9f77b";
const org = "66c07d0e-887d-4b78-a6bc-181b2a644c34";
const admin = "11111111-1111-4111-8111-111111111111";
const deploy = "aaaaaaaaaaaaaaaaaaaaaaaa";
const runId = "33333333-3333-4333-8333-333333333333";
const nonce = "ab".repeat(32);
const key = "synthetic-access-only";
const clock = Date.parse("2026-10-24T15:00:00Z");
const token = () => jwt.sign({userId:admin,organizationId:org,role:"admin",sessionVersion:0}, process.env.JWT_SECRET!);
function config() { return {
  SITE_ID:site, OI_STORAGE_DIAGNOSTIC_CONTEXT:"production", OI_STORAGE_DIAGNOSTIC_ENABLED:"true",
  OI_STORAGE_DIAGNOSTIC_ADMIN:admin, OI_STORAGE_DIAGNOSTIC_RUN_ID:runId,
  OI_STORAGE_DIAGNOSTIC_NONCE:nonce, OI_STORAGE_DIAGNOSTIC_EXPECTED:storageIdentityProof(key,nonce,runId).toString("hex"),
  OI_STORAGE_DIAGNOSTIC_START:new Date(clock).toISOString(), OI_STORAGE_DIAGNOSTIC_END:new Date(clock+900000).toISOString(),
  S3_ACCESS_KEY_ID:key, S3_SECRET_ACCESS_KEY:"synthetic-secret-only",
  S3_ENDPOINT:"https://boaoedvyvifppuklbwad.storage.supabase.co/storage/v1/s3", S3_REGION:"us-west-1", S3_BUCKET:"oi-video-workflows-media",
}; }
function app(env:NodeJS.ProcessEnv=config(), platform={siteId:site,deployId:deploy,context:"production"}, time=clock) {
  return express().use(express.json()).use("/compare",stagingStorageDiagnosticRouter(platform,env,()=>time));
}
beforeEach(()=>{ vi.mocked(pool.query).mockReset(); vi.mocked(pool.query).mockResolvedValue({rows:[{id:admin,organization_id:org,role:"admin",is_active:true,session_version:0}]} as never); });
describe("staging-only storage comparison",()=>{
  it.each(['OI_STORAGE_DIAGNOSTIC_NONCE','OI_STORAGE_DIAGNOSTIC_EXPECTED','OI_STORAGE_DIAGNOSTIC_RUN_ID','OI_STORAGE_DIAGNOSTIC_ADMIN'])('rejects terminal LF in %s',async(field)=>{const env:NodeJS.ProcessEnv=config();env[field]+='\n';expect((await request(app(env)).post('/compare')).status).toBe(404);});
  it('rejects trusted preview context even when env says production',async()=>{expect((await request(app(config(),{siteId:site,deployId:deploy,context:'deploy-preview'})).post('/compare')).status).toBe(404);});
  it('rechecks expiry after asynchronous authentication',async()=>{
    let time=clock;vi.mocked(pool.query).mockImplementation(async()=>{time=clock+900000;return {rows:[{id:admin,organization_id:org,role:'admin',is_active:true,session_version:0}]} as never;});
    const server=express().use(express.json()).use('/compare',stagingStorageDiagnosticRouter({siteId:site,deployId:deploy,context:'production'},config(),()=>time));
    expect((await request(server).post('/compare').set('Authorization',`Bearer ${token()}`)).status).toBe(404);
  });
  it("returns booleans only with no credentials, fingerprints or signatures",async()=>{
    const info=vi.spyOn(console,"info"); const error=vi.spyOn(console,"error"); const log=vi.spyOn(console,"log");
    const r=await request(app()).post("/compare").set("Authorization",`Bearer ${token()}`).send({});
    expect(r.status).toBe(200); expect(Object.values(r.body)).toEqual(Array(6).fill(true));
    expect(r.headers["cache-control"]).toBe("no-store");
    for(const privateValue of [key,"synthetic-secret-only",nonce,config().OI_STORAGE_DIAGNOSTIC_EXPECTED]) expect(r.text).not.toContain(privateValue);
    expect(info).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
    info.mockRestore(); error.mockRestore(); log.mockRestore();
  });
  it("compares actual environment key without trimming or normalization",async()=>{
    const env=config(); env.S3_ACCESS_KEY_ID=key+" ";
    const r=await request(app(env)).post("/compare").set("Authorization",`Bearer ${token()}`).send({});
    expect(r.body.accessKeyMatches).toBe(false);
  });
  it.each(["SITE_ID","OI_STORAGE_DIAGNOSTIC_CONTEXT","OI_STORAGE_DIAGNOSTIC_ENABLED","OI_STORAGE_DIAGNOSTIC_ADMIN","OI_STORAGE_DIAGNOSTIC_RUN_ID","OI_STORAGE_DIAGNOSTIC_NONCE","OI_STORAGE_DIAGNOSTIC_EXPECTED","OI_STORAGE_DIAGNOSTIC_START","OI_STORAGE_DIAGNOSTIC_END"])("fails closed without %s",async(field)=>{
    const env:NodeJS.ProcessEnv=config(); delete env[field];
    expect((await request(app(env)).post("/compare")).status).toBe(404); expect(pool.query).not.toHaveBeenCalled();
  });
  it.each([{siteId:"wrong",deployId:deploy,context:"production"},{siteId:site,deployId:"wrong",context:"production"}])("rejects platform mismatch %j",async(platform)=>expect((await request(app(config(),platform)).post("/compare")).status).toBe(404));
  it.each([clock-1,clock+900000])("rejects time outside window %s",async(time)=>expect((await request(app(config(),undefined,time)).post("/compare")).status).toBe(404));
  it("rejects a window over 15 minutes",async()=>{const env=config();env.OI_STORAGE_DIAGNOSTIC_END=new Date(clock+900001).toISOString();expect((await request(app(env)).post("/compare")).status).toBe(404);});
  it("requires authenticated current authority",async()=>expect((await request(app()).post("/compare")).status).toBe(401));
  it.each([{role:"viewer"},{organization_id:"22222222-2222-4222-8222-222222222222"},{id:"22222222-2222-4222-8222-222222222222"},{is_active:false},{session_version:1}])("denies changed authority %j",async(change)=>{
    vi.mocked(pool.query).mockResolvedValue({rows:[{id:admin,organization_id:org,role:"admin",is_active:true,session_version:0,...change}]} as never);
    expect((await request(app()).post("/compare").set("Authorization",`Bearer ${token()}`)).status).not.toBe(200);
  });
  it("fails closed on authority database error",async()=>{vi.mocked(pool.query).mockRejectedValue(new Error("synthetic"));expect((await request(app()).post("/compare").set("Authorization",`Bearer ${token()}`)).status).toBe(503);});
  it("rejects caller supplied comparison candidates",async()=>expect((await request(app()).post("/compare").set("Authorization",`Bearer ${token()}`).send({expected:"anything"})).status).toBe(400));
  it("rejects query input and GET",async()=>{expect((await request(app()).post("/compare?key=synthetic").set("Authorization",`Bearer ${token()}`)).status).toBe(400);expect((await request(app()).get("/compare").set("Authorization",`Bearer ${token()}`)).status).toBe(404);});
  it("reports missing or incorrect storage configuration as booleans",async()=>{const env=config();env.S3_ACCESS_KEY_ID="";env.S3_SECRET_ACCESS_KEY="";env.S3_ENDPOINT="wrong";env.S3_REGION="wrong";env.S3_BUCKET="wrong";const r=await request(app(env)).post("/compare").set("Authorization",`Bearer ${token()}`);expect(Object.values(r.body)).toEqual(Array(6).fill(false));});
  it("proof binds exact run and nonce",()=>{expect(storageIdentityProof(key,nonce,runId).equals(storageIdentityProof(key,nonce,"b".repeat(24)))).toBe(false);expect(storageIdentityProof(key,nonce,runId).equals(storageIdentityProof(key,"cd".repeat(32),deploy))).toBe(false);});
});
