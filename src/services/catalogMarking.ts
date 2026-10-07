// Match only literal catalog characters, allowing printed spacing/separators.
// Boundaries include '?' so an incomplete token never matches an exact model.
export function catalogTranscription(text:string,value:string):string|null{
 const characters=value.toUpperCase().replace(/[\s_-]/g,'');
 if(!characters||characters.length<2)return null;
 const escaped=[...characters].map(c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[\\s_-]*');
 return text.toUpperCase().replace(/\bMODEL(?=[A-Z0-9])/g,'MODEL ').match(new RegExp('(?:^|[^A-Z0-9?_-])('+escaped+')(?![A-Z0-9?_-])'))?.[1]||null;
}

// A literal family phrase may be embedded in a UL label. Compatibility text
// and incomplete tokens never establish the installed device's series.
export function literalSeriesMarking(text:string,series:string):boolean {
 if(/\b(fits?|compatible|replacement|replaces?|equivalent|cross[ -]?reference|similar|accessory|trim)\b/i.test(text))return false;
 const token=[...series.toUpperCase()].map(c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[\\s_-]*');
 return Boolean(token)&&new RegExp('(?:^|[^A-Z0-9?_-])(?:'+token+'\\s*SERIES|SERIES\\s*'+token+')(?![A-Z0-9?_-])','i').test(text);
}
