import {stabilityTrialId} from './recognitionStabilityBudget';
export const MAX_RECOGNITION_ORIGINAL_BYTES=12*1024*1024;
export const MAX_RECOGNITION_SET_BYTES=40*1024*1024;
export const MAX_RECOGNITION_ORIGINAL_PIXELS=64_000_000;
export const MAX_RECOGNITION_SET_PIXELS=160_000_000;
export function originalInputsEnabled(){try{return Boolean(stabilityTrialId());}catch{return false;}}
export function recognitionInputPixelLimit(){return originalInputsEnabled()?MAX_RECOGNITION_ORIGINAL_PIXELS:16_000_000;}
