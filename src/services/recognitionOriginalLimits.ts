import {stabilityTrialId} from './recognitionStabilityBudget';
export const MAX_RECOGNITION_ORIGINAL_BYTES=12*1024*1024;
export const MAX_RECOGNITION_SET_BYTES=40*1024*1024;
export function originalInputsEnabled(){try{return Boolean(stabilityTrialId());}catch{return false;}}
