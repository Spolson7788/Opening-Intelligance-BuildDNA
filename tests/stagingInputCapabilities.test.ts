import {it,expect} from 'vitest';
import {stagingInputCapabilities} from '../src/services/stagingInputCapabilities';
it('requires exact isolated site, production context and each explicit flag',()=>{
 const context={site:{id:'b64bf33c-a131-4ae2-b2b0-9aec16e9f77b'},deploy:{context:'production'}};
 expect(stagingInputCapabilities(context,{})).toEqual({providerEstimates:false,facilityBudget:false});
 expect(stagingInputCapabilities(context,{OI_FACILITY_BUDGET_ENABLED:'true'})).toEqual({providerEstimates:false,facilityBudget:true});
 expect(stagingInputCapabilities(context,{OI_PROVIDER_ESTIMATES_ENABLED:'true'})).toEqual({providerEstimates:true,facilityBudget:false});
 for(const c of [undefined,{...context,site:{id:'other'}},{...context,deploy:{context:'deploy-preview'}}])expect(stagingInputCapabilities(c,{OI_PROVIDER_ESTIMATES_ENABLED:'true',OI_FACILITY_BUDGET_ENABLED:'true'})).toEqual({providerEstimates:false,facilityBudget:false});
 expect(stagingInputCapabilities(context,{OI_PROVIDER_ESTIMATES_ENABLED:'TRUE',OI_FACILITY_BUDGET_ENABLED:'1'})).toEqual({providerEstimates:false,facilityBudget:false});
});
