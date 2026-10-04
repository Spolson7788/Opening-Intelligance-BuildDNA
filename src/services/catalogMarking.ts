// Match only literal catalog characters, allowing printed spacing/separators.
// Boundaries include '?' so an incomplete token never matches an exact model.
export function catalogTranscription(text:string,value:string):string|null{
 const characters=value.toUpperCase().replace(/[\s_-]/g,'');
 if(!characters)return null;
 const escaped=[...characters].map(c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[\\s_-]*');
 return text.toUpperCase().match(new RegExp('(?:^|[^A-Z0-9?])('+escaped+')(?![A-Z0-9?])'))?.[1]||null;
}
